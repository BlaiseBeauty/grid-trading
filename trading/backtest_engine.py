"""
GRID Backtest Engine
Replays historical data, matches strategy templates against signals,
records trades with full metrics.

Usage:
  python backtest_engine.py --run-id 1
  python backtest_engine.py --run-id 1 --progress-ws ws://localhost:3100/ws
"""

import os
import sys
import json
import time
import argparse
import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone, timedelta
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from backtest_signals import (
    load_ohlcv, precompute_indicators,
    compute_signals_at_bar, compute_regime_at_bar
)


# ──────────────────────────────────────
# Database helpers
# ──────────────────────────────────────

def get_db():
    return psycopg2.connect(os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid'))


def load_templates(conn):
    """Load active strategy templates from DB."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT id, name, entry_conditions, exit_conditions, valid_regimes
        FROM strategy_templates
        WHERE status = 'active'
    """)
    templates = cur.fetchall()
    cur.close()
    return templates


def load_run(conn, run_id):
    """Load backtest run configuration."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("SELECT * FROM backtest_runs WHERE id = %s", (run_id,))
    run = cur.fetchone()
    cur.close()
    return run


def update_run_status(conn, run_id, status, error_text=None):
    """Update run status."""
    cur = conn.cursor()
    if status == 'complete':
        cur.execute(
            "UPDATE backtest_runs SET status = %s, completed_at = NOW() WHERE id = %s",
            (status, run_id))
    elif status == 'failed':
        cur.execute(
            "UPDATE backtest_runs SET status = %s, error_text = %s, completed_at = NOW() WHERE id = %s",
            (status, error_text, run_id))
    else:
        cur.execute("UPDATE backtest_runs SET status = %s WHERE id = %s", (status, run_id))
    conn.commit()
    cur.close()


def update_run_stats(conn, run_id, stats):
    """Update run with computed statistics."""
    cur = conn.cursor()
    cur.execute("""
        UPDATE backtest_runs
        SET total_trades = %s, win_rate = %s, total_return = %s,
            sharpe_ratio = %s, max_drawdown = %s, status = 'complete',
            completed_at = NOW()
        WHERE id = %s
    """, (
        stats['total_trades'], stats['win_rate'], stats['total_return'],
        stats['sharpe_ratio'], stats['max_drawdown'], run_id
    ))
    conn.commit()
    cur.close()


def insert_trade(conn, trade):
    """Insert a closed backtest trade."""
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO backtest_trades
        (run_id, symbol, side, template_id, template_name, regime, confidence,
         entry_price, exit_price, entry_time, exit_time, pnl_pct, pnl_usd,
         position_size_pct, close_reason, signals_matched, is_in_sample, fees_paid)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    """, (
        trade['run_id'], trade['symbol'], trade['side'],
        trade['template_id'], trade['template_name'], trade['regime'],
        trade['confidence'], trade['entry_price'], trade['exit_price'],
        trade['entry_time'], trade['exit_time'],
        trade['pnl_pct'], trade['pnl_usd'], trade['position_size_pct'],
        trade['close_reason'], json.dumps(trade['signals_matched']),
        trade['is_in_sample'], trade['fees_paid']
    ))
    conn.commit()
    cur.close()


# ──────────────────────────────────────
# Template matching
# ──────────────────────────────────────

