"""
Paper Trade Simulator — realistic fee modelling with maker/taker fees and slippage.
"""

import os
import random
import psycopg2
from datetime import datetime, timezone
from data import MarketData
from common import compute_pnl, estimate_fee, validate_amend


class PaperTrader:
    # Fee structure (0.10% — matches KuCoin/Binance/OKX standard taker fee)
    MAKER_FEE = 0.001     # 0.10%
    TAKER_FEE = 0.001     # 0.10%
    SLIPPAGE_BPS = 5       # 5 basis points average slippage

    def __init__(self):
        self.db_url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid')
        self.market_data = MarketData()  # Reuse shared instance

    def _get_db(self):
        return psycopg2.connect(self.db_url)

    def execute(self, trade_data):
        """Execute a paper trade with realistic fee and slippage simulation."""
        # H-10: Force paper mode if LIVE_TRADING_ENABLED is not true
        live_enabled = os.environ.get('LIVE_TRADING_ENABLED', 'false').lower() == 'true'
        if not live_enabled and trade_data.get('mode', 'paper') != 'paper':
            print('[PAPER] LIVE_TRADING_ENABLED=false — forcing paper mode')
            trade_data['mode'] = 'paper'
        symbol = trade_data['symbol']
        side = trade_data['side']
        quantity = float(trade_data['quantity'])
        entry_price = float(trade_data['entry_price'])

        # Simulate slippage
        slippage_pct = random.gauss(self.SLIPPAGE_BPS / 10000, self.SLIPPAGE_BPS / 20000)
        slippage_pct = max(0, slippage_pct)  # No negative slippage

        if side == 'buy':
            actual_price = entry_price * (1 + slippage_pct)
        else:
            actual_price = entry_price * (1 - slippage_pct)

        # Calculate entry fee
        entry_fee = quantity * actual_price * self.TAKER_FEE
        slippage_bps = abs(actual_price - entry_price) / entry_price * 10000

        # Store trade in DB (with entry_fee for deduction at close)
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO trades (
                    symbol, asset_class, exchange, side, quantity, entry_price,
                    tp_price, sl_price, template_id, execution_tier, confidence,
                    mode, cycle_number, agent_decision_id, reasoning, bootstrap_phase,
                    entry_confidence, expected_fill_price, actual_fill_price,
                    slippage_bps, entry_fee, status
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    'paper', %s, %s, %s, %s, %s, %s, %s, %s, %s, 'open'
                ) RETURNING id
            """, (
                symbol,
                trade_data.get('asset_class', 'crypto'),
                trade_data.get('exchange', 'binance'),
                # entry_price = the SLIPPED fill (P&L basis, same semantics as
                # live); the requested price is kept in expected_fill_price.
                side, quantity, actual_price,
                trade_data.get('tp_price'),
                trade_data.get('sl_price'),
                trade_data.get('template_id'),
                trade_data.get('execution_tier', 'ai_driven'),
                trade_data.get('confidence'),
                trade_data.get('cycle_number'),
                trade_data.get('agent_decision_id'),
                trade_data.get('reasoning'),
                trade_data.get('bootstrap_phase', 'infant'),
                trade_data.get('confidence'),
                entry_price,
                actual_price,
                slippage_bps,
                round(entry_fee, 4),
            ))

            trade_id = cur.fetchone()[0]
            conn.commit()
            cur.close()
        finally:
            conn.close()

        return {
            'trade_id': trade_id,
            'symbol': symbol,
            'side': side,
            'quantity': quantity,
            'requested_price': entry_price,
            'fill_price': round(actual_price, 8),
            'slippage_bps': round(slippage_bps, 2),
            'fee': round(entry_fee, 4),
            'mode': 'paper',
        }

    def amend_stops(self, trade_id, sl_price=None, tp_price=None):
        """Paper amend: validate (SL may only tighten) and update the DB row."""
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("SELECT side, sl_price, tp_price, status, mode, symbol FROM trades "
                        "WHERE id = %s FOR UPDATE", (trade_id,))
            row = cur.fetchone()
            if not row:
                raise ValueError(f'Trade {trade_id} not found')
            side, old_sl, old_tp, status, mode, symbol = row
            if status != 'open':
                raise ValueError(f'Trade {trade_id} not open (status={status})')
            if mode == 'live':
                raise ValueError(f'Trade {trade_id} is a live trade')
            ref_price = None
            try:
                ref_price = self.market_data.get_current_price(symbol.replace('-', '/'))
            except Exception as e:
                print(f'[PAPER] amend-stops: no reference price for {symbol} ({e}); skipping market-side check')
            err = validate_amend(side, old_sl, sl_price, tp_price, ref_price)
            if err:
                raise ValueError(err)
            cur.execute("""
                UPDATE trades SET sl_price = COALESCE(%s, sl_price), tp_price = COALESCE(%s, tp_price)
                WHERE id = %s AND status = 'open'
            """, (sl_price, tp_price, trade_id))
            conn.commit()
            cur.close()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        return {'trade_id': trade_id,
                'sl_price': sl_price if sl_price is not None else (float(old_sl) if old_sl is not None else None),
                'tp_price': tp_price if tp_price is not None else (float(old_tp) if old_tp is not None else None),
                'mode': 'paper'}

    def close(self, trade_id):
        """Close an open trade with realistic exit slippage."""
        conn = self._get_db()
        try:
            cur = conn.cursor()

            # Fetch the open trade
            cur.execute("SELECT * FROM trades WHERE id = %s AND status = 'open' FOR UPDATE", (trade_id,))
            cols = [desc[0] for desc in cur.description]
            row = cur.fetchone()
            if not row:
                cur.close()
                raise ValueError(f"Trade {trade_id} not found or not open")

            trade = dict(zip(cols, row))

            # Get current market price
            current_price = self.market_data.get_current_price(trade['symbol'].replace('-', '/'))

            # Simulate exit slippage (selling gets worse price, buying gets worse price)
            slippage_pct = random.gauss(self.SLIPPAGE_BPS / 10000, self.SLIPPAGE_BPS / 20000)
            slippage_pct = max(0, slippage_pct)

            if trade['side'] == 'buy':
                # Closing a long = selling, price slips down
                exit_price = current_price * (1 - slippage_pct)
            else:
                # Closing a short = buying, price slips up
                exit_price = current_price * (1 + slippage_pct)

            # Calculate P&L
            entry_price = float(trade['entry_price'])
            quantity = float(trade['quantity'])

            # entry_price is the slipped entry fill (see execute()); round-trip
            # fees are deducted from P&L.
            entry_fee = float(trade['entry_fee']) if trade.get('entry_fee') else estimate_fee(quantity, entry_price)
            exit_fee = quantity * exit_price * self.TAKER_FEE
            pnl, pnl_pct, fees_paid = compute_pnl(
                trade['side'], quantity, entry_price, exit_price, entry_fee, exit_fee)

            # Update trade in DB
            cur.execute("""
                UPDATE trades SET
                    exit_price = %s, pnl_realised = %s, pnl_pct = %s, fees_paid = %s,
                    status = 'closed', closed_at = NOW(), close_reason = 'position_review'
                WHERE id = %s AND status = 'open'
                RETURNING id
            """, (round(exit_price, 8), round(pnl, 4), round(pnl_pct, 4), round(fees_paid, 4), trade_id))
            if not cur.fetchone():
                raise ValueError(f"Trade {trade_id} was closed concurrently")

            conn.commit()
            cur.close()
        finally:
            conn.close()

        return {
            'trade_id': trade_id,
            'symbol': trade['symbol'],
            'side': trade['side'],
            'entry_price': entry_price,
            'exit_price': round(exit_price, 8),
            'pnl': round(pnl, 4),
            'pnl_pct': round(pnl_pct, 4),
            'fees_paid': round(fees_paid, 4),
            'close_reason': 'position_review',
        }
