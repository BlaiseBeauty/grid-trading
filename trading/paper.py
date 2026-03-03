"""
Paper Trade Simulator — realistic fee modelling with maker/taker fees and slippage.
"""

import os
import random
import psycopg2
from datetime import datetime, timezone
from data import MarketData


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

        # Calculate fees
        fee = quantity * actual_price * self.TAKER_FEE
        slippage_bps = abs(actual_price - entry_price) / entry_price * 10000

        # Store trade in DB
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO trades (
                    symbol, asset_class, exchange, side, quantity, entry_price,
                    tp_price, sl_price, template_id, execution_tier, confidence,
                    mode, cycle_number, agent_decision_id, reasoning, bootstrap_phase,
                    entry_confidence, expected_fill_price, actual_fill_price,
                    slippage_bps, status
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    'paper', %s, %s, %s, %s, %s, %s, %s, %s, 'open'
                ) RETURNING id
            """, (
                symbol,
                trade_data.get('asset_class', 'crypto'),
                trade_data.get('exchange', 'binance'),
                side, quantity, entry_price,
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
            'fee': round(fee, 4),
            'mode': 'paper',
        }

    def close(self, trade_id):
        """Close an open trade with realistic exit slippage."""
        conn = self._get_db()
        try:
            cur = conn.cursor()

            # Fetch the open trade
            cur.execute("SELECT * FROM trades WHERE id = %s AND status = 'open'", (trade_id,))
            cols = [desc[0] for desc in cur.description]
            row = cur.fetchone()
            if not row:
                cur.close()
                raise ValueError(f"Trade {trade_id} not found or not open")

            trade = dict(zip(cols, row))

            # Get current market price
            current_price = self.market_data.get_current_price(trade['symbol'])

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

            if trade['side'] == 'buy':
                pnl = (exit_price - entry_price) * quantity
            else:
                pnl = (entry_price - exit_price) * quantity

            pnl_pct = ((exit_price - entry_price) / entry_price * 100) if trade['side'] == 'buy' \
                else ((entry_price - exit_price) / entry_price * 100)

            # Update trade in DB
            cur.execute("""
                UPDATE trades SET
                    exit_price = %s, pnl_realised = %s, pnl_pct = %s,
                    status = 'closed', closed_at = NOW(), close_reason = 'position_review'
                WHERE id = %s
                RETURNING id
            """, (round(exit_price, 8), round(pnl, 4), round(pnl_pct, 4), trade_id))

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
            'close_reason': 'position_review',
        }
