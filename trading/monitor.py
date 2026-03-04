"""
Position Monitor — checks TP/SL on open positions.
Paper trades: polls exchange prices and checks against TP/SL levels.
Live trades: checks exchange order status (reconciliation, not enforcement).
"""

import os
import time
import ccxt
import psycopg2
from data import MarketData

PRIMARY_EXCHANGE = os.getenv('CCXT_EXCHANGE', 'kucoin')


class PositionMonitor:
    TAKER_FEE = 0.001  # 0.10% — must match PaperTrader.TAKER_FEE

    def __init__(self):
        self.db_url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid')
        self.market_data = MarketData()
        self._exchange = None

    def _get_authenticated_exchange(self):
        """Authenticated CCXT instance for checking order status."""
        if self._exchange is not None:
            return self._exchange

        api_key = os.environ.get('CCXT_API_KEY')
        if not api_key:
            return None  # No keys = paper-only mode

        exchange_class = getattr(ccxt, PRIMARY_EXCHANGE)
        config = {
            'apiKey': api_key,
            'secret': os.environ['CCXT_API_SECRET'],
            'enableRateLimit': True,
        }
        if PRIMARY_EXCHANGE == 'kucoin':
            config['password'] = os.environ.get('CCXT_API_PASSPHRASE', '')

        self._exchange = exchange_class(config)
        return self._exchange

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
        """Check all open positions for TP/SL hits.
        Paper trades: poll prices and check levels.
        Live trades: check exchange order status (reconciliation).
        """
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT id, symbol, side, quantity, entry_price, tp_price, sl_price,
                       exchange, entry_fee, mode,
                       exchange_sl_order_id, exchange_tp_order_id
                FROM trades
                WHERE status = 'open' AND (tp_price IS NOT NULL OR sl_price IS NOT NULL)
            """)
            positions = cur.fetchall()
            results = []

            for pos in positions:
                (trade_id, symbol, side, quantity, entry_price, tp_price, sl_price,
                 exchange, entry_fee, mode, exchange_sl_id, exchange_tp_id) = pos

                if mode == 'live' and (exchange_sl_id or exchange_tp_id):
                    # Live trade: reconcile via exchange order status
                    result = self._check_live_trade(
                        cur, trade_id, symbol, side, quantity, entry_price,
                        tp_price, sl_price, entry_fee, exchange_sl_id, exchange_tp_id
                    )
                    results.append(result)
                else:
                    # Paper trade (or live trade missing exchange orders): poll prices
                    result = self._check_paper_trade(
                        cur, trade_id, symbol, side, quantity, entry_price,
                        tp_price, sl_price, exchange, entry_fee
                    )
                    results.append(result)

            conn.commit()
            cur.close()
        finally:
            conn.close()
        return results

    def _check_paper_trade(self, cur, trade_id, symbol, side, quantity, entry_price,
                           tp_price, sl_price, exchange, entry_fee):
        """Original price-polling logic for paper trades."""
        try:
            current_price = self._fetch_price(symbol, exchange)
        except Exception as e:
            print(f'[MONITOR] SKIPPING trade #{trade_id} ({symbol}) — could not fetch price: {e}')
            return {'trade_id': trade_id, 'error': str(e)}

        if not entry_price or float(entry_price) <= 0:
            return {'trade_id': trade_id, 'error': f'Invalid entry_price: {entry_price}'}

        action = None
        if side == 'buy':
            pnl_pct = ((current_price - float(entry_price)) / float(entry_price)) * 100
            if tp_price and current_price >= float(tp_price):
                action = 'tp_hit'
            elif sl_price and current_price <= float(sl_price):
                action = 'sl_hit'
        else:
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

            ef = float(entry_fee) if entry_fee else float(quantity) * float(entry_price) * self.TAKER_FEE
            exit_fee = float(quantity) * current_price * self.TAKER_FEE
            fees_paid = ef + exit_fee
            pnl_realised -= fees_paid
            pnl_pct = (pnl_realised / (float(quantity) * float(entry_price))) * 100

            cur.execute("""
                UPDATE trades SET
                    exit_price = %s, pnl_realised = %s, pnl_pct = %s, fees_paid = %s,
                    status = 'closed', closed_at = NOW(), close_reason = %s
                WHERE id = %s AND status = 'open'
                RETURNING id
            """, (current_price, round(pnl_realised, 4), round(pnl_pct, 4), round(fees_paid, 4), action, trade_id))

            closed_row = cur.fetchone()
            if not closed_row:
                print(f'[MONITOR] Trade #{trade_id} already closed by another process — skipping')
                return {'trade_id': trade_id, 'action': 'already_closed'}

            print(f'[MONITOR] {action.upper()} — trade #{trade_id} {symbol} {side} closed @ {current_price} (P&L: {round(pnl_pct, 2)}%, fees: {round(fees_paid, 4)})')
            return {
                'trade_id': trade_id,
                'action': action,
                'exit_price': current_price,
                'pnl_realised': round(pnl_realised, 4),
                'pnl_pct': round(pnl_pct, 4),
                'fees_paid': round(fees_paid, 4),
            }
        else:
            return {
                'trade_id': trade_id,
                'action': 'holding',
                'current_price': current_price,
                'pnl_pct': round(pnl_pct, 4),
            }

    def _check_live_trade(self, cur, trade_id, symbol, side, quantity, entry_price,
                          tp_price, sl_price, entry_fee, exchange_sl_id, exchange_tp_id):
        """Reconciliation for live trades: check if SL or TP order filled on exchange."""
        exchange = self._get_authenticated_exchange()
        if not exchange:
            print(f'[MONITOR] No API keys — falling back to price polling for live trade #{trade_id}')
            return self._check_paper_trade(
                cur, trade_id, symbol, side, quantity, entry_price,
                tp_price, sl_price, None, entry_fee
            )

        filled_order = None
        action = None
        cancel_order_id = None

        # Check SL order status
        if exchange_sl_id:
            try:
                sl_order = exchange.fetch_order(exchange_sl_id, symbol)
                if sl_order['status'] == 'closed':
                    filled_order = sl_order
                    action = 'sl_hit'
                    cancel_order_id = exchange_tp_id
            except Exception as e:
                print(f'[MONITOR] Failed to fetch SL order {exchange_sl_id}: {e}')

        # Check TP order status (only if SL hasn't filled)
        if not filled_order and exchange_tp_id:
            try:
                tp_order = exchange.fetch_order(exchange_tp_id, symbol)
                if tp_order['status'] == 'closed':
                    filled_order = tp_order
                    action = 'tp_hit'
                    cancel_order_id = exchange_sl_id
            except Exception as e:
                print(f'[MONITOR] Failed to fetch TP order {exchange_tp_id}: {e}')

        if not filled_order:
            # Neither filled — still holding
            try:
                current_price = self._fetch_price(symbol, None)
                if side == 'buy':
                    pnl_pct = ((current_price - float(entry_price)) / float(entry_price)) * 100
                else:
                    pnl_pct = ((float(entry_price) - current_price) / float(entry_price)) * 100
                return {
                    'trade_id': trade_id,
                    'action': 'holding',
                    'current_price': current_price,
                    'pnl_pct': round(pnl_pct, 4),
                    'mode': 'live',
                }
            except Exception:
                return {'trade_id': trade_id, 'action': 'holding', 'mode': 'live'}

        # One leg filled — cancel the other
        if cancel_order_id:
            try:
                exchange.cancel_order(cancel_order_id, symbol)
                print(f'[MONITOR] Cancelled opposite order {cancel_order_id}')
            except Exception as e:
                print(f'[MONITOR] Cancel opposite order {cancel_order_id} skipped: {e}')

        # Calculate P&L from filled order
        exit_price = float(filled_order.get('average') or filled_order.get('price') or 0)
        filled_qty = float(filled_order.get('filled') or quantity)

        if side == 'buy':
            pnl_realised = filled_qty * (exit_price - float(entry_price))
        else:
            pnl_realised = filled_qty * (float(entry_price) - exit_price)

        ef = float(entry_fee) if entry_fee else float(quantity) * float(entry_price) * self.TAKER_FEE
        exit_fee = filled_qty * exit_price * self.TAKER_FEE
        fees_paid = ef + exit_fee
        pnl_realised -= fees_paid
        pnl_pct = (pnl_realised / (float(quantity) * float(entry_price))) * 100

        cur.execute("""
            UPDATE trades SET
                exit_price = %s, pnl_realised = %s, pnl_pct = %s, fees_paid = %s,
                status = 'closed', closed_at = NOW(), close_reason = %s,
                exchange_sl_order_id = NULL, exchange_tp_order_id = NULL
            WHERE id = %s AND status = 'open'
            RETURNING id
        """, (exit_price, round(pnl_realised, 4), round(pnl_pct, 4), round(fees_paid, 4), action, trade_id))

        closed_row = cur.fetchone()
        if not closed_row:
            print(f'[MONITOR] Trade #{trade_id} already closed — skipping')
            return {'trade_id': trade_id, 'action': 'already_closed', 'mode': 'live'}

        print(f'[MONITOR] {action.upper()} — live trade #{trade_id} {symbol} {side} closed @ {exit_price} (P&L: {round(pnl_pct, 2)}%, fees: {round(fees_paid, 4)})')
        return {
            'trade_id': trade_id,
            'action': action,
            'exit_price': exit_price,
            'pnl_realised': round(pnl_realised, 4),
            'pnl_pct': round(pnl_pct, 4),
            'fees_paid': round(fees_paid, 4),
            'mode': 'live',
        }