def match_template_against_signals(template, signals, regime, ind, i):
    """Check if a template's conditions are met by current signals and indicators.
    Returns (matched, confidence, matched_signals) or (False, 0, [])."""

    # Check valid regimes
    valid_regimes = template.get('valid_regimes') or []
    if valid_regimes and regime not in valid_regimes:
        return False, 0, []

    entry = template.get('entry_conditions', {})
    conditions = entry.get('conditions', [])
    if not conditions:
        return False, 0, []

    c = ind.iloc[i]
    matched_conditions = 0
    matched_signal_types = []

    for cond in conditions:
        indicator = cond.get('indicator', '')
        operator = cond.get('operator', '')
        value = cond.get('value')
        signal_category = cond.get('signal_category', '')
        signal_type = cond.get('signal_type', '')
        min_strength = cond.get('min_strength', 0)

        # Match against computed indicator values
        if indicator and operator and value is not None:
            actual = None
            indicator_lower = indicator.lower()

            # Map template indicator names to our precomputed values
            if indicator_lower == 'rsi_14' or indicator_lower == 'rsi14':
                actual = c.get('rsi14')
            elif indicator_lower == 'adx' or indicator_lower == 'adx14':
                actual = c.get('adx14')
            elif indicator_lower == 'volume_ratio':
                vol = c.get('volume', 0)
                avg = c.get('vol_avg20', 1)
                actual = vol / avg if avg and avg > 0 else 0
            elif indicator_lower == 'bb_pct' or indicator_lower == 'bb_bandwidth':
                actual = c.get('bb_width')
                if actual is not None:
                    actual = actual / 100  # normalize to 0-1 range
            elif indicator_lower == 'macd_histogram':
                actual = c.get('macd_hist')
            elif indicator_lower == 'stoch_k':
                # Approximate stochastic from RSI range
                actual = c.get('rsi14')

            if actual is not None and not pd.isna(actual):
                try:
                    value = float(value)
                    actual = float(actual)
                    if operator == '<' and actual < value:
                        matched_conditions += 1
                        matched_signal_types.append(indicator)
                    elif operator == '>' and actual > value:
                        matched_conditions += 1
                        matched_signal_types.append(indicator)
                    elif operator == '<=' and actual <= value:
                        matched_conditions += 1
                        matched_signal_types.append(indicator)
                    elif operator == '>=' and actual >= value:
                        matched_conditions += 1
                        matched_signal_types.append(indicator)
                except (ValueError, TypeError):
                    pass

        # Match against computed signals by category/type
        if signal_category:
            for sig in signals:
                if sig['signal_category'] == signal_category:
                    if min_strength and sig['strength'] < min_strength:
                        continue
                    matched_conditions += 1
                    matched_signal_types.append(sig['signal_type'])
                    break

        if signal_type:
            for sig in signals:
                if sig['signal_type'] == signal_type:
                    matched_conditions += 1
                    matched_signal_types.append(signal_type)
                    break

    # Check required minimum
    required_signals = entry.get('required_signals', [])
    min_required = len(required_signals) if required_signals else max(1, len(conditions) // 2)

    if matched_conditions < min_required:
        return False, 0, []

    # Compute confidence
    confidence = (matched_conditions / max(len(conditions), 1)) * 100
    return True, round(confidence, 2), matched_signal_types


def determine_side(template, signals, regime):
    """Determine trade direction based on template and signals."""
    name_lower = template['name'].lower()

    # Template name hints
    if 'bearish' in name_lower or 'short' in name_lower:
        return 'short'
    if 'bullish' in name_lower or 'long' in name_lower or 'bounce' in name_lower or 'breakout' in name_lower:
        return 'long'

    # Regime hints
    if regime == 'trending_up':
        return 'long'
    if regime == 'trending_down':
        return 'short'

    # Signal consensus
    bullish = sum(1 for s in signals if s['direction'] == 'bullish')
    bearish = sum(1 for s in signals if s['direction'] == 'bearish')
    return 'long' if bullish >= bearish else 'short'


# ──────────────────────────────────────
# Backtest Engine
# ──────────────────────────────────────

class BacktestEngine:
    FEE_BPS = 10  # 10 basis points per side

    def __init__(self, run_id, config):
        self.run_id = run_id
        self.config = config
        self.symbols = config['symbols']
        self.timeframe = config['timeframe']
        self.date_from = config['date_from']
        self.date_to = config['date_to']
        self.in_sample_cutoff = config.get('in_sample_cutoff')
        self.initial_capital = config.get('initial_capital', 10000)

        self.conn = get_db()
        self.templates = load_templates(self.conn)

        # Portfolio state
        self.equity = self.initial_capital
        self.peak_equity = self.initial_capital
        self.max_drawdown = 0.0
        self.open_positions = {}  # symbol -> position dict
        self.closed_trades = []
        self.equity_curve = []  # (timestamp, equity)
        self.hourly_returns = []

        # Pre-load and pre-compute data for all symbols
        self.data = {}
        self.indicators = {}
        for symbol in self.symbols:
            print(f'[ENGINE] Loading {symbol} {self.timeframe}...')
            df = load_ohlcv(symbol, self.timeframe)
            if df.empty:
                print(f'[ENGINE] WARNING: No data for {symbol}')
                continue

            # Filter to date range
            if self.date_from:
                df = df[df['timestamp'] >= self.date_from]
            if self.date_to:
                df = df[df['timestamp'] <= self.date_to]
            df = df.reset_index(drop=True)

            self.data[symbol] = df
            print(f'[ENGINE] Pre-computing indicators for {symbol} ({len(df)} bars)...')
            self.indicators[symbol] = precompute_indicators(df)

        print(f'[ENGINE] Loaded {len(self.templates)} active templates')
        print(f'[ENGINE] Data loaded for {list(self.data.keys())}')

    def run(self):
        """Main backtest loop."""
        update_run_status(self.conn, self.run_id, 'running')

        try:
            # Build unified timeline from all symbols
            all_timestamps = set()
            for symbol, df in self.data.items():
                all_timestamps.update(df['timestamp'].tolist())
            timeline = sorted(all_timestamps)

            if not timeline:
                raise ValueError('No data in date range')

            total_bars = len(timeline)
            print(f'[ENGINE] Running backtest over {total_bars} timestamps...')

            for bar_idx, ts in enumerate(timeline):
                self._process_bar(ts)

                # Progress reporting
                if (bar_idx + 1) % 500 == 0 or bar_idx == total_bars - 1:
                    pct = (bar_idx + 1) / total_bars * 100
                    print(f'[ENGINE] Progress: {pct:.0f}% ({bar_idx+1}/{total_bars}) | '
                          f'Equity: ${self.equity:.2f} | Open: {len(self.open_positions)} | '
                          f'Closed: {len(self.closed_trades)}', end='\r')

                    # Write progress file for WebSocket relay
                    self._write_progress(bar_idx + 1, total_bars, ts)

            # Close any remaining open positions at end of data
            self._close_all_positions(timeline[-1], 'end_of_data')

            # Compute and store statistics
            print(f'\n[ENGINE] Computing statistics...')
            stats = self._compute_stats()
            update_run_stats(self.conn, self.run_id, stats)

            # Store all closed trades
            print(f'[ENGINE] Storing {len(self.closed_trades)} trades...')
            for trade in self.closed_trades:
                insert_trade(self.conn, trade)

            self._print_summary(stats)
            return stats

        except Exception as e:
            update_run_status(self.conn, self.run_id, 'failed', str(e))
            print(f'\n[ENGINE] FAILED: {e}')
            import traceback
            traceback.print_exc()
            raise

    def _process_bar(self, ts):
        """Process a single timestamp across all symbols."""

        # 1. Check open positions first (stop loss, take profit, time stop)
        self._check_open_positions(ts)

        # 2. For each symbol, compute signals and try to match templates
        for symbol in self.symbols:
            if symbol not in self.data:
                continue

            df = self.data[symbol]
            ind = self.indicators[symbol]

            # Find the bar index for this timestamp
            mask = df['timestamp'] == ts
            if not mask.any():
                continue
            i = mask.idxmax()

            # Compute signals at this bar
            signals = compute_signals_at_bar(ind, i, symbol, self.timeframe, ts)
            if not signals:
                continue

            # Compute regime
            regime, regime_conf = compute_regime_at_bar(ind, i)

            # Skip if already have position in this symbol
            if symbol in self.open_positions:
                continue

            # Try each template
            for template in self.templates:
                matched, confidence, matched_sigs = match_template_against_signals(
                    template, signals, regime, ind, i)

                if not matched or confidence < 55:
                    continue

                # Apply risk rules
                if not self._passes_risk_check(symbol, confidence):
                    continue

                # Open position
                entry_price = float(df.iloc[i]['close'])
                side = determine_side(template, signals, regime)

                self._open_position(
                    symbol=symbol,
                    side=side,
                    template=template,
                    regime=regime,
                    confidence=confidence,
                    entry_price=entry_price,
                    entry_time=ts,
                    signals_matched=matched_sigs,
                )
                break  # Only one entry per symbol per bar

        # Record equity
        self.equity_curve.append((ts, self.equity))

    def _passes_risk_check(self, symbol, confidence):
        """Deterministic risk checks."""
        drawdown = (self.peak_equity - self.equity) / self.peak_equity * 100 if self.peak_equity > 0 else 0

        # Hard stop at 25% drawdown
        if drawdown > 25:
            return False

        # Max 30% in correlated assets (BTC/ETH/SOL are all correlated)
        correlated_symbols = {'BTC/USDT', 'ETH/USDT', 'SOL/USDT'}
        correlated_exposure = sum(
            pos['position_size_pct'] for sym, pos in self.open_positions.items()
            if sym in correlated_symbols
        )
        position_size = confidence / 100 * 5  # confidence% of 5%
        if symbol in correlated_symbols and correlated_exposure + position_size > 30:
            return False

        return True

    def _open_position(self, symbol, side, template, regime, confidence,
                       entry_price, entry_time, signals_matched):
        """Open a new position."""
        # Position size: confidence% of 5% of portfolio
        position_size_pct = confidence / 100 * 5

        # Reduce size by 50% when in drawdown > 15%
        drawdown = (self.peak_equity - self.equity) / self.peak_equity * 100 if self.peak_equity > 0 else 0
        if drawdown > 15:
            position_size_pct *= 0.5

        position_usd = self.equity * position_size_pct / 100

        # Apply entry fee
        fee = position_usd * self.FEE_BPS / 10000
        self.equity -= fee

        # Get SL/TP from template exit conditions
        exit_cond = template.get('exit_conditions', {})
        sl_pct = exit_cond.get('stop_loss_pct', 2.0)
        tp_pct = exit_cond.get('take_profit_pct', 4.0)
        time_stop_hours = exit_cond.get('time_stop_hours', 96)

        if side == 'long':
            sl_price = entry_price * (1 - sl_pct / 100)
            tp_price = entry_price * (1 + tp_pct / 100)
        else:
            sl_price = entry_price * (1 + sl_pct / 100)
            tp_price = entry_price * (1 - tp_pct / 100)

        self.open_positions[symbol] = {
            'symbol': symbol,
            'side': side,
            'template_id': template['id'],
            'template_name': template['name'],
            'regime': regime,
            'confidence': confidence,
            'entry_price': entry_price,
            'entry_time': entry_time,
            'position_size_pct': position_size_pct,
            'position_usd': position_usd,
            'sl_price': sl_price,
            'tp_price': tp_price,
            'time_stop_hours': time_stop_hours,
            'signals_matched': signals_matched,
            'entry_fee': fee,
        }

    def _check_open_positions(self, ts):
        """Check SL/TP/time stop on open positions."""
        to_close = []

        for symbol, pos in list(self.open_positions.items()):
            if symbol not in self.data:
                continue

            df = self.data[symbol]
            mask = df['timestamp'] == ts
            if not mask.any():
                continue
            i = mask.idxmax()
            bar = df.iloc[i]

            high = float(bar['high'])
            low = float(bar['low'])
            close = float(bar['close'])

            close_reason = None
            exit_price = None

            if pos['side'] == 'long':
                if low <= pos['sl_price']:
                    close_reason = 'stop_loss'
                    exit_price = pos['sl_price']
                elif high >= pos['tp_price']:
                    close_reason = 'take_profit'
                    exit_price = pos['tp_price']
            else:  # short
                if high >= pos['sl_price']:
                    close_reason = 'stop_loss'
                    exit_price = pos['sl_price']
                elif low <= pos['tp_price']:
                    close_reason = 'take_profit'
                    exit_price = pos['tp_price']

            # Time stop
            if close_reason is None and pos.get('time_stop_hours'):
                entry_time = pos['entry_time']
                if hasattr(entry_time, 'timestamp'):
                    elapsed_hours = (ts - entry_time).total_seconds() / 3600
                else:
                    elapsed_hours = 0
                if elapsed_hours > pos['time_stop_hours']:
                    close_reason = 'time_stop'
                    exit_price = close

            if close_reason:
                to_close.append((symbol, exit_price, ts, close_reason))

        for symbol, exit_price, exit_time, reason in to_close:
            self._close_position(symbol, exit_price, exit_time, reason)

    def _close_position(self, symbol, exit_price, exit_time, close_reason):
        """Close a position and record the trade."""
        pos = self.open_positions.pop(symbol, None)
        if not pos:
            return

        # Exit fee
        exit_fee = pos['position_usd'] * self.FEE_BPS / 10000
        total_fees = pos['entry_fee'] + exit_fee

        # PnL calculation
        if pos['side'] == 'long':
            pnl_pct = (exit_price - pos['entry_price']) / pos['entry_price'] * 100
        else:
            pnl_pct = (pos['entry_price'] - exit_price) / pos['entry_price'] * 100

        pnl_usd = pos['position_usd'] * pnl_pct / 100 - total_fees

        # Update equity
        self.equity += pnl_usd - exit_fee  # entry fee already deducted
        if self.equity > self.peak_equity:
            self.peak_equity = self.equity

        # Track drawdown
        current_dd = (self.peak_equity - self.equity) / self.peak_equity * 100 if self.peak_equity > 0 else 0
        if current_dd > self.max_drawdown:
            self.max_drawdown = current_dd

        # Track returns for Sharpe
        self.hourly_returns.append(pnl_pct)

        # Is in-sample?
        is_in_sample = True
        if self.in_sample_cutoff:
            try:
                entry_dt = pd.Timestamp(pos['entry_time'])
                cutoff_dt = pd.Timestamp(self.in_sample_cutoff)
                is_in_sample = entry_dt < cutoff_dt
            except Exception:
                is_in_sample = str(pos['entry_time'])[:10] < str(self.in_sample_cutoff)[:10]

        trade = {
            'run_id': self.run_id,
            'symbol': symbol,
            'side': pos['side'],
            'template_id': pos['template_id'],
            'template_name': pos['template_name'],
            'regime': pos['regime'],
            'confidence': pos['confidence'],
            'entry_price': pos['entry_price'],
            'exit_price': exit_price,
            'entry_time': pos['entry_time'],
            'exit_time': exit_time,
            'pnl_pct': round(pnl_pct, 4),
            'pnl_usd': round(pnl_usd, 4),
            'position_size_pct': pos['position_size_pct'],
            'close_reason': close_reason,
            'signals_matched': pos['signals_matched'],
            'is_in_sample': is_in_sample,
            'fees_paid': round(total_fees, 4),
        }
        self.closed_trades.append(trade)

    def _close_all_positions(self, ts, reason):
        """Close all remaining open positions."""
        for symbol in list(self.open_positions.keys()):
            if symbol in self.data:
                df = self.data[symbol]
                mask = df['timestamp'] == ts
                if mask.any():
                    i = mask.idxmax()
                    exit_price = float(df.iloc[i]['close'])
                    self._close_position(symbol, exit_price, ts, reason)

    def _compute_stats(self):
        """Compute final run statistics."""
        trades = self.closed_trades
        total = len(trades)

        if total == 0:
            return {
                'total_trades': 0, 'win_rate': 0, 'total_return': 0,
                'sharpe_ratio': 0, 'max_drawdown': 0,
            }

        wins = sum(1 for t in trades if t['pnl_pct'] > 0)
        win_rate = wins / total * 100

        total_return = (self.equity - self.initial_capital) / self.initial_capital * 100

        # Sharpe ratio (annualized)
        if self.hourly_returns:
            returns = np.array(self.hourly_returns)
            if returns.std() > 0:
                # Annualize based on timeframe
                if self.timeframe == '1h':
                    periods_per_year = 8760
                elif self.timeframe == '4h':
                    periods_per_year = 2190
                else:
                    periods_per_year = 365

                sharpe = (returns.mean() / returns.std()) * np.sqrt(periods_per_year)
            else:
                sharpe = 0
        else:
            sharpe = 0

        return {
            'total_trades': total,
            'win_rate': round(win_rate, 2),
            'total_return': round(total_return, 4),
            'sharpe_ratio': round(float(sharpe), 4),
            'max_drawdown': round(self.max_drawdown, 4),
        }

    def _write_progress(self, current, total, current_date):
        """Write progress to a temp file for WebSocket relay."""
        progress = {
            'run_id': self.run_id,
            'progress_pct': round(current / total * 100, 1),
            'trades_so_far': len(self.closed_trades),
            'current_date': str(current_date),
            'equity': round(self.equity, 2),
            'open_positions': len(self.open_positions),
        }
        try:
            progress_file = f'/tmp/backtest_progress_{self.run_id}.json'
            with open(progress_file, 'w') as f:
                json.dump(progress, f)
        except Exception:
            pass

    def _print_summary(self, stats):
        """Print backtest results summary."""
        trades = self.closed_trades

        print(f'\n')
        print(f'═══════════════════════════════════════════════')
        print(f'  BACKTEST COMPLETE — Run #{self.run_id}')
        print(f'═══════════════════════════════════════════════')
        print(f'  Total Trades:   {stats["total_trades"]}')
        print(f'  Win Rate:       {stats["win_rate"]:.1f}%')
        print(f'  Total Return:   {stats["total_return"]:.2f}%')
        print(f'  Sharpe Ratio:   {stats["sharpe_ratio"]:.4f}')
        print(f'  Max Drawdown:   {stats["max_drawdown"]:.2f}%')
        print(f'  Final Equity:   ${self.equity:.2f} (from ${self.initial_capital})')
        print()

        # Breakdown by regime
        regime_stats = {}
        for t in trades:
            r = t['regime']
            if r not in regime_stats:
                regime_stats[r] = {'count': 0, 'wins': 0, 'total_pnl': 0}
            regime_stats[r]['count'] += 1
            if t['pnl_pct'] > 0:
                regime_stats[r]['wins'] += 1
            regime_stats[r]['total_pnl'] += t['pnl_pct']

        print(f'  BY REGIME:')
        print(f'  {"Regime":<20} {"Trades":<8} {"Win Rate":<10} {"Avg PnL":<10}')
        print(f'  {"─"*20} {"─"*8} {"─"*10} {"─"*10}')
        for r in sorted(regime_stats.keys()):
            s = regime_stats[r]
            wr = s['wins'] / s['count'] * 100 if s['count'] > 0 else 0
            avg = s['total_pnl'] / s['count'] if s['count'] > 0 else 0
            print(f'  {r:<20} {s["count"]:<8} {wr:.1f}%     {avg:+.2f}%')

        # Breakdown by template
        template_stats = {}
        for t in trades:
            tn = t['template_name']
            if tn not in template_stats:
                template_stats[tn] = {'count': 0, 'wins': 0, 'total_pnl': 0}
            template_stats[tn]['count'] += 1
            if t['pnl_pct'] > 0:
                template_stats[tn]['wins'] += 1
            template_stats[tn]['total_pnl'] += t['pnl_pct']

        print(f'\n  BY TEMPLATE:')
        print(f'  {"Template":<30} {"Trades":<8} {"Win Rate":<10} {"Avg PnL":<10}')
        print(f'  {"─"*30} {"─"*8} {"─"*10} {"─"*10}')
        for tn in sorted(template_stats.keys(), key=lambda x: template_stats[x]['total_pnl'], reverse=True):
            s = template_stats[tn]
            wr = s['wins'] / s['count'] * 100 if s['count'] > 0 else 0
            avg = s['total_pnl'] / s['count'] if s['count'] > 0 else 0
            print(f'  {tn[:29]:<30} {s["count"]:<8} {wr:.1f}%     {avg:+.2f}%')

        # In-sample vs Out-of-sample
        if self.in_sample_cutoff:
            is_trades = [t for t in trades if t['is_in_sample']]
            oos_trades = [t for t in trades if not t['is_in_sample']]
            print(f'\n  IN-SAMPLE vs OUT-OF-SAMPLE:')
            for label, group in [('In-Sample', is_trades), ('Out-of-Sample', oos_trades)]:
                if group:
                    wr = sum(1 for t in group if t['pnl_pct'] > 0) / len(group) * 100
                    avg = sum(t['pnl_pct'] for t in group) / len(group)
                    print(f'  {label:<20} {len(group)} trades, {wr:.1f}% win rate, {avg:+.2f}% avg')
                else:
                    print(f'  {label:<20} 0 trades')

        # By close reason
        reason_counts = {}
        for t in trades:
            r = t['close_reason']
            reason_counts[r] = reason_counts.get(r, 0) + 1
        print(f'\n  BY CLOSE REASON:')
        for r, c in sorted(reason_counts.items(), key=lambda x: x[1], reverse=True):
            print(f'  {r:<20} {c}')

        print(f'\n═══════════════════════════════════════════════')


def get_equity_curve(conn, run_id):
    """Get equity curve data for a completed run (reconstructed from trades)."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Get run config
    cur.execute("SELECT * FROM backtest_runs WHERE id = %s", (run_id,))
    run = cur.fetchone()
    if not run:
        return []

    # Get all trades ordered by exit time
    cur.execute("""
        SELECT entry_time, exit_time, pnl_usd, is_in_sample
        FROM backtest_trades
        WHERE run_id = %s
        ORDER BY exit_time ASC
    """, (run_id,))
    trades = cur.fetchall()
    cur.close()

    initial_capital = 10000
    equity = initial_capital
    curve = [{'timestamp': str(run['date_from']), 'equity': equity, 'is_in_sample': True}]

    for t in trades:
        equity += float(t['pnl_usd'])
        curve.append({
            'timestamp': str(t['exit_time']),
            'equity': round(equity, 2),
            'is_in_sample': t['is_in_sample'],
        })

    return curve


# ──────────────────────────────────────
# CLI entry point
# ──────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='GRID Backtest Engine')
    parser.add_argument('--run-id', type=int, required=True, help='Backtest run ID')
    args = parser.parse_args()

    conn = get_db()
    run = load_run(conn, args.run_id)
    conn.close()

    if not run:
        print(f'[ENGINE] Run #{args.run_id} not found')
        sys.exit(1)

    if run['status'] not in ('pending', 'failed'):
        print(f'[ENGINE] Run #{args.run_id} has status "{run["status"]}" — skipping')
        sys.exit(0)

    config = {
        'symbols': run['symbols'],
        'timeframe': run['timeframe'],
        'date_from': run['date_from'],
        'date_to': run['date_to'],
        'in_sample_cutoff': run.get('in_sample_cutoff'),
        'initial_capital': 10000,
    }

    engine = BacktestEngine(args.run_id, config)
    engine.run()


if __name__ == '__main__':
    main()
