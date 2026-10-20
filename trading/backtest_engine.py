"""
GRID Backtest Engine
Replays historical data, matches strategy templates against signals,
records trades with full metrics.

Accounting conventions (all fees/slippage applied exactly once):
  * Entry fills at signal-bar close with adverse slippage (default 5 bps).
  * Entry fee is deducted from equity when the position opens.
  * Exit fee is deducted when it closes; stored pnl_usd = gross - entry_fee - exit_fee,
    so  sum(pnl_usd) == final_equity - initial_capital.
  * Stops fill at the worse of the stop level and the bar open (gap), plus slippage;
    take-profits fill at the level (or the open if the bar gapped through it).
  * Equity is marked to market on every bar: max drawdown and Sharpe come from the
    per-bar equity curve (annualised with the bars-per-year of the timeframe).
  * No parameters are fitted by this engine (templates come from the DB and
    indicators are causal), so in_sample_cutoff cannot leak into "training".
    Instead the run reports in-sample vs out-of-sample metrics separately.

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
# Pure helpers (unit-testable, no DB)
# ──────────────────────────────────────

_TF_MINUTES = {'m': 1, 'h': 60, 'd': 1440, 'w': 10080}


def timeframe_minutes(timeframe):
    try:
        return int(timeframe[:-1]) * _TF_MINUTES[timeframe[-1]]
    except (KeyError, ValueError, IndexError):
        raise ValueError(f'Unsupported timeframe: {timeframe!r}')


def bars_per_year(timeframe):
    """Crypto trades 24/7: 365 days of bars (4h -> 2190, 1h -> 8760, 1d -> 365)."""
    return 365 * 24 * 60 / timeframe_minutes(timeframe)


def max_drawdown_pct(equity_values):
    """Max peak-to-trough drawdown (%) of an equity series (per bar)."""
    eq = np.asarray(list(equity_values), dtype=float)
    if eq.size == 0:
        return 0.0
    peaks = np.maximum.accumulate(eq)
    with np.errstate(divide='ignore', invalid='ignore'):
        dd = np.where(peaks > 0, (peaks - eq) / peaks * 100, 0.0)
    return float(dd.max())


def sharpe_from_equity(equity_values, periods_per_year):
    """Annualised Sharpe (rf=0) from per-bar equity returns."""
    eq = np.asarray(list(equity_values), dtype=float)
    if eq.size < 3:
        return 0.0
    prev = eq[:-1]
    with np.errstate(divide='ignore', invalid='ignore'):
        rets = np.where(prev > 0, np.diff(eq) / prev, 0.0)
    sd = rets.std(ddof=1)
    if not np.isfinite(sd) or sd <= 0:
        return 0.0
    return float(rets.mean() / sd * np.sqrt(periods_per_year))


def apply_slippage(side, price, bps, is_entry):
    """Adverse slippage. long entry / short exit buy higher; long exit / short entry sell lower."""
    f = bps / 10000.0
    buying = (side == 'long') == is_entry
    return price * (1 + f) if buying else price * (1 - f)


def stop_fill_price(side, level, bar_open, slippage_bps):
    """Stop-loss fill: worse of the stop level and the bar open (gap), then slippage."""
    base = min(level, bar_open) if side == 'long' else max(level, bar_open)
    return apply_slippage(side, base, slippage_bps, is_entry=False)


def target_fill_price(side, level, bar_open):
    """Take-profit limit fill: at the level, or the open if the bar gapped through it."""
    return max(level, bar_open) if side == 'long' else min(level, bar_open)


def _to_utc(ts):
    t = pd.Timestamp(ts)
    return t.tz_localize('UTC') if t.tzinfo is None else t.tz_convert('UTC')


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
            elif indicator_lower == 'bb_pct':
                actual = c.get('bb_pct')            # %B, same definition as live indicators.py
            elif indicator_lower == 'bb_bandwidth':
                actual = c.get('bb_bandwidth')      # (upper-lower)/mid ratio, same as live
            elif indicator_lower == 'macd_histogram':
                actual = c.get('macd_hist')
            elif indicator_lower == 'stoch_k':
                actual = c.get('stoch_k')           # real %K(14), same as live
            elif indicator_lower == 'stoch_d':
                actual = c.get('stoch_d')

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
                except (ValueError, TypeError) as e:
                    print(f'[ENGINE] Template {template.get("name")}: bad condition on {indicator!r} '
                          f'(value={value!r}, actual={actual!r}): {e}')

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
    SLIPPAGE_BPS = 5  # default adverse slippage per side (configurable via config['slippage_bps'])

    def __init__(self, run_id, config):
        self.run_id = run_id
        self.config = config
        self.symbols = config['symbols']
        self.timeframe = config['timeframe']
        self.date_from = config['date_from']
        self.date_to = config['date_to']
        self.in_sample_cutoff = config.get('in_sample_cutoff')
        self.initial_capital = config.get('initial_capital', 10000)
        self.slippage_bps = float(config.get('slippage_bps', self.SLIPPAGE_BPS))
        self.fee_bps = float(config.get('fee_bps', self.FEE_BPS))
        self.periods_per_year = bars_per_year(self.timeframe)

        self.conn = get_db()
        self.templates = load_templates(self.conn)

        # Portfolio state
        self.equity = self.initial_capital          # realised cash equity (entry fees already paid)
        self.mtm_equity = self.initial_capital      # realised + unrealised, updated every bar
        self.peak_mtm = self.initial_capital
        self.max_drawdown = 0.0                     # per-bar, mark-to-market
        self.open_positions = {}  # symbol -> position dict
        self.closed_trades = []
        self.equity_curve = []  # (timestamp, mtm equity) one point per bar

        # Pre-load and pre-compute data for all symbols
        self.data = {}
        self.indicators = {}
        self.bar_index = {}   # symbol -> {timestamp: row index}  (O(1) lookups)
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
            self.bar_index[symbol] = {ts: i for i, ts in enumerate(df['timestamp'].tolist())}
            print(f'[ENGINE] Pre-computing indicators for {symbol} ({len(df)} bars)...')
            self.indicators[symbol] = precompute_indicators(df)

        print(f'[ENGINE] Loaded {len(self.templates)} active templates')
        print(f'[ENGINE] Data loaded for {list(self.data.keys())}')
        print(f'[ENGINE] Costs: fee {self.fee_bps} bps/side, slippage {self.slippage_bps} bps/side')

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
                          f'Equity: ${self.mtm_equity:.2f} | Open: {len(self.open_positions)} | '
                          f'Closed: {len(self.closed_trades)}', end='\r')

                    # Write progress file for WebSocket relay
                    self._write_progress(bar_idx + 1, total_bars, ts)

            # Close any remaining open positions at end of data
            self._close_all_positions(timeline[-1], 'end_of_data')
            self._record_equity(timeline[-1], replace_last=True)

            # Compute and store statistics
            print(f'\n[ENGINE] Computing statistics...')
            stats = self._compute_stats()
            update_run_stats(self.conn, self.run_id, stats)

            # Store all closed trades
            print(f'[ENGINE] Storing {len(self.closed_trades)} trades...')
            for trade in self.closed_trades:
                insert_trade(self.conn, trade)

            self._print_summary(stats)
            self._write_oos_report(stats)
            return stats

        except Exception as e:
            update_run_status(self.conn, self.run_id, 'failed', str(e))
            print(f'\n[ENGINE] FAILED: {e}')
            import traceback
            traceback.print_exc()
            raise

    # ── bar loop ─────────────────────────────────────────────────────────────

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
            i = self.bar_index[symbol].get(ts)
            if i is None:
                continue

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

                # Open position (signal at bar close -> fill at close +/- slippage)
                signal_price = float(df.iloc[i]['close'])
                side = determine_side(template, signals, regime)

                self._open_position(
                    symbol=symbol,
                    side=side,
                    template=template,
                    regime=regime,
                    confidence=confidence,
                    signal_price=signal_price,
                    entry_time=ts,
                    signals_matched=matched_sigs,
                )
                break  # Only one entry per symbol per bar

        # 3. Mark to market -> one equity point per bar
        self._record_equity(ts)

    def _passes_risk_check(self, symbol, confidence):
        """Deterministic risk checks (drawdown measured on mark-to-market equity)."""
        drawdown = (self.peak_mtm - self.mtm_equity) / self.peak_mtm * 100 if self.peak_mtm > 0 else 0

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
                       signal_price, entry_time, signals_matched):
        """Open a new position (entry fee deducted from equity here, once)."""
        # Position size: confidence% of 5% of portfolio
        position_size_pct = confidence / 100 * 5

        # Reduce size by 50% when in drawdown > 15%
        drawdown = (self.peak_mtm - self.mtm_equity) / self.peak_mtm * 100 if self.peak_mtm > 0 else 0
        if drawdown > 15:
            position_size_pct *= 0.5

        position_usd = self.equity * position_size_pct / 100

        entry_price = apply_slippage(side, signal_price, self.slippage_bps, is_entry=True)

        # Entry fee (once, here)
        fee = position_usd * self.fee_bps / 10000
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
            'signal_price': signal_price,
            'entry_time': entry_time,
            'position_size_pct': position_size_pct,
            'position_usd': position_usd,
            'sl_price': sl_price,
            'tp_price': tp_price,
            'time_stop_hours': time_stop_hours,
            'signals_matched': signals_matched,
            'entry_fee': fee,
            'last_price': signal_price,
        }

    def _check_open_positions(self, ts):
        """Check SL/TP/time stop on open positions."""
        to_close = []

        for symbol, pos in list(self.open_positions.items()):
            if symbol not in self.data:
                continue

            df = self.data[symbol]
            i = self.bar_index[symbol].get(ts)
            if i is None:
                continue
            bar = df.iloc[i]

            bar_open = float(bar['open'])
            high = float(bar['high'])
            low = float(bar['low'])
            close = float(bar['close'])

            close_reason = None
            exit_price = None

            # Stop is tested before the target inside a bar (conservative).
            if pos['side'] == 'long':
                if low <= pos['sl_price']:
                    close_reason = 'stop_loss'
                    exit_price = stop_fill_price('long', pos['sl_price'], bar_open, self.slippage_bps)
                elif high >= pos['tp_price']:
                    close_reason = 'take_profit'
                    exit_price = target_fill_price('long', pos['tp_price'], bar_open)
            else:  # short
                if high >= pos['sl_price']:
                    close_reason = 'stop_loss'
                    exit_price = stop_fill_price('short', pos['sl_price'], bar_open, self.slippage_bps)
                elif low <= pos['tp_price']:
                    close_reason = 'take_profit'
                    exit_price = target_fill_price('short', pos['tp_price'], bar_open)

            # Time stop
            if close_reason is None and pos.get('time_stop_hours'):
                entry_time = pos['entry_time']
                if hasattr(entry_time, 'timestamp'):
                    elapsed_hours = (ts - entry_time).total_seconds() / 3600
                else:
                    elapsed_hours = 0
                if elapsed_hours > pos['time_stop_hours']:
                    close_reason = 'time_stop'
                    exit_price = apply_slippage(pos['side'], close, self.slippage_bps, is_entry=False)

            if close_reason:
                to_close.append((symbol, exit_price, ts, close_reason))

        for symbol, exit_price, exit_time, reason in to_close:
            self._close_position(symbol, exit_price, exit_time, reason)

    def _close_position(self, symbol, exit_price, exit_time, close_reason):
        """Close a position and record the trade. `exit_price` is the actual
        fill (slippage/gap already applied)."""
        pos = self.open_positions.pop(symbol, None)
        if not pos:
            return

        # Gross move on the position
        if pos['side'] == 'long':
            move_pct = (exit_price - pos['entry_price']) / pos['entry_price']
        else:
            move_pct = (pos['entry_price'] - exit_price) / pos['entry_price']
        gross_usd = pos['position_usd'] * move_pct

        # Fees: entry fee was already deducted from equity at open; exit fee now.
        exit_notional = pos['position_usd'] * (exit_price / pos['entry_price'])
        exit_fee = exit_notional * self.fee_bps / 10000
        total_fees = pos['entry_fee'] + exit_fee
        pnl_usd = gross_usd - total_fees                # stored, net of ALL fees (once)
        pnl_pct_net = pnl_usd / pos['position_usd'] * 100 if pos['position_usd'] else 0.0

        self.equity += gross_usd - exit_fee             # entry fee already in self.equity

        # Is in-sample? (by entry time)
        is_in_sample = True
        if self.in_sample_cutoff:
            is_in_sample = _to_utc(pos['entry_time']) < _to_utc(self.in_sample_cutoff)

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
            'pnl_pct': round(pnl_pct_net, 4),           # net % of position notional
            'pnl_usd': round(pnl_usd, 4),
            'position_size_pct': pos['position_size_pct'],
            'close_reason': close_reason,
            'signals_matched': pos['signals_matched'],
            'is_in_sample': is_in_sample,
            'fees_paid': round(total_fees, 4),
        }
        self.closed_trades.append(trade)

    def _close_all_positions(self, ts, reason):
        """Close all remaining open positions at the last known price."""
        for symbol in list(self.open_positions.keys()):
            pos = self.open_positions[symbol]
            i = self.bar_index.get(symbol, {}).get(ts)
            if i is not None:
                price = float(self.data[symbol].iloc[i]['close'])
            else:
                price = pos['last_price']      # symbol had no bar at the final timestamp
            fill = apply_slippage(pos['side'], price, self.slippage_bps, is_entry=False)
            self._close_position(symbol, fill, ts, reason)

    # ── equity / statistics ──────────────────────────────────────────────────

    def _record_equity(self, ts, replace_last=False):
        """Mark open positions to market at this bar's close and record the
        equity point; drawdown is tracked on every bar."""
        unrealised = 0.0
        for symbol, pos in self.open_positions.items():
            i = self.bar_index.get(symbol, {}).get(ts)
            if i is not None:
                pos['last_price'] = float(self.data[symbol].iloc[i]['close'])
            move = (pos['last_price'] - pos['entry_price']) / pos['entry_price']
            if pos['side'] == 'short':
                move = -move
            unrealised += pos['position_usd'] * move
        self.mtm_equity = self.equity + unrealised

        if replace_last and self.equity_curve:
            self.equity_curve[-1] = (ts, self.mtm_equity)
        else:
            self.equity_curve.append((ts, self.mtm_equity))

        if self.mtm_equity > self.peak_mtm:
            self.peak_mtm = self.mtm_equity
        dd = (self.peak_mtm - self.mtm_equity) / self.peak_mtm * 100 if self.peak_mtm > 0 else 0
        if dd > self.max_drawdown:
            self.max_drawdown = dd

    def _segment_stats(self, trades, curve):
        """Stats for a subset of trades and a slice of the equity curve."""
        values = [e for _, e in curve]
        n = len(trades)
        wins = sum(1 for t in trades if t['pnl_usd'] > 0)       # win = positive NET pnl
        ret = (values[-1] / values[0] - 1) * 100 if len(values) >= 2 and values[0] > 0 else 0.0
        return {
            'total_trades': n,
            'win_rate': round(wins / n * 100, 2) if n else 0,
            'total_return': round(ret, 4),
            'sharpe_ratio': round(sharpe_from_equity(values, self.periods_per_year), 4),
            'max_drawdown': round(max_drawdown_pct(values), 4),
        }

    def _compute_stats(self):
        """Compute final run statistics (net of fees+slippage, per-bar MTM)."""
        trades = self.closed_trades
        total = len(trades)
        values = [e for _, e in self.equity_curve]

        if total == 0:
            return {
                'total_trades': 0, 'win_rate': 0, 'total_return': 0,
                'sharpe_ratio': 0, 'max_drawdown': round(self.max_drawdown, 4),
            }

        wins = sum(1 for t in trades if t['pnl_usd'] > 0)        # net pnl, not gross price move
        win_rate = wins / total * 100
        total_return = (self.equity - self.initial_capital) / self.initial_capital * 100
        sharpe = sharpe_from_equity(values, self.periods_per_year)

        stats = {
            'total_trades': total,
            'win_rate': round(win_rate, 2),
            'total_return': round(total_return, 4),
            'sharpe_ratio': round(float(sharpe), 4),
            'max_drawdown': round(self.max_drawdown, 4),
        }

        if self.in_sample_cutoff:
            cutoff = _to_utc(self.in_sample_cutoff)
            is_curve = [(t, e) for t, e in self.equity_curve if _to_utc(t) < cutoff]
            oos_curve = [(t, e) for t, e in self.equity_curve if _to_utc(t) >= cutoff]
            # OOS segment starts from the equity level at the cutoff, so its return is OOS-only
            if is_curve and oos_curve:
                oos_curve = [is_curve[-1]] + oos_curve
            stats['segments'] = {
                'in_sample': self._segment_stats([t for t in trades if t['is_in_sample']], is_curve),
                'out_of_sample': self._segment_stats([t for t in trades if not t['is_in_sample']], oos_curve),
                'cutoff': str(self.in_sample_cutoff),
            }
        return stats

    def _write_oos_report(self, stats):
        """Persist IS/OOS metrics (backtest_runs has no columns for them)."""
        if 'segments' not in stats:
            return
        path = f'/tmp/backtest_oos_{self.run_id}.json'
        try:
            with open(path, 'w') as f:
                json.dump({'run_id': self.run_id, **stats['segments']}, f)
            print(f'[ENGINE] OOS report written to {path}')
        except OSError as e:
            print(f'[ENGINE] Could not write OOS report {path}: {e}')

    def _write_progress(self, current, total, current_date):
        """Write progress to a temp file for WebSocket relay."""
        progress = {
            'run_id': self.run_id,
            'progress_pct': round(current / total * 100, 1),
            'trades_so_far': len(self.closed_trades),
            'current_date': str(current_date),
            'equity': round(self.mtm_equity, 2),
            'open_positions': len(self.open_positions),
        }
        try:
            progress_file = f'/tmp/backtest_progress_{self.run_id}.json'
            with open(progress_file, 'w') as f:
                json.dump(progress, f)
        except OSError as e:
            print(f'\n[ENGINE] Could not write progress file: {e}')

    def _print_summary(self, stats):
        """Print backtest results summary."""
        trades = self.closed_trades

        print(f'\n')
        print(f'═══════════════════════════════════════════════')
        print(f'  BACKTEST COMPLETE — Run #{self.run_id}')
        print(f'═══════════════════════════════════════════════')
        print(f'  Total Trades:   {stats["total_trades"]}')
        print(f'  Win Rate:       {stats["win_rate"]:.1f}%  (net of fees)')
        print(f'  Total Return:   {stats["total_return"]:.2f}%')
        print(f'  Sharpe Ratio:   {stats["sharpe_ratio"]:.4f}  (per-bar equity, {self.periods_per_year:.0f} bars/yr)')
        print(f'  Max Drawdown:   {stats["max_drawdown"]:.2f}%  (per-bar mark-to-market)')
        print(f'  Final Equity:   ${self.equity:.2f} (from ${self.initial_capital})')
        print(f'  Costs:          {self.fee_bps} bps fee + {self.slippage_bps} bps slippage per side')
        print()

        # Breakdown by regime
        regime_stats = {}
        for t in trades:
            r = t['regime']
            if r not in regime_stats:
                regime_stats[r] = {'count': 0, 'wins': 0, 'total_pnl': 0}
            regime_stats[r]['count'] += 1
            if t['pnl_usd'] > 0:
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
            if t['pnl_usd'] > 0:
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

        # In-sample vs Out-of-sample (separate, fully-computed metrics)
        if 'segments' in stats:
            seg = stats['segments']
            print(f'\n  IN-SAMPLE vs OUT-OF-SAMPLE (cutoff {seg["cutoff"]}):')
            print(f'  {"Segment":<16} {"Trades":<8} {"Win Rate":<10} {"Return":<10} {"Sharpe":<9} {"MaxDD":<8}')
            for label, key in (('In-Sample', 'in_sample'), ('Out-of-Sample', 'out_of_sample')):
                s = seg[key]
                print(f'  {label:<16} {s["total_trades"]:<8} {s["win_rate"]:<10.1f} {s["total_return"]:<+10.2f} '
                      f'{s["sharpe_ratio"]:<9.3f} {s["max_drawdown"]:<8.2f}')

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
    """Get equity curve data for a completed run (reconstructed from trades:
    realised, trade-close granularity — sum(pnl_usd) equals final-initial)."""
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
    parser.add_argument('--slippage-bps', type=float, default=float(os.getenv('BACKTEST_SLIPPAGE_BPS', '5')),
                        help='Adverse slippage per side in bps (default 5)')
    parser.add_argument('--fee-bps', type=float, default=float(os.getenv('BACKTEST_FEE_BPS', '10')),
                        help='Taker fee per side in bps (default 10)')
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
        'slippage_bps': args.slippage_bps,
        'fee_bps': args.fee_bps,
    }

    engine = BacktestEngine(args.run_id, config)
    engine.run()


if __name__ == '__main__':
    main()
