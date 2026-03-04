"""
Live Trader — real order execution via authenticated CCXT.
Places entry orders, then SL + TP orders on the exchange after fill.
KuCoin doesn't support native OCO — we place two independent orders
(stop-market for SL, limit for TP) and cancel the other when one fills.
"""

import os
import time
import ccxt
import psycopg2
from data import MarketData

# Primary exchange — must match config/symbols.js
PRIMARY_EXCHANGE = os.getenv('CCXT_EXCHANGE', 'kucoin')


class LiveTrader:
    TAKER_FEE = 0.001  # 0.10%

    def __init__(self):
        self.db_url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid')
        self.market_data = MarketData()
        self._exchange = None

    def _get_db(self):
        return psycopg2.connect(self.db_url)

    def _get_exchange(self):
        """Create authenticated CCXT exchange instance (cached)."""
        if self._exchange is not None:
            return self._exchange

        exchange_id = PRIMARY_EXCHANGE
        exchange_class = getattr(ccxt, exchange_id)

        config = {
            'apiKey': os.environ['CCXT_API_KEY'],
            'secret': os.environ['CCXT_API_SECRET'],
            'enableRateLimit': True,
        }

        # KuCoin requires a passphrase
        if exchange_id == 'kucoin':
            config['password'] = os.environ.get('CCXT_API_PASSPHRASE', '')

        self._exchange = exchange_class(config)
        self._exchange.load_markets()
        return self._exchange

    def execute(self, trade_data):
        """Execute a live trade: market entry + SL/TP orders on exchange."""
        symbol = trade_data['symbol']
        side = trade_data['side']
        quantity = float(trade_data['quantity'])
        entry_price = float(trade_data['entry_price'])
        tp_price = trade_data.get('tp_price')
        sl_price = trade_data.get('sl_price')

        exchange = self._get_exchange()

        # Place market entry order
        print(f'[LIVE] Placing {side} market order: {quantity} {symbol}')
        entry_order = exchange.create_order(
            symbol=symbol,
            type='market',
            side=side,
            amount=quantity,
        )

        exchange_entry_id = entry_order['id']
        fill_price = float(entry_order.get('average') or entry_order.get('price') or entry_price)
        filled_qty = float(entry_order.get('filled') or quantity)
        entry_fee = filled_qty * fill_price * self.TAKER_FEE

        print(f'[LIVE] Entry filled: {exchange_entry_id} @ {fill_price} (qty={filled_qty})')

        # Place SL and TP orders on the exchange
        sl_order_id = None
        tp_order_id = None

        if sl_price:
            sl_order_id = self._place_stop_loss(symbol, side, filled_qty, float(sl_price))

        if tp_price:
            tp_order_id = self._place_take_profit(symbol, side, filled_qty, float(tp_price))

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
                    slippage_bps, entry_fee, status,
                    exchange_entry_order_id, exchange_sl_order_id, exchange_tp_order_id
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    'live', %s, %s, %s, %s, %s, %s, %s, %s, %s, 'open',
                    %s, %s, %s
                ) RETURNING id
            """, (
                symbol,
                trade_data.get('asset_class', 'crypto'),
                trade_data.get('exchange', PRIMARY_EXCHANGE),
                side, filled_qty, entry_price,
                tp_price,
                sl_price,
                trade_data.get('template_id'),
                trade_data.get('execution_tier', 'ai_driven'),
                trade_data.get('confidence'),
                trade_data.get('cycle_number'),
                trade_data.get('agent_decision_id'),
                trade_data.get('reasoning'),
                trade_data.get('bootstrap_phase', 'infant'),
                trade_data.get('confidence'),
                entry_price,
                fill_price,
                abs(fill_price - entry_price) / entry_price * 10000 if entry_price else 0,
                round(entry_fee, 4),
                exchange_entry_id,
                sl_order_id,
                tp_order_id,
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
            'quantity': filled_qty,
            'requested_price': entry_price,
            'fill_price': round(fill_price, 8),
            'slippage_bps': round(abs(fill_price - entry_price) / entry_price * 10000, 2) if entry_price else 0,
            'fee': round(entry_fee, 4),
            'mode': 'live',
            'exchange_entry_order_id': exchange_entry_id,
            'exchange_sl_order_id': sl_order_id,
            'exchange_tp_order_id': tp_order_id,
        }

    def _place_stop_loss(self, symbol, entry_side, quantity, sl_price):
        """Place a stop-market order for the SL leg."""
        exchange = self._get_exchange()
        # SL closes the position: opposite side of entry
        close_side = 'sell' if entry_side == 'buy' else 'buy'

        try:
            # Use stop-market: triggers at sl_price, executes at market
            order = exchange.create_order(
                symbol=symbol,
                type='market',
                side=close_side,
                amount=quantity,
                params={
                    'stopPrice': sl_price,
                    'stop': 'loss',
                },
            )
            print(f'[LIVE] SL order placed: {order["id"]} @ stop={sl_price} ({close_side} {quantity})')
            return order['id']
        except Exception as e:
            print(f'[LIVE] WARNING: Failed to place SL order: {e}')
            return None

    def _place_take_profit(self, symbol, entry_side, quantity, tp_price):
        """Place a limit order for the TP leg."""
        exchange = self._get_exchange()
        close_side = 'sell' if entry_side == 'buy' else 'buy'

        try:
            # For TP, use a limit order at the target price
            # KuCoin: limit sell above market (long TP) or limit buy below market (short TP)
            order = exchange.create_order(
                symbol=symbol,
                type='limit',
                side=close_side,
                amount=quantity,
                price=tp_price,
            )
            print(f'[LIVE] TP order placed: {order["id"]} @ limit={tp_price} ({close_side} {quantity})')
            return order['id']
        except Exception as e:
            print(f'[LIVE] WARNING: Failed to place TP order: {e}')
            return None

    def close(self, trade_id):
        """Close a live trade: cancel exchange orders, place market close."""
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT * FROM trades WHERE id = %s AND status = 'open'
            """, (trade_id,))
            cols = [desc[0] for desc in cur.description]
            row = cur.fetchone()
            if not row:
                cur.close()
                raise ValueError(f"Trade {trade_id} not found or not open")

            trade = dict(zip(cols, row))
            exchange = self._get_exchange()

            # Cancel existing SL/TP orders on the exchange
            self._cancel_order_safe(exchange, trade['symbol'], trade.get('exchange_sl_order_id'))
            self._cancel_order_safe(exchange, trade['symbol'], trade.get('exchange_tp_order_id'))

            # Place market close order
            close_side = 'sell' if trade['side'] == 'buy' else 'buy'
            quantity = float(trade['quantity'])

            close_order = exchange.create_order(
                symbol=trade['symbol'],
                type='market',
                side=close_side,
                amount=quantity,
            )

            exit_price = float(close_order.get('average') or close_order.get('price') or 0)

            # Calculate P&L with fees
            entry_price = float(trade['entry_price'])
            if trade['side'] == 'buy':
                pnl = (exit_price - entry_price) * quantity
            else:
                pnl = (entry_price - exit_price) * quantity

            entry_fee = float(trade['entry_fee']) if trade.get('entry_fee') else quantity * entry_price * self.TAKER_FEE
            exit_fee = quantity * exit_price * self.TAKER_FEE
            fees_paid = entry_fee + exit_fee
            pnl -= fees_paid
            pnl_pct = (pnl / (quantity * entry_price)) * 100

            cur.execute("""
                UPDATE trades SET
                    exit_price = %s, pnl_realised = %s, pnl_pct = %s, fees_paid = %s,
                    status = 'closed', closed_at = NOW(), close_reason = 'position_review',
                    exchange_sl_order_id = NULL, exchange_tp_order_id = NULL
                WHERE id = %s
            """, (round(exit_price, 8), round(pnl, 4), round(pnl_pct, 4), round(fees_paid, 4), trade_id))

            conn.commit()
            cur.close()
        finally:
            conn.close()

        return {
            'trade_id': trade_id,
            'symbol': trade['symbol'],
            'side': trade['side'],
            'entry_price': float(trade['entry_price']),
            'exit_price': round(exit_price, 8),
            'pnl': round(pnl, 4),
            'pnl_pct': round(pnl_pct, 4),
            'fees_paid': round(fees_paid, 4),
            'close_reason': 'position_review',
            'mode': 'live',
        }

    def cancel_exchange_orders(self, trade):
        """Cancel SL and TP orders for a trade on the exchange."""
        exchange = self._get_exchange()
        self._cancel_order_safe(exchange, trade['symbol'], trade.get('exchange_sl_order_id'))
        self._cancel_order_safe(exchange, trade['symbol'], trade.get('exchange_tp_order_id'))

    def place_sl_tp(self, trade):
        """Place SL and TP orders for an existing trade (used by crash recovery)."""
        symbol = trade['symbol']
        side = trade['side']
        quantity = float(trade['quantity'])

        sl_order_id = None
        tp_order_id = None

        if trade.get('sl_price'):
            sl_order_id = self._place_stop_loss(symbol, side, quantity, float(trade['sl_price']))

        if trade.get('tp_price'):
            tp_order_id = self._place_take_profit(symbol, side, quantity, float(trade['tp_price']))

        # Update DB with new order IDs
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("""
                UPDATE trades SET
                    exchange_sl_order_id = %s, exchange_tp_order_id = %s
                WHERE id = %s
            """, (sl_order_id, tp_order_id, trade['id']))
            conn.commit()
            cur.close()
        finally:
            conn.close()

        return {'sl_order_id': sl_order_id, 'tp_order_id': tp_order_id}

    def _cancel_order_safe(self, exchange, symbol, order_id):
        """Cancel an order, ignoring errors (already filled/cancelled)."""
        if not order_id:
            return
        try:
            exchange.cancel_order(order_id, symbol)
            print(f'[LIVE] Cancelled order {order_id}')
        except Exception as e:
            print(f'[LIVE] Cancel order {order_id} skipped: {e}')
