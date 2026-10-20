"""
Shared helpers for paper.py / live.py / monitor.py (fees, fills, P&L,
authenticated exchange). Kept dependency-light so the pure functions can be
unit-tested without a DB or network.
"""

import math
import os
import threading

import psycopg2

PRIMARY_EXCHANGE = os.getenv('CCXT_EXCHANGE', 'kucoin')
TAKER_FEE = 0.001        # 0.10% — used ONLY when the exchange reports no fee
SLIPPAGE_BPS = 5         # simulated adverse slippage for paper fills / simulated stops

_exchange_lock = threading.Lock()
_auth_exchange = None


def get_db(db_url=None):
    return psycopg2.connect(db_url or os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid'))


def get_authenticated_exchange(load_markets=True):
    """Process-wide authenticated ccxt instance (shared by LiveTrader and
    PositionMonitor). Returns None when CCXT_API_KEY is not configured."""
    global _auth_exchange
    if _auth_exchange is not None:
        return _auth_exchange
    api_key = os.environ.get('CCXT_API_KEY')
    if not api_key:
        return None
    import ccxt  # local import keeps pure helpers importable without ccxt
    with _exchange_lock:
        if _auth_exchange is not None:
            return _auth_exchange
        config = {
            'apiKey': api_key,
            'secret': os.environ['CCXT_API_SECRET'],
            'enableRateLimit': True,
        }
        if PRIMARY_EXCHANGE == 'kucoin':
            config['password'] = os.environ.get('CCXT_API_PASSPHRASE', '')
        ex = getattr(ccxt, PRIMARY_EXCHANGE)(config)
        if load_markets:
            ex.load_markets()
        _auth_exchange = ex
        return ex


def is_finite_positive(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return False
    return math.isfinite(v) and v > 0


def close_side_for(entry_side):
    return 'sell' if entry_side == 'buy' else 'buy'


def apply_slippage(side, price, bps=SLIPPAGE_BPS):
    """Adverse slippage: a BUY fills higher, a SELL fills lower."""
    f = bps / 10000.0
    return price * (1 + f) if side == 'buy' else price * (1 - f)


def order_fill(order):
    """(average_fill_price | None, filled_qty | None) from a ccxt order."""
    if not order:
        return None, None
    filled = order.get('filled')
    price = order.get('average')
    if not price and order.get('cost') and filled:
        price = float(order['cost']) / float(filled)
    try:
        price = float(price) if price else None
        filled = float(filled) if filled else None
    except (TypeError, ValueError):
        return None, None
    return price, filled


def fee_in_quote(order, symbol, fill_price):
    """Total fee of a ccxt order expressed in the QUOTE currency, or None when
    the exchange did not report one we can convert (caller then estimates)."""
    if not order:
        return None
    fees = order.get('fees') or ([order['fee']] if order.get('fee') else [])
    if not fees:
        return None
    base, _, quote = symbol.partition('/')
    total = 0.0
    for f in fees:
        if not f or f.get('cost') is None:
            continue
        cur = (f.get('currency') or '').upper()
        cost = float(f['cost'])
        if cur == quote.upper():
            total += cost
        elif cur == base.upper() and fill_price:
            total += cost * fill_price
        else:
            return None  # e.g. fee paid in KCS — cannot convert without a rate
    return total


def fee_in_base(order, symbol):
    """Fee that was paid in the BASE currency (reduces the sellable quantity)."""
    if not order:
        return 0.0
    base = symbol.split('/')[0].upper()
    fees = order.get('fees') or ([order['fee']] if order.get('fee') else [])
    return sum(float(f['cost']) for f in fees
               if f and f.get('cost') is not None and (f.get('currency') or '').upper() == base)


def compute_pnl(side, quantity, entry_price, exit_price, entry_fee, exit_fee):
    """Net P&L from REAL fills and fees.
    Returns (pnl_net, pnl_pct_of_notional, total_fees)."""
    if side == 'buy':
        gross = (exit_price - entry_price) * quantity
    else:
        gross = (entry_price - exit_price) * quantity
    fees = entry_fee + exit_fee
    net = gross - fees
    notional = quantity * entry_price
    pct = (net / notional) * 100 if notional else 0.0
    return net, pct, fees


def validate_amend(side, old_sl, new_sl, new_tp, ref_price=None):
    """Validate an SL/TP amendment. Returns an error string or None.

    Rules: new_sl may only TIGHTEN (buy: higher; sell: lower); SL must sit on
    the loss side and TP on the profit side of each other (and of ref_price
    when given); at least one of new_sl/new_tp must be supplied."""
    if new_sl is None and new_tp is None:
        return 'sl_price or tp_price required'
    for name, v in (('sl_price', new_sl), ('tp_price', new_tp)):
        if v is not None and not is_finite_positive(v):
            return f'{name} must be a finite number > 0'
    if side not in ('buy', 'sell'):
        return f'invalid trade side {side!r}'
    if new_sl is not None and old_sl is not None:
        o, n = float(old_sl), float(new_sl)
        if (side == 'buy' and n < o) or (side == 'sell' and n > o):
            return f'sl_price may only tighten (old {o}, new {n}, side {side})'
    if new_sl is not None and new_tp is not None:
        if (side == 'buy' and not float(new_sl) < float(new_tp)) or \
           (side == 'sell' and not float(new_sl) > float(new_tp)):
            return 'sl_price and tp_price are on the wrong sides of each other for this direction'
    if ref_price:
        if new_sl is not None and ((side == 'buy' and float(new_sl) >= ref_price) or
                                   (side == 'sell' and float(new_sl) <= ref_price)):
            return f'sl_price {new_sl} would trigger immediately at market {ref_price}'
        if new_tp is not None and ((side == 'buy' and float(new_tp) <= ref_price) or
                                   (side == 'sell' and float(new_tp) >= ref_price)):
            return f'tp_price {new_tp} is already through market {ref_price}'
    return None


def estimate_fee(quantity, price):
    return quantity * price * TAKER_FEE
