"""
Position Monitor — checks TP/SL on open positions.
"""

import os
import time
import psycopg2
from data import MarketData


class PositionMonitor:
    def __init__(self):
        self.db_url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid')
        self.market_data = MarketData()

    def _get_db(self):
        return psycopg2.connect(self.db_url)

    def _fetch_price(self, symbol, exchange):
        """Fetch current price with symbol normalization and 1 retry."""
        # ccxt expects '/' separator (e.g. BTC/USDT), DB may store with '-'
        normalized = symbol.replace('-', '/')
        exc = exchange or None  # None → uses PRIMARY_EXCHANGE from data.py

        try:
            return self.market_data.get_current_price(normalized, exc)
        except Exception as first_err:
            print(f'[MONITOR] Price fetch failed for {normalized} (attempt 1): {first_err}')
            time.sleep(2)
            try:
                return self.market_data.get_current_price(normalized, exc)
            except Exception as retry_err:
                print(f'[MONITOR] Price fetch failed for {normalized} (attempt 2): {retry_err}')
                raise retry_err

    def check_all(self):
        """Check all open positions for TP/SL hits."""
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT id, symbol, side, quantity, entry_price, tp_price, sl_price, exchange
                FROM trades
                WHERE status = 'open' AND (tp_price IS NOT NULL OR sl_price IS NOT NULL)
            """)
            positions = cur.fetchall()
            results = []

            for pos in positions:
                trade_id, symbol, side, quantity, entry_price, tp_price, sl_price, exchange = pos
                try:
                    current_price = self._fetch_price(symbol, exchange)
                except Exception as e:
                    print(f'[MONITOR] SKIPPING trade #{trade_id} ({symbol}) — could not fetch price: {e}')
                    results.append({'trade_id': trade_id, 'error': str(e)})
                    continue

                action = None
                pnl = 0

                if not entry_price or float(entry_price) <= 0:
                    results.append({'trade_id': trade_id, 'error': f'Invalid entry_price: {entry_price}'})
                    continue

                if side == 'buy':
                    pnl_pct = ((current_price - float(entry_price)) / float(entry_price)) * 100
                    if tp_price and current_price >= float(tp_price):
                        action = 'tp_hit'
                    elif sl_price and current_price <= float(sl_price):
                        action = 'sl_hit'
                else:  # sell/short
                    pnl_pct = ((float(entry_price) - current_price) / float(entry_price)) * 100
                    if tp_price and current_price <= float(tp_price):
                        action = 'tp_hit'
                    elif sl_price and current_price >= float(sl_price):
                        action = 'sl_hit'

                if action:
                    if side == 'buy':
                        pnl_realised = float(quantity) * (current_price - float(entry_price))
                    else:
                        pnl_realised = float(quantity) * (float(entry_price) - current_price)

                    cur.execute("""
                        UPDATE trades SET
                            exit_price = %s, pnl_realised = %s, pnl_pct = %s,
                            status = 'closed', closed_at = NOW(), close_reason = %s
                        WHERE id = %s AND status = 'open'
                        RETURNING id
                    """, (current_price, round(pnl_realised, 4), round(pnl_pct, 4), action, trade_id))

                    closed_row = cur.fetchone()
                    if not closed_row:
                        print(f'[MONITOR] Trade #{trade_id} already closed by another process — skipping')
                        continue

                    print(f'[MONITOR] {action.upper()} — trade #{trade_id} {symbol} {side} closed @ {current_price} (P&L: {round(pnl_pct, 2)}%)')

                    results.append({
                        'trade_id': trade_id,
                        'action': action,
                        'exit_price': current_price,
                        'pnl_realised': round(pnl_realised, 4),
                        'pnl_pct': round(pnl_pct, 4),
                    })
                else:
                    results.append({
                        'trade_id': trade_id,
                        'action': 'holding',
                        'current_price': current_price,
                        'pnl_pct': round(pnl_pct, 4),
                    })

            conn.commit()
            cur.close()
        finally:
            conn.close()
        return results
