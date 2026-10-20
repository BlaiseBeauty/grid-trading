"""
Position Monitor — checks TP/SL on open positions.

Paper / micro trades: polls prices AND recent candle highs/lows (so an
intra-poll wick through a level is not missed) and closes in the DB.
Live trades: NEVER closed DB-only. The monitor
  * reconciles the exchange stop-loss order (booked with real fills when it filled),
  * places a missing stop-loss (or market-closes if price is already through it),
  * enforces the take-profit itself (TP is not an exchange order on spot — see
    live.py) by calling LiveTrader.close(), which cancels the SL and market-closes.
Each trade is processed and committed independently so one failure cannot roll
back or abort the others.
"""

import os
import time

from data import MarketData
from live import LiveTrader
from common import (
    TAKER_FEE, SLIPPAGE_BPS, get_db, get_authenticated_exchange,
    apply_slippage, close_side_for, compute_pnl, estimate_fee,
)

CANDLE_TF = os.getenv('MONITOR_CANDLE_TF', '5m')
CANDLE_LIMIT = int(os.getenv('MONITOR_CANDLE_LIMIT', '12'))   # 12 x 5m = 1h lookback > 15-min cron


def _log(msg):
    print(f'[MONITOR] {msg}', flush=True)


def _effective_stop(buy, sl, peak, activated, trail_dist_pct):
    """Tightest of the initial SL and the trailing level.
    Returns (level, kind) or (None, None). A trail can therefore never sit
    looser than the original stop."""
    cands = []
    if sl is not None:
        cands.append((float(sl), 'sl_hit'))
    if activated and peak:
        lvl = peak * (1 - trail_dist_pct / 100) if buy else peak * (1 + trail_dist_pct / 100)
        cands.append((lvl, 'trail_hit'))
    if not cands:
        return None, None
    # tighter = higher for longs, lower for shorts; ties prefer the SL label
    key = (lambda c: c[0]) if buy else (lambda c: -c[0])
    best = max(cands, key=lambda c: (key(c), 1 if c[1] == 'sl_hit' else 0))
    return best


def evaluate_exit(side, entry, sl, tp, peak, activated, bars, price,
                  trail_activate_pct, trail_distance_pct, slippage_bps=SLIPPAGE_BPS):
    """Replay candles then the latest price against SL / trail / TP.

    bars: chronological (open, high, low, close) tuples since entry.
    Conservative intra-bar rules: within one bar the stop is tested before the
    TP, and the peak used for the trail is the peak BEFORE that bar (a bar's own
    high cannot trigger its own trail). Stops fill at the worse of the level and
    the bar open (gap) with adverse slippage; TP fills at the level (or the open
    if it gapped through).
    Returns {'action': None|'sl_hit'|'trail_hit'|'tp_hit', 'exit_price', 'peak', 'activated'}.
    Pure function (no I/O)."""
    buy = side == 'buy'
    entry = float(entry)
    tp = float(tp) if tp is not None else None
    peak = float(peak) if peak else entry
    activated = bool(activated)
    close_side = close_side_for(side)

    seq = list(bars) + [(price, price, price, price)]
    for (o, h, l, c) in seq:
        stop, kind = _effective_stop(buy, sl, peak, activated, trail_distance_pct)
        if stop is not None and ((l <= stop) if buy else (h >= stop)):
            level = min(stop, o) if buy else max(stop, o)       # gap through the stop
            return {'action': kind, 'exit_price': apply_slippage(close_side, level, slippage_bps),
                    'peak': peak, 'activated': activated}
        if tp is not None and ((h >= tp) if buy else (l <= tp)):
            fill = max(tp, o) if buy else min(tp, o)            # limit fills at level or better
            return {'action': 'tp_hit', 'exit_price': fill, 'peak': peak, 'activated': activated}
        fav = h if buy else l
        peak = max(peak, fav) if buy else min(peak, fav)
        profit_pct = ((fav - entry) / entry if buy else (entry - fav) / entry) * 100
        if profit_pct >= trail_activate_pct:
            activated = True
    return {'action': None, 'exit_price': None, 'peak': peak, 'activated': activated}


