"""
Live Trader — real order execution via authenticated CCXT.

Order-protection design (spot, KuCoin):
  * Entry: market order carrying a clientOid (idempotency). A DB row is written
    as status 'pending' BEFORE the exchange call and flipped to 'open' with the
    REAL fill (price, qty, fee) afterwards.
  * Stop-loss: a stop-market order is placed on the exchange right after the
    fill, with retry/backoff. If it cannot be placed the position is flattened
    immediately — a live position never stays open without a stop.
  * Take-profit: NOT placed on the exchange. On spot, an SL and a TP limit would
    each reserve the full base balance, so the second order fails (or blocks
    the first). ccxt exposes KuCoin OCO only as raw implicit endpoints
    (privatePostOcoOrder) with no unified create_order support, which we cannot
    verify offline, so we deliberately use "exchange SL + monitor-driven TP":
    monitor.py detects the TP level (candle highs/lows + last price) and calls
    LiveTrader.close(trade_id, close_reason='tp_hit'), which cancels the SL and
    market-closes. (Legacy rows that still carry an exchange TP order id are
    honoured.)
"""

import os
import time

import ccxt
import psycopg2
import psycopg2.errors

from data import MarketData
from common import (
    PRIMARY_EXCHANGE, TAKER_FEE, get_db, get_authenticated_exchange,
    close_side_for, order_fill, fee_in_quote, fee_in_base, compute_pnl,
    estimate_fee, validate_amend, is_finite_positive,
)

OrderNotFound = ccxt.OrderNotFound
InsufficientFunds = ccxt.InsufficientFunds
SL_RETRY_DELAYS = (0.5, 1.5, 3.0)   # backoff between SL placement attempts (4 attempts total)


def _log(level, msg):
    print(f'[LIVE] {level}: {msg}', flush=True)


class LiveTradeError(Exception):
    """Raised for failures where the caller needs structured context
    (trade_id, whether the position was flattened, ...)."""

    def __init__(self, message, payload=None, status=502):
        super().__init__(message)
        self.payload = payload or {}
        self.status = status


