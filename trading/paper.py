"""
Paper Trade Simulator — realistic fee modelling with maker/taker fees and slippage.
"""

import os
import random
import psycopg2
from datetime import datetime, timezone


class PaperTrader:
    # Realistic Binance fee structure
    MAKER_FEE = 0.001     # 0.10%
    TAKER_FEE = 0.001     # 0.10%
    SLIPPAGE_BPS = 5       # 5 basis points average slippage

    def __init__(self):
        self.db_url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid')

    def _get_db(self):
        return psycopg2.connect(self.db_url)

    def execute(self, trade_data):
        """Execute a paper trade with realistic fee and slippage simulation."""
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
        ))

        trade_id = cur.fetchone()[0]
        conn.commit()
        cur.close()
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