class PositionMonitor:
    TAKER_FEE = TAKER_FEE  # 0.10% — shared with PaperTrader via common.py

    # Trailing stop config
    TRAIL_ACTIVATE_PCT = 1.0   # profit % required before trailing starts
    TRAIL_DISTANCE_PCT = 2.0   # % drop from peak that triggers close

    def __init__(self):
        self.db_url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid')
        self.market_data = MarketData()
        self.live = LiveTrader()
        self._validate_trail_params()

    def _validate_trail_params(self):
        """The effective stop is max(initial SL, trail level), so a trail exit is
        never looser than the original stop. With the current parameters the
        trail level at activation (peak*(1-2%) = entry*0.9898) is still BELOW
        entry, i.e. a trail exit shortly after activation can be a small net
        loss; that is intentional ('keep current params') but flagged here."""
        if self.TRAIL_DISTANCE_PCT <= 0 or self.TRAIL_ACTIVATE_PCT <= 0:
            raise ValueError('trail parameters must be > 0')
        if self.TRAIL_DISTANCE_PCT >= self.TRAIL_ACTIVATE_PCT:
            _log(f'NOTE trail distance {self.TRAIL_DISTANCE_PCT}% >= activation {self.TRAIL_ACTIVATE_PCT}%: '
                 'an early trail exit can be below entry (still never worse than the initial SL).')

    def _get_db(self):
        return get_db(self.db_url)

    # ── main loop ────────────────────────────────────────────────────────────

    def check_all(self):
        """Check all open positions. Every trade runs in its own transaction."""
        conn = self._get_db()
        results = []
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT id, symbol, side, quantity, entry_price, tp_price, sl_price,
                       exchange, entry_fee, mode,
                       exchange_sl_order_id, exchange_tp_order_id,
                       peak_price, trail_activated, opened_at
                FROM trades
                WHERE status = 'open'
            """)
            cols = [d[0] for d in cur.description]
            trades = [dict(zip(cols, r)) for r in cur.fetchall()]
            conn.commit()

            prices = self._batch_prices(trades)
            candle_cache = {}

            for trade in trades:
                tid = trade['id']
                try:
                    result = self._check_trade(conn, cur, trade, prices, candle_cache)
                    conn.commit()
                    results.append(result)
                except Exception as e:
                    conn.rollback()
                    _log(f"ERROR trade #{tid} ({trade['symbol']}): {e} — continuing with remaining trades")
                    results.append({'trade_id': tid, 'error': str(e)})
            cur.close()
        finally:
            conn.close()
        return results

    def _batch_prices(self, trades):
        """One fetch_tickers call per exchange instead of serial fetch+sleep."""
        by_exchange = {}
        for t in trades:
            by_exchange.setdefault(t['exchange'] or None, set()).add(t['symbol'].replace('-', '/'))
        prices = {}
        for exch, syms in by_exchange.items():
            prices.update(self.market_data.get_prices(list(syms), exch))
        return prices

    def _bars_since_open(self, trade, candle_cache):
        """(o,h,l,c) of candles that opened at/after the trade's open time."""
        symbol = trade['symbol'].replace('-', '/')
        key = (symbol, trade['exchange'])
        if key not in candle_cache:
            try:
                candle_cache[key] = self.market_data.fetch_ohlcv(
                    symbol, CANDLE_TF, CANDLE_LIMIT, trade['exchange'] or None) or []
            except Exception as e:
                _log(f'candle fetch failed for {symbol} ({e}) — falling back to last price only')
                candle_cache[key] = []
        opened = trade.get('opened_at')
        opened_ms = int(opened.timestamp() * 1000) if opened else 0
        return [(float(c[1]), float(c[2]), float(c[3]), float(c[4]))
                for c in candle_cache[key] if c[0] >= opened_ms and None not in c[1:5]]

    def _check_trade(self, conn, cur, trade, prices, candle_cache):
        symbol = trade['symbol'].replace('-', '/')
        tid = trade['id']
        price = prices.get(symbol)
        if price is None:
            _log(f'SKIPPING trade #{tid} ({symbol}) — no price available')
            return {'trade_id': tid, 'error': f'no price for {symbol}'}
        if not trade['entry_price'] or float(trade['entry_price']) <= 0:
            return {'trade_id': tid, 'error': f"Invalid entry_price: {trade['entry_price']}"}
        bars = self._bars_since_open(trade, candle_cache)
        if trade['mode'] == 'live':
            return self._check_live_trade(conn, cur, trade, price, bars)
        return self._check_paper_trade(cur, trade, price, bars)

    # ── paper / micro ────────────────────────────────────────────────────────

    def _check_paper_trade(self, cur, trade, current_price, bars):
        """Candle + price polling with trailing stop. DB-only close (paper)."""
        tid, symbol, side = trade['id'], trade['symbol'], trade['side']
        entry = float(trade['entry_price'])
        quantity = float(trade['quantity'])

        ev = evaluate_exit(side, entry, trade['sl_price'], trade['tp_price'],
                           trade['peak_price'], trade['trail_activated'], bars, current_price,
                           self.TRAIL_ACTIVATE_PCT, self.TRAIL_DISTANCE_PCT)

        # Persist peak / activation (best effort: a failure rolls back to the
        # savepoint only, it can never poison the close below).
        old_peak = float(trade['peak_price']) if trade['peak_price'] else None
        if ev['peak'] != old_peak or ev['activated'] != bool(trade['trail_activated']):
            cur.execute('SAVEPOINT peak_update')
            try:
                cur.execute("UPDATE trades SET peak_price = %s, trail_activated = %s "
                            "WHERE id = %s AND status = 'open'", (ev['peak'], ev['activated'], tid))
                cur.execute('RELEASE SAVEPOINT peak_update')
            except Exception as e:
                cur.execute('ROLLBACK TO SAVEPOINT peak_update')
                _log(f'Failed to update peak for trade #{tid}: {e}')

        action = ev['action']
        if not action:
            pnl_pct = ((current_price - entry) / entry if side == 'buy' else (entry - current_price) / entry) * 100
            return {'trade_id': tid, 'action': 'holding', 'current_price': current_price,
                    'pnl_pct': round(pnl_pct, 4)}

        exit_price = ev['exit_price']
        ef = float(trade['entry_fee']) if trade['entry_fee'] else estimate_fee(quantity, entry)
        pnl, pnl_pct, fees_paid = compute_pnl(side, quantity, entry, exit_price, ef,
                                              quantity * exit_price * self.TAKER_FEE)
        cur.execute("""
            UPDATE trades SET
                exit_price = %s, pnl_realised = %s, pnl_pct = %s, fees_paid = %s,
                status = 'closed', closed_at = NOW(), close_reason = %s
            WHERE id = %s AND status = 'open'
            RETURNING id
        """, (round(exit_price, 8), round(pnl, 4), round(pnl_pct, 4), round(fees_paid, 4), action, tid))
        if not cur.fetchone():
            _log(f'Trade #{tid} already closed by another process — skipping')
            return {'trade_id': tid, 'action': 'already_closed'}

        _log(f'{action.upper()} — trade #{tid} {symbol} {side} closed @ {exit_price} '
             f'(P&L: {round(pnl_pct, 2)}%, fees: {round(fees_paid, 4)})')
        return {'trade_id': tid, 'action': action, 'exit_price': exit_price,
                'pnl_realised': round(pnl, 4), 'pnl_pct': round(pnl_pct, 4),
                'fees_paid': round(fees_paid, 4)}

    # ── live ─────────────────────────────────────────────────────────────────

    def _check_live_trade(self, conn, cur, trade, price, bars):
        """Reconcile / protect / TP-enforce a live trade. Never DB-only closes."""
        tid, symbol, side = trade['id'], trade['symbol'].replace('-', '/'), trade['side']
        entry = float(trade['entry_price'])
        exchange = get_authenticated_exchange()
        if exchange is None:
            _log(f'ALERT live trade #{tid} cannot be managed: no exchange credentials — NOT closing DB-only')
            return {'trade_id': tid, 'action': 'error', 'mode': 'live', 'alert': True,
                    'error': 'no exchange credentials; live trade left untouched'}

        sl_id, tp_id = trade['exchange_sl_order_id'], trade['exchange_tp_order_id']
        sl_price = float(trade['sl_price']) if trade['sl_price'] else None
        tp_price = float(trade['tp_price']) if trade['tp_price'] else None

        # 1. Did an exchange exit order fill? (SL first — worst case wins ties)
        for oid, reason, other in ((sl_id, 'sl_hit', tp_id), (tp_id, 'tp_hit', sl_id)):
            if not oid:
                continue
            try:
                order = self.live._exit_order_state(exchange, symbol, oid)
            except Exception as e:
                _log(f'Failed to fetch exit order {oid} for trade #{tid}: {e}')
                continue
            if order and order.get('status') == 'closed' and (order.get('filled') or 0) > 0:
                if other:
                    try:
                        self.live._cancel_checked(exchange, symbol, other)
                    except Exception as e:
                        _log(f'ALERT cancel of opposite order {other} failed for trade #{tid}: {e}')
                result = self.live._book_close(cur, trade, order, reason, exchange)
                _log(f"{reason.upper()} — live trade #{tid} {symbol} {side} closed @ {result['exit_price']} "
                     f"(P&L: {result['pnl_pct']}%, fees: {result['fees_paid']})")
                return {'trade_id': tid, 'action': reason, 'exit_price': result['exit_price'],
                        'pnl_realised': result['pnl'], 'pnl_pct': result['pnl_pct'],
                        'fees_paid': result['fees_paid'], 'mode': 'live'}

        # 2. Monitor-driven TP (no exchange TP order on spot) and SL-through detection.
        ev = evaluate_exit(side, entry, sl_price, tp_price if not tp_id else None, None, False, bars, price,
                           float('inf'), self.TRAIL_DISTANCE_PCT)
        conn.commit()   # release any row locks: LiveTrader opens its own connection + FOR UPDATE

        if ev['action'] == 'tp_hit':
            _log(f'TP level reached for live trade #{tid} {symbol} — market-closing via exchange')
            res = self.live.close(tid, close_reason='tp_hit')
            return {'trade_id': tid, 'action': 'tp_hit', 'exit_price': res['exit_price'],
                    'pnl_realised': res['pnl'], 'pnl_pct': res['pnl_pct'],
                    'fees_paid': res['fees_paid'], 'mode': 'live'}

        # 3. Missing stop-loss: protect or close — never leave it bare.
        if sl_price and not sl_id:
            if ev['action'] in ('sl_hit', 'trail_hit'):
                _log(f'ALERT live trade #{tid} has no SL order and price is through {sl_price} — market-closing')
                res = self.live.close(tid, close_reason='sl_hit')
                return {'trade_id': tid, 'action': 'sl_hit', 'exit_price': res['exit_price'],
                        'pnl_realised': res['pnl'], 'pnl_pct': res['pnl_pct'],
                        'fees_paid': res['fees_paid'], 'mode': 'live'}
            try:
                placed = self.live.place_sl_tp(trade)
                _log(f"live trade #{tid} lacked an SL order — recovery: {placed['action']} {placed['sl_order_id']}")
                return {'trade_id': tid, 'action': 'sl_recovered', 'mode': 'live', 'alert': True, **placed}
            except Exception as e:
                _log(f'ALERT live trade #{tid} UNPROTECTED — could not place stop-loss: {e}')
                return {'trade_id': tid, 'action': 'unprotected', 'mode': 'live', 'alert': True,
                        'error': str(e)}
        if not sl_price and not sl_id:
            _log(f'NOTE live trade #{tid} has no sl_price at all (no stop by design)')

        # 4. SL order exists but price is through it and it has not filled.
        alert = False
        if sl_id and ev['action'] == 'sl_hit':
            alert = True
            _log(f'ALERT live trade #{tid}: price {price} through SL {sl_price} but SL order {sl_id} not filled')

        pnl_pct = ((price - entry) / entry if side == 'buy' else (entry - price) / entry) * 100
        out = {'trade_id': tid, 'action': 'holding', 'current_price': price,
               'pnl_pct': round(pnl_pct, 4), 'mode': 'live'}
        if alert:
            out['alert'] = True
        return out