class LiveTrader:
    TAKER_FEE = TAKER_FEE  # only used when the exchange reports no fee

    def __init__(self):
        self.db_url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid')
        self.market_data = MarketData()
        self._has_coid_col = False

    # ── plumbing ─────────────────────────────────────────────────────────────

    def _get_db(self):
        return get_db(self.db_url)

    def _get_exchange(self):
        ex = get_authenticated_exchange()
        if ex is None:
            raise RuntimeError('CCXT_API_KEY / CCXT_API_SECRET not configured')
        return ex

    @staticmethod
    def _row_dict(cur):
        cols = [d[0] for d in cur.description]
        row = cur.fetchone()
        return dict(zip(cols, row)) if row else None

    def _coid_column_exists(self, conn):
        """Is trades.client_order_id present? (additive migration may lag the
        deploy.) Positive result is cached; a negative one is re-checked."""
        if self._has_coid_col:
            return True
        cur = conn.cursor()
        try:
            cur.execute("""SELECT 1 FROM information_schema.columns
                           WHERE table_name = 'trades' AND column_name = 'client_order_id'""")
            self._has_coid_col = cur.fetchone() is not None
        finally:
            cur.close()
        if not self._has_coid_col:
            _log('WARN', 'trades.client_order_id column is missing — idempotency falls back to the '
                         'exchange clientOid lookup + exchange_entry_order_id. Apply the migration.')
        return self._has_coid_col

    # ── idempotency ──────────────────────────────────────────────────────────

    def _find_existing(self, conn, exchange, symbol, coid):
        """Existing trade row for this client_order_id, or None."""
        if not coid:
            return None
        if self._coid_column_exists(conn):
            cur = conn.cursor()
            try:
                cur.execute("SELECT * FROM trades WHERE client_order_id = %s", (coid,))
                return self._row_dict(cur)
            finally:
                cur.close()
        # Column absent: ask the exchange whether an order with this clientOid
        # exists and map it back to a trade via exchange_entry_order_id.
        order = self._fetch_by_client_oid(exchange, symbol, coid)
        if order and order.get('id'):
            cur = conn.cursor()
            try:
                cur.execute("SELECT * FROM trades WHERE exchange_entry_order_id = %s", (str(order['id']),))
                return self._row_dict(cur)
            finally:
                cur.close()
        return None

    def _fetch_by_client_oid(self, exchange, symbol, coid, stop=False):
        params = {'clientOid': coid}
        if stop:
            params['stop'] = True
        try:
            return exchange.fetch_order(None, symbol, params)
        except OrderNotFound:
            return None
        except Exception as e:
            _log('WARN', f'clientOid lookup for {coid} failed: {e}')
            return None

    def _replay_result(self, row):
        status = row.get('status')
        if status == 'pending':
            raise LiveTradeError(
                f"A trade with this client_order_id is still pending/unresolved (trade #{row['id']}); "
                'reconcile before retrying', {'trade_id': row['id'], 'status': 'pending'}, status=409)
        if status == 'cancelled':
            raise LiveTradeError(
                f"Previous attempt for this client_order_id was cancelled (trade #{row['id']}); "
                'use a new client_order_id to retry', {'trade_id': row['id'], 'status': 'cancelled'}, status=409)
        fill = float(row['actual_fill_price'] or row['entry_price'])
        req = float(row['expected_fill_price'] or fill)
        return {
            'trade_id': row['id'], 'symbol': row['symbol'], 'side': row['side'],
            'quantity': float(row['quantity']), 'requested_price': req,
            'fill_price': round(fill, 8),
            'slippage_bps': round(abs(fill - req) / req * 10000, 2) if req else 0,
            'fee': float(row['entry_fee'] or 0), 'mode': 'live', 'status': status,
            'exchange_entry_order_id': row.get('exchange_entry_order_id'),
            'exchange_sl_order_id': row.get('exchange_sl_order_id'),
            'exchange_tp_order_id': row.get('exchange_tp_order_id'),
            'client_order_id': row.get('client_order_id'),
            'idempotent_replay': True,
        }

    # ── entry ────────────────────────────────────────────────────────────────

    def execute(self, trade_data):
        """Execute a live trade: pending row -> market entry -> real fill ->
        exchange stop-loss. Idempotent on client_order_id."""
        symbol = trade_data['symbol']
        side = trade_data['side']
        quantity = float(trade_data['quantity'])
        requested_price = float(trade_data['entry_price'])
        tp_price = trade_data.get('tp_price')
        sl_price = trade_data.get('sl_price')
        coid = trade_data.get('client_order_id')
        generated_coid = False
        if not coid:
            # Server-generated so an ambiguous exchange failure can always be
            # resolved by a clientOid lookup (callers should still send one).
            coid = f'g{os.urandom(10).hex()}'
            generated_coid = True
            _log('WARN', f'no client_order_id supplied — generated {coid}; caller retries are NOT idempotent')

        exchange = self._get_exchange()

        conn = self._get_db()
        try:
            existing = self._find_existing(conn, exchange, symbol, None if generated_coid else coid)
            if existing:
                _log('INFO', f"idempotent replay for client_order_id={coid} -> trade #{existing['id']}")
                return self._replay_result(existing)
            trade_id = self._insert_pending(conn, trade_data, coid, requested_price)
        finally:
            conn.close()
        if isinstance(trade_id, dict):          # lost a race to a concurrent identical request
            return self._replay_result(trade_id)

        # ---- entry order -------------------------------------------------------
        _log('INFO', f'placing {side} market order: {quantity} {symbol} (trade #{trade_id}, clientOid={coid})')
        try:
            order = exchange.create_order(symbol, 'market', side, quantity, None, {'clientOid': coid})
        except Exception as e:
            # Ambiguous failure (timeout?): the order may exist. Look it up.
            order = self._fetch_by_client_oid(exchange, symbol, coid)
            if order is None:
                self._mark_status(trade_id, 'cancelled', f'entry order failed: {e}')
                raise LiveTradeError(f'Entry order failed: {e}', {'trade_id': trade_id}) from e
            _log('WARN', f'create_order raised ({e}) but order {order.get("id")} exists — continuing with it')

        exchange_entry_id = str(order['id'])
        order = self._await_fill(exchange, order, symbol)
        fill_price, filled_qty = order_fill(order)
        if not fill_price or not filled_qty:
            # Can't prove what filled. Do NOT guess; keep the pending row linked to the exchange order.
            self._link_entry_order(trade_id, exchange_entry_id)
            _log('CRITICAL', f'trade #{trade_id}: entry order {exchange_entry_id} fill unknown '
                             f'(status={order.get("status")}) — manual reconcile required')
            raise LiveTradeError('Entry fill could not be confirmed; trade left pending for reconciliation',
                                 {'trade_id': trade_id, 'exchange_entry_order_id': exchange_entry_id,
                                  'needs_reconcile': True})

        entry_fee = fee_in_quote(order, symbol, fill_price)
        if entry_fee is None:
            entry_fee = estimate_fee(filled_qty, fill_price)
            _log('WARN', f'trade #{trade_id}: exchange reported no convertible fee — estimated at '
                         f'{self.TAKER_FEE * 100:.2f}% = {entry_fee:.6f}')
        # A buy fee paid in the base asset reduces what we can actually sell.
        position_qty = filled_qty - (fee_in_base(order, symbol) if side == 'buy' else 0.0)
        try:
            position_qty = float(exchange.amount_to_precision(symbol, position_qty))
        except Exception as e:
            _log('WARN', f'amount_to_precision failed for {symbol} {position_qty}: {e}')
        slippage_bps = abs(fill_price - requested_price) / requested_price * 10000 if requested_price else 0
        _log('INFO', f'entry filled: {exchange_entry_id} @ {fill_price} (filled={filled_qty}, '
                     f'position_qty={position_qty}, requested={requested_price}, fee={entry_fee:.6f})')

        # ---- pending -> open with the real fill --------------------------------
        try:
            self._mark_open(trade_id, position_qty, fill_price, requested_price, slippage_bps,
                            entry_fee, exchange_entry_id)
        except Exception as db_err:
            _log('CRITICAL', f'trade #{trade_id}: exchange entry {exchange_entry_id} FILLED but DB update '
                             f'failed ({db_err}) — flattening to avoid an orphan')
            flat = None
            try:
                flat = self._market_close(exchange, symbol, side, position_qty, f'{coid}-x')
            except Exception as close_err:
                _log('CRITICAL', f'trade #{trade_id}: FLATTEN FAILED ({close_err}) — ORPHAN POSITION '
                                 f'{side} {position_qty} {symbol}, entry order {exchange_entry_id}')
            self._try_mark_flattened(trade_id, flat, 'db_update_failed')
            raise LiveTradeError(f'DB update failed after fill: {db_err}',
                                 {'trade_id': trade_id, 'flattened': flat is not None,
                                  'orphan': flat is None,
                                  'exchange_entry_order_id': exchange_entry_id}) from db_err

        # ---- stop-loss (mandatory) ---------------------------------------------
        sl_order_id = None
        if sl_price:
            try:
                sl_order_id = self._place_stop_loss_retry(
                    exchange, symbol, side, position_qty, float(sl_price), self._sl_oid(coid))
            except Exception as sl_err:
                _log('CRITICAL', f'trade #{trade_id}: stop-loss placement failed after retries ({sl_err}) '
                                 '— closing position immediately')
                flat = None
                try:
                    flat = self._market_close(exchange, symbol, side, position_qty, f'{coid}-f')
                except Exception as close_err:
                    _log('CRITICAL', f'trade #{trade_id}: FLATTEN FAILED ({close_err}) — UNPROTECTED POSITION '
                                     f'{side} {position_qty} {symbol}')
                    raise LiveTradeError(
                        f'Stop-loss placement failed AND flatten failed: {sl_err} / {close_err}',
                        {'trade_id': trade_id, 'flattened': False, 'unprotected': True}) from close_err
                self._finalize_flattened(trade_id, flat, symbol, side, position_qty, fill_price,
                                         entry_fee, 'sl_placement_failed')
                raise LiveTradeError(f'Stop-loss placement failed; position flattened: {sl_err}',
                                     {'trade_id': trade_id, 'flattened': True}) from sl_err
            try:
                self._set_order_ids(trade_id, sl_order_id=sl_order_id)
            except Exception as db_err:
                _log('CRITICAL', f'trade #{trade_id}: SL order {sl_order_id} placed but DB link failed '
                                 f'({db_err}) — /recover-orders will adopt it via open-order lookup')

        return {
            'trade_id': trade_id,
            'symbol': symbol,
            'side': side,
            'quantity': position_qty,
            'requested_price': requested_price,
            'fill_price': round(fill_price, 8),
            'slippage_bps': round(slippage_bps, 2),
            'fee': round(entry_fee, 4),
            'mode': 'live',
            'status': 'open',
            'exchange_entry_order_id': exchange_entry_id,
            'exchange_sl_order_id': sl_order_id,
            'exchange_tp_order_id': None,   # TP is monitor-driven (see module docstring)
            'tp_price': tp_price,
            'client_order_id': coid,
            'idempotent_replay': False,
        }

    def _insert_pending(self, conn, td, coid, requested_price):
        """Insert the 'pending' row. Returns the new id, or the existing row
        (dict) if a concurrent request with the same client_order_id won."""
        has_coid = self._coid_column_exists(conn)
        cols = ['symbol', 'asset_class', 'exchange', 'side', 'quantity', 'entry_price',
                'tp_price', 'sl_price', 'template_id', 'execution_tier', 'confidence',
                'mode', 'cycle_number', 'agent_decision_id', 'reasoning', 'bootstrap_phase',
                'entry_confidence', 'expected_fill_price', 'status']
        vals = [td['symbol'], td.get('asset_class', 'crypto'), td.get('exchange', PRIMARY_EXCHANGE),
                td['side'], float(td['quantity']), requested_price,
                td.get('tp_price'), td.get('sl_price'), td.get('template_id'),
                td.get('execution_tier', 'ai_driven'), td.get('confidence'),
                'live', td.get('cycle_number'), td.get('agent_decision_id'), td.get('reasoning'),
                td.get('bootstrap_phase', 'infant'), td.get('confidence'), requested_price, 'pending']
        if has_coid:
            cols.append('client_order_id')
            vals.append(coid)
        sql = f"INSERT INTO trades ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))}) RETURNING id"
        cur = conn.cursor()
        try:
            cur.execute(sql, vals)
            trade_id = cur.fetchone()[0]
            conn.commit()
            return trade_id
        except psycopg2.errors.UniqueViolation:
            conn.rollback()
            cur.execute("SELECT * FROM trades WHERE client_order_id = %s", (coid,))
            row = self._row_dict(cur)
            if row:
                return row
            raise
        except psycopg2.errors.CheckViolation as e:
            conn.rollback()
            raise LiveTradeError(
                "trades.status CHECK constraint does not allow 'pending' — apply the migration that adds "
                f"'pending' before enabling live trading ({e})", status=500) from e
        finally:
            cur.close()

    def _await_fill(self, exchange, order, symbol, attempts=4):
        """Return the order with fill data, polling fetch_order when create_order
        returned only an id (KuCoin) or a not-yet-closed market order."""
        for i in range(attempts + 1):
            price, filled = order_fill(order)
            if order.get('status') == 'closed' and price and filled:
                return order
            if order.get('status') in ('canceled', 'expired', 'rejected'):
                return order
            if i == attempts:
                break
            time.sleep(0.5 * (i + 1))
            try:
                order = exchange.fetch_order(order['id'], symbol)
            except Exception as e:
                _log('WARN', f'fetch_order({order.get("id")}) failed while confirming fill: {e}')
        return order

    # ── small DB writers ─────────────────────────────────────────────────────

    def _mark_status(self, trade_id, status, note=None):
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("UPDATE trades SET status = %s WHERE id = %s AND status = 'pending'", (status, trade_id))
            conn.commit()
            cur.close()
            if note:
                _log('INFO', f'trade #{trade_id} -> {status}: {note}')
        except Exception as e:
            conn.rollback()
            _log('ERROR', f'trade #{trade_id}: could not mark {status}: {e}')
        finally:
            conn.close()

    def _link_entry_order(self, trade_id, exchange_entry_id):
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("UPDATE trades SET exchange_entry_order_id = %s WHERE id = %s",
                        (exchange_entry_id, trade_id))
            conn.commit()
            cur.close()
        except Exception as e:
            conn.rollback()
            _log('ERROR', f'trade #{trade_id}: could not link entry order {exchange_entry_id}: {e}')
        finally:
            conn.close()

    def _mark_open(self, trade_id, qty, fill_price, requested_price, slippage_bps, entry_fee, entry_id):
        conn = self._get_db()
        try:
            cur = conn.cursor()
            # entry_price is the REAL fill (P&L basis); requested stays in expected_fill_price.
            cur.execute("""
                UPDATE trades SET status = 'open', quantity = %s, entry_price = %s,
                    actual_fill_price = %s, expected_fill_price = %s, slippage_bps = %s,
                    entry_fee = %s, exchange_entry_order_id = %s, opened_at = NOW()
                WHERE id = %s AND status = 'pending'
            """, (qty, round(fill_price, 8), round(fill_price, 8), requested_price,
                  round(slippage_bps, 4), round(entry_fee, 4), entry_id, trade_id))
            if cur.rowcount != 1:
                raise RuntimeError(f'trade #{trade_id} was not pending (rowcount={cur.rowcount})')
            conn.commit()
            cur.close()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _set_order_ids(self, trade_id, sl_order_id=None):
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("UPDATE trades SET exchange_sl_order_id = %s WHERE id = %s", (sl_order_id, trade_id))
            conn.commit()
            cur.close()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _try_mark_flattened(self, trade_id, close_order, reason):
        """Best-effort bookkeeping after an emergency flatten where the DB
        was already unhealthy. Never raises."""
        try:
            conn = self._get_db()
        except Exception as e:
            _log('CRITICAL', f'trade #{trade_id}: DB unreachable while recording flatten ({reason}): {e}')
            return
        try:
            cur = conn.cursor()
            cur.execute("UPDATE trades SET status = 'cancelled', close_reason = %s WHERE id = %s "
                        "AND status IN ('pending','open')", (reason, trade_id))
            conn.commit()
            cur.close()
        except Exception as e:
            conn.rollback()
            _log('CRITICAL', f'trade #{trade_id}: could not record flatten ({reason}): {e}')
        finally:
            conn.close()

    def _finalize_flattened(self, trade_id, close_order, symbol, side, qty, entry_price, entry_fee, reason):
        """Record the close of a freshly opened trade that we flattened
        immediately (e.g. SL placement failed). Uses real fills."""
        try:
            exit_price, exit_qty, exit_fee = self._resolve_exit(self._get_exchange(), close_order, symbol, qty)
            pnl, pnl_pct, fees = compute_pnl(side, exit_qty, entry_price, exit_price, entry_fee, exit_fee)
            conn = self._get_db()
            try:
                cur = conn.cursor()
                cur.execute("""
                    UPDATE trades SET exit_price = %s, pnl_realised = %s, pnl_pct = %s, fees_paid = %s,
                        status = 'closed', closed_at = NOW(), close_reason = %s,
                        exchange_sl_order_id = NULL, exchange_tp_order_id = NULL
                    WHERE id = %s
                """, (round(exit_price, 8), round(pnl, 4), round(pnl_pct, 4), round(fees, 4), reason, trade_id))
                conn.commit()
                cur.close()
            finally:
                conn.close()
        except Exception as e:
            _log('CRITICAL', f'trade #{trade_id}: flattened on exchange but DB close not recorded ({e}); '
                             'row is still open with no stop — reconcile manually')

    # ── order helpers ────────────────────────────────────────────────────────

    @staticmethod
    def _sl_oid(base, tag=''):
        """KuCoin clientOid: <=40 chars, [A-Za-z0-9_-]."""
        return f'{str(base)[:28]}-sl{tag}'[:40]

    def _place_stop_loss_once(self, exchange, symbol, entry_side, quantity, sl_price, client_oid):
        close_side = close_side_for(entry_side)
        params = {'stopLossPrice': sl_price}   # ccxt maps to stop=loss (sell) / entry (buy) + stopPrice
        if client_oid:
            params['clientOid'] = client_oid
        order = exchange.create_order(symbol, 'market', close_side, quantity, None, params)
        _log('INFO', f'SL order placed: {order["id"]} @ stop={sl_price} ({close_side} {quantity})')
        return str(order['id'])

    def _place_stop_loss_retry(self, exchange, symbol, entry_side, quantity, sl_price, client_oid):
        """Place the SL with retry/backoff. Re-uses the same clientOid so a
        retry after an ambiguous failure cannot create a second order; if the
        order turns out to exist it is adopted. Raises on final failure."""
        last_err = None
        for attempt in range(len(SL_RETRY_DELAYS) + 1):
            try:
                return self._place_stop_loss_once(exchange, symbol, entry_side, quantity, sl_price, client_oid)
            except InsufficientFunds:
                raise   # retrying cannot help (balance reserved elsewhere / wrong qty)
            except Exception as e:
                last_err = e
                _log('WARN', f'SL placement attempt {attempt + 1} failed: {e}')
                if client_oid:
                    existing = self._fetch_by_client_oid(exchange, symbol, client_oid, stop=True)
                    if existing and existing.get('id') and existing.get('status') not in ('canceled', 'rejected'):
                        _log('WARN', f'SL with clientOid {client_oid} exists on exchange — adopting {existing["id"]}')
                        return str(existing['id'])
                if attempt < len(SL_RETRY_DELAYS):
                    time.sleep(SL_RETRY_DELAYS[attempt])
        raise RuntimeError(f'stop-loss placement failed after {len(SL_RETRY_DELAYS) + 1} attempts: {last_err}')

    def _market_close(self, exchange, symbol, entry_side, quantity, client_oid=None, attempts=3):
        """Market order in the closing direction, with retry. Returns the order."""
        close_side = close_side_for(entry_side)
        last_err = None
        for attempt in range(attempts):
            try:
                params = {'clientOid': f'{client_oid}{attempt}'[:40]} if client_oid else {}
                return exchange.create_order(symbol, 'market', close_side, quantity, None, params)
            except InsufficientFunds as e:
                raise RuntimeError(f'market close rejected: insufficient funds ({e})') from e
            except Exception as e:
                last_err = e
                _log('WARN', f'market close attempt {attempt + 1} failed: {e}')
                time.sleep(1.0 * (attempt + 1))
        raise RuntimeError(f'market close failed after {attempts} attempts: {last_err}')

    def _resolve_exit(self, exchange, order, symbol, fallback_qty):
        """(exit_price, exit_qty, exit_fee_quote) from a close order using real
        fills. Never returns 0: falls back to the ticker, else raises."""
        order = self._await_fill(exchange, order, symbol)
        price, filled = order_fill(order)
        if not price:
            price = order.get('price')
        if not price:
            try:
                price = float(exchange.fetch_ticker(symbol)['last'])
                _log('WARN', f'close order {order.get("id")} has no fill price — using ticker {price} as estimate')
            except Exception as e:
                raise RuntimeError(f'cannot determine exit price for order {order.get("id")}: {e}') from e
        price = float(price)
        if price <= 0:
            raise RuntimeError(f'invalid exit price {price} for order {order.get("id")}')
        qty = float(filled) if filled else float(fallback_qty)
        fee = fee_in_quote(order, symbol, price)
        if fee is None:
            fee = estimate_fee(qty, price)
            _log('WARN', f'no convertible exit fee for order {order.get("id")} — estimated {fee:.6f}')
        return price, qty, fee

    def _exit_order_state(self, exchange, symbol, order_id):
        """fetch_order for an exit (stop or limit) order. None if the exchange
        does not know it; raises for any other error (uncertainty must abort)."""
        stop_err = None
        for params in ({'stop': True}, {}):
            try:
                return exchange.fetch_order(order_id, symbol, params)
            except OrderNotFound:
                continue
            except Exception as e:
                if params:      # stop-endpoint quirks must not block the plain lookup
                    stop_err = e
                    _log('WARN', f'stop-order lookup of {order_id} errored ({e}); trying plain lookup')
                    continue
                raise
        if stop_err is not None:
            raise RuntimeError(f'order {order_id} state uncertain: {stop_err}') from stop_err
        return None

    def _cancel_checked(self, exchange, symbol, order_id):
        """Cancel an exit order. 'cancelled' | 'gone' (unknown to exchange =
        already filled/cancelled). Any OTHER error is raised, not swallowed."""
        if not order_id:
            return 'none'
        stop_err = None
        for params in ({'stop': True}, {}):
            try:
                exchange.cancel_order(order_id, symbol, params)
                _log('INFO', f'cancelled order {order_id}')
                return 'cancelled'
            except OrderNotFound:
                continue
            except Exception as e:
                if params:      # may just be the stop endpoint rejecting a non-stop id
                    stop_err = e
                    _log('WARN', f'stop-order cancel of {order_id} errored ({e}); trying plain cancel')
                    continue
                raise RuntimeError(f'cancel of order {order_id} failed: {e}') from e
        if stop_err is not None:
            raise RuntimeError(f'cancel of order {order_id} failed: {stop_err}') from stop_err
        _log('INFO', f'order {order_id} already gone on exchange (filled or cancelled)')
        return 'gone'

    # ── close ────────────────────────────────────────────────────────────────

    def close(self, trade_id, close_reason='position_review'):
        """Close a live trade. The trade row is locked (FOR UPDATE) for the whole
        operation so the monitor / a second request cannot double-close; an SL/TP
        that already filled is detected first and booked instead of closing again."""
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("SELECT * FROM trades WHERE id = %s FOR UPDATE", (trade_id,))
            trade = self._row_dict(cur)
            if not trade:
                raise ValueError(f'Trade {trade_id} not found')
            if trade['status'] != 'open':
                raise ValueError(f"Trade {trade_id} not open (status={trade['status']})")
            if trade.get('mode') != 'live':
                raise ValueError(f'Trade {trade_id} is not a live trade')

            exchange = self._get_exchange()
            symbol = trade['symbol'].replace('-', '/')
            side = trade['side']
            quantity = float(trade['quantity'])
            entry_price = float(trade['entry_price'])
            sl_id, tp_id = trade.get('exchange_sl_order_id'), trade.get('exchange_tp_order_id')

            # 1. Did an exit order already fill?
            filled = self._find_filled_exit(exchange, symbol, [(sl_id, 'sl_hit'), (tp_id, 'tp_hit')])
            if filled:
                order, reason, other_id = filled
                self._cancel_checked(exchange, symbol, other_id)
                result = self._book_close(cur, trade, order, reason, exchange)
                conn.commit()
                return result

            # 2. Cancel protective orders — errors are surfaced, never ignored.
            for oid in (sl_id, tp_id):
                self._cancel_checked(exchange, symbol, oid)

            # 3. Re-check: an order may have filled between the check and the cancel.
            filled = self._find_filled_exit(exchange, symbol, [(sl_id, 'sl_hit'), (tp_id, 'tp_hit')])
            if filled:
                order, reason, _ = filled
                result = self._book_close(cur, trade, order, reason, exchange)
                conn.commit()
                return result

            # 4. Market close.
            try:
                close_order = self._market_close(exchange, symbol, side, quantity,
                                                 self._sl_oid(trade.get('client_order_id') or f'g{trade_id}', 'c'))
            except Exception as close_err:
                _log('CRITICAL', f'trade #{trade_id}: market close failed after cancelling protection '
                                 f'({close_err}) — re-placing stop-loss')
                if trade.get('sl_price'):
                    try:
                        new_sl = self._place_stop_loss_retry(
                            exchange, symbol, side, quantity, float(trade['sl_price']),
                            self._sl_oid(trade.get('client_order_id') or f'g{trade_id}', str(int(time.time()))[-6:]))
                        cur.execute("UPDATE trades SET exchange_sl_order_id = %s, exchange_tp_order_id = NULL "
                                    "WHERE id = %s", (new_sl, trade_id))
                        conn.commit()
                    except Exception as sl_err:
                        _log('CRITICAL', f'trade #{trade_id}: could not re-place stop-loss ({sl_err}) — '
                                         'POSITION UNPROTECTED')
                raise
            try:
                result = self._book_close(cur, trade, close_order, close_reason, exchange)
                conn.commit()
            except Exception as book_err:
                conn.rollback()
                _log('CRITICAL', f"trade #{trade_id}: position CLOSED on exchange (order {close_order.get('id')}) "
                                 f'but DB booking failed ({book_err}) — row still says open, reconcile')
                raise LiveTradeError(f'Closed on exchange but booking failed: {book_err}',
                                     {'trade_id': trade_id, 'closed_on_exchange': True,
                                      'close_order_id': close_order.get('id')}) from book_err
            return result
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _find_filled_exit(self, exchange, symbol, candidates):
        """First (order, reason, other_order_id) whose exit order is fully filled."""
        for idx, (oid, reason) in enumerate(candidates):
            if not oid:
                continue
            order = self._exit_order_state(exchange, symbol, oid)
            if order and order.get('status') == 'closed':
                price, filled = order_fill(order)
                if filled:
                    other = candidates[1 - idx][0] if len(candidates) == 2 else None
                    return order, reason, other
        return None

    def _book_close(self, cur, trade, order, reason, exchange):
        """Compute P&L from REAL fills/fees and UPDATE the (already locked) row."""
        symbol = trade['symbol'].replace('-', '/')
        quantity = float(trade['quantity'])
        entry_price = float(trade['entry_price'])
        exit_price, exit_qty, exit_fee = self._resolve_exit(exchange, order, symbol, quantity)
        entry_fee = float(trade['entry_fee']) if trade.get('entry_fee') else estimate_fee(quantity, entry_price)
        pnl, pnl_pct, fees_paid = compute_pnl(trade['side'], exit_qty, entry_price, exit_price,
                                              entry_fee, exit_fee)
        cur.execute("""
            UPDATE trades SET
                exit_price = %s, pnl_realised = %s, pnl_pct = %s, fees_paid = %s,
                status = 'closed', closed_at = NOW(), close_reason = %s,
                exchange_sl_order_id = NULL, exchange_tp_order_id = NULL
            WHERE id = %s AND status = 'open'
        """, (round(exit_price, 8), round(pnl, 4), round(pnl_pct, 4), round(fees_paid, 4), reason, trade['id']))
        if cur.rowcount != 1:
            raise RuntimeError(f"trade {trade['id']} changed state during close")
        return {
            'trade_id': trade['id'],
            'symbol': trade['symbol'],
            'side': trade['side'],
            'entry_price': entry_price,
            'exit_price': round(exit_price, 8),
            'pnl': round(pnl, 4),
            'pnl_pct': round(pnl_pct, 4),
            'fees_paid': round(fees_paid, 4),
            'close_reason': reason,
            'mode': 'live',
        }

    def cancel_exchange_orders(self, trade):
        """Cancel SL and TP orders for a trade on the exchange; returns error strings."""
        exchange = self._get_exchange()
        symbol = trade['symbol'].replace('-', '/')
        errors = []
        for oid in (trade.get('exchange_sl_order_id'), trade.get('exchange_tp_order_id')):
            try:
                self._cancel_checked(exchange, symbol, oid)
            except Exception as e:
                errors.append(str(e))
        return errors

    # ── protection management ───────────────────────────────────────────────

    def _open_exit_orders(self, exchange, symbol):
        """All open orders for the symbol: regular + trigger (stop) orders."""
        orders = []
        for params in ({}, {'stop': True}):
            try:
                orders.extend(exchange.fetch_open_orders(symbol, None, None, params))
            except Exception as e:
                raise RuntimeError(f'fetch_open_orders({symbol}, {params}) failed: {e}') from e
        seen, unique = set(), []
        for o in orders:
            if o.get('id') not in seen:
                seen.add(o.get('id'))
                unique.append(o)
        return unique

    @staticmethod
    def _trigger_price(order):
        tp = order.get('triggerPrice') or order.get('stopPrice')
        if tp is None:
            tp = (order.get('info') or {}).get('stopPrice')
        try:
            return float(tp) if tp not in (None, '') else None
        except (TypeError, ValueError):
            return None

    def _match_open_sl(self, open_orders, trade):
        """Open stop order on the closing side whose trigger matches the SL (0.1%)."""
        close_side = close_side_for(trade['side'])
        sl = float(trade['sl_price'])
        for o in open_orders:
            trig = self._trigger_price(o)
            if o.get('side') == close_side and trig and abs(trig - sl) / sl < 0.001:
                return o
        return None

    def place_sl_tp(self, trade):
        """Crash recovery for ONE open live trade (idempotent). Only the SL leg
        is ever placed on the exchange (see module docstring); an existing
        matching open order is adopted instead of placing a duplicate.
        Returns {'sl_order_id','tp_order_id','action'}."""
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("SELECT * FROM trades WHERE id = %s FOR UPDATE", (trade['id'],))
            row = self._row_dict(cur)
            if not row or row['status'] != 'open' or row.get('mode') != 'live':
                conn.rollback()
                return {'sl_order_id': None, 'tp_order_id': None, 'action': 'skipped_not_open_live'}
            exchange = self._get_exchange()
            symbol = row['symbol'].replace('-', '/')
            sl_id, tp_id = row.get('exchange_sl_order_id'), row.get('exchange_tp_order_id')
            action = 'none_needed'
            if row.get('sl_price') and not sl_id:
                open_orders = self._open_exit_orders(exchange, symbol)
                match = self._match_open_sl(open_orders, row)
                if match:
                    sl_id, action = str(match['id']), 'adopted_existing_sl'
                    _log('INFO', f"recovery: trade #{row['id']} adopting open SL order {sl_id}")
                else:
                    base = row.get('client_order_id') or f"g{row['id']}"
                    sl_id = self._place_stop_loss_retry(
                        exchange, symbol, row['side'], float(row['quantity']), float(row['sl_price']),
                        self._sl_oid(base))
                    action = 'placed_sl'
                cur.execute("UPDATE trades SET exchange_sl_order_id = %s WHERE id = %s", (sl_id, row['id']))
            conn.commit()
            return {'sl_order_id': sl_id, 'tp_order_id': tp_id, 'action': action}
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def amend_stops(self, trade_id, sl_price=None, tp_price=None):
        """Tighten the stop and/or move the TP of an open live trade.
        New SL is placed BEFORE the old one is cancelled whenever the exchange
        allows it; on spot the old SL reserves the balance (InsufficientFunds),
        in which case we cancel-then-place and restore the old SL if the new
        one cannot be placed. TP is DB-only (monitor-driven); a legacy exchange
        TP order is cancelled."""
        conn = self._get_db()
        try:
            cur = conn.cursor()
            cur.execute("SELECT * FROM trades WHERE id = %s FOR UPDATE", (trade_id,))
            trade = self._row_dict(cur)
            if not trade:
                raise ValueError(f'Trade {trade_id} not found')
            if trade['status'] != 'open':
                raise ValueError(f"Trade {trade_id} not open (status={trade['status']})")
            if trade.get('mode') != 'live':
                raise ValueError(f'Trade {trade_id} is not a live trade')
            exchange = self._get_exchange()
            symbol = trade['symbol'].replace('-', '/')
            ref_price = float(exchange.fetch_ticker(symbol)['last'])
            err = validate_amend(trade['side'], trade.get('sl_price'), sl_price, tp_price, ref_price)
            if err:
                raise ValueError(err)

            old_sl_id = trade.get('exchange_sl_order_id')
            new_sl_id = old_sl_id
            quantity = float(trade['quantity'])
            base = trade.get('client_order_id') or f'g{trade_id}'
            changed_sl = sl_price is not None and (trade.get('sl_price') is None or
                                                   float(sl_price) != float(trade['sl_price']))
            if changed_sl:
                tag = str(int(time.time()))[-6:]
                oid = self._sl_oid(base, tag)
                try:
                    new_sl_id = self._place_stop_loss_retry(exchange, symbol, trade['side'], quantity,
                                                            float(sl_price), oid)
                    if old_sl_id:      # new is live; now retire the old one
                        try:
                            self._cancel_checked(exchange, symbol, old_sl_id)
                        except Exception as cancel_err:
                            _log('CRITICAL', f'trade #{trade_id}: new SL {new_sl_id} placed but old SL '
                                             f'{old_sl_id} cancel failed ({cancel_err}) — two stops live')
                except InsufficientFunds:
                    # Balance is reserved by the old stop: cancel first, then place.
                    new_sl_id = None
                    self._cancel_checked(exchange, symbol, old_sl_id)
                    try:
                        new_sl_id = self._place_stop_loss_retry(exchange, symbol, trade['side'], quantity,
                                                                float(sl_price), oid)
                    except Exception as place_err:
                        _log('CRITICAL', f'trade #{trade_id}: new SL failed after cancelling old ({place_err}) '
                                         '— restoring previous stop')
                        try:
                            restored = None
                            if trade.get('sl_price'):
                                restored = self._place_stop_loss_retry(
                                    exchange, symbol, trade['side'], quantity, float(trade['sl_price']),
                                    self._sl_oid(base, tag + 'r'))
                            cur.execute("UPDATE trades SET exchange_sl_order_id = %s WHERE id = %s",
                                        (restored, trade_id))
                            conn.commit()
                        except Exception as restore_err:
                            _log('CRITICAL', f'trade #{trade_id}: previous stop could not be restored '
                                             f'({restore_err}) — flattening')
                            flat = self._market_close(exchange, symbol, trade['side'], quantity,
                                                      self._sl_oid(base, 'x'))
                            self._book_close(cur, trade, flat, 'amend_failed_flatten', exchange)
                            conn.commit()
                            raise LiveTradeError('Amend failed and position was flattened',
                                                 {'trade_id': trade_id, 'flattened': True}) from restore_err
                        raise LiveTradeError(f'Amend failed, previous stop restored: {place_err}',
                                             {'trade_id': trade_id, 'flattened': False}) from place_err

            tp_id = trade.get('exchange_tp_order_id')
            if tp_price is not None and tp_id:
                self._cancel_checked(exchange, symbol, tp_id)
                tp_id = None
            cur.execute("""
                UPDATE trades SET sl_price = COALESCE(%s, sl_price), tp_price = COALESCE(%s, tp_price),
                    exchange_sl_order_id = %s, exchange_tp_order_id = %s
                WHERE id = %s
            """, (sl_price, tp_price, new_sl_id, tp_id, trade_id))
            conn.commit()
            return {'trade_id': trade_id, 'sl_price': sl_price if sl_price is not None else trade.get('sl_price'),
                    'tp_price': tp_price if tp_price is not None else trade.get('tp_price'),
                    'exchange_sl_order_id': new_sl_id, 'exchange_tp_order_id': tp_id, 'mode': 'live'}
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
