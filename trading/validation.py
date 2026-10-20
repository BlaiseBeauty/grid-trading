"""
Request validation for the engine's HTTP API. Pure functions (no Flask, DB or
network) so they can be unit-tested. Each validator returns (clean, error):
`clean` is a sanitised copy (numbers as floats) or None, `error` a message
suitable for a 400 response.
"""

import math
import os
import re

SYMBOL_RE = re.compile(r'^[A-Z0-9]{2,15}/[A-Z0-9]{2,10}$')
CLIENT_ORDER_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,36}$')   # KuCoin clientOid: <=40 chars incl. our suffixes
EXCHANGE_RE = re.compile(r'^[a-z0-9]{2,20}$')
VALID_SIDES = ('buy', 'sell')
VALID_MODES = ('paper', 'live')
VALID_TIMEFRAMES = ('1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w')


def allowed_symbols():
    """Optional explicit allowlist from ENGINE_ALLOWED_SYMBOLS="BTC/USDT,ETH/USDT".
    None => pattern validation only."""
    raw = os.environ.get('ENGINE_ALLOWED_SYMBOLS', '').strip()
    if not raw:
        return None
    return {s.strip().upper().replace('-', '/') for s in raw.split(',') if s.strip()}


def _num(value, name, required=True):
    """Finite float > 0 (bools and NaN/inf rejected). Returns (float|None, error)."""
    if value is None:
        return (None, f'{name} is required') if required else (None, None)
    if isinstance(value, bool):
        return None, f'{name} must be a number'
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None, f'{name} must be a number'
    if not math.isfinite(v) or v <= 0:
        return None, f'{name} must be a finite number > 0'
    return v, None


def validate_symbol(symbol, name='symbol'):
    if not isinstance(symbol, str):
        return None, f'{name} must be a string'
    s = symbol.strip().upper().replace('-', '/')
    if not SYMBOL_RE.match(s):
        return None, f'{name} {symbol!r} is not a valid pair like BTC/USDT'
    allow = allowed_symbols()
    if allow is not None and s not in allow:
        return None, f'{name} {s} is not in the allowed symbol list'
    return s, None


def validate_execute(data):
    if not isinstance(data, dict):
        return None, 'JSON object body required'
    clean = dict(data)

    mode = data.get('mode', 'paper')
    if mode not in VALID_MODES:
        return None, f"mode must be one of {list(VALID_MODES)}"
    clean['mode'] = mode

    sym, err = validate_symbol(data.get('symbol'))
    if err:
        return None, err
    clean['symbol'] = sym

    side = data.get('side')
    if not isinstance(side, str) or side.lower() not in VALID_SIDES:
        return None, f"side must be one of {list(VALID_SIDES)}"
    side = side.lower()
    clean['side'] = side

    for key in ('quantity', 'entry_price'):
        v, err = _num(data.get(key), key)
        if err:
            return None, err
        clean[key] = v

    for key in ('tp_price', 'sl_price'):
        v, err = _num(data.get(key), key, required=False)
        if err:
            return None, err
        clean[key] = v

    entry, sl, tp = clean['entry_price'], clean['sl_price'], clean['tp_price']
    if sl is not None and ((side == 'buy' and sl >= entry) or (side == 'sell' and sl <= entry)):
        return None, f'sl_price {sl} is on the wrong side of entry_price {entry} for a {side}'
    if tp is not None and ((side == 'buy' and tp <= entry) or (side == 'sell' and tp >= entry)):
        return None, f'tp_price {tp} is on the wrong side of entry_price {entry} for a {side}'

    coid = data.get('client_order_id')
    if coid is not None:
        if not isinstance(coid, str) or not CLIENT_ORDER_ID_RE.match(coid):
            return None, 'client_order_id must match [A-Za-z0-9_-]{1,36}'
    clean['client_order_id'] = coid
    return clean, None


def validate_trade_id(value):
    if isinstance(value, bool):
        return None, 'trade_id must be a positive integer'
    try:
        tid = int(value)
    except (TypeError, ValueError):
        return None, 'trade_id must be a positive integer'
    if tid <= 0 or (isinstance(value, float) and value != tid):
        return None, 'trade_id must be a positive integer'
    return tid, None


def validate_close(data):
    if not isinstance(data, dict):
        return None, 'JSON object body required'
    tid, err = validate_trade_id(data.get('trade_id'))
    if err:
        return None, err
    mode = data.get('mode')
    if mode is not None and mode not in VALID_MODES:
        return None, f"mode must be one of {list(VALID_MODES)}"
    return {'trade_id': tid, 'mode': mode}, None


def validate_amend(data):
    if not isinstance(data, dict):
        return None, 'JSON object body required'
    tid, err = validate_trade_id(data.get('trade_id'))
    if err:
        return None, err
    sl, err = _num(data.get('sl_price'), 'sl_price', required=False)
    if err:
        return None, err
    tp, err = _num(data.get('tp_price'), 'tp_price', required=False)
    if err:
        return None, err
    if sl is None and tp is None:
        return None, 'sl_price or tp_price required'
    return {'trade_id': tid, 'sl_price': sl, 'tp_price': tp}, None


def validate_fetch_ohlcv(data, min_limit=250, max_limit=1000):
    if not isinstance(data, dict):
        return None, 'JSON object body required'
    sym, err = validate_symbol(data.get('symbol', 'BTC/USDT'))
    if err:
        return None, err
    tf = data.get('timeframe', '4h')
    if tf not in VALID_TIMEFRAMES:
        return None, f'timeframe must be one of {list(VALID_TIMEFRAMES)}'
    limit = data.get('limit', min_limit)
    if isinstance(limit, bool) or not isinstance(limit, (int, float)) or not math.isfinite(limit):
        return None, 'limit must be an integer'
    limit = max(min_limit, min(int(limit), max_limit))   # SMA(200) needs >= 200 closed candles
    exchange = data.get('exchange')
    if exchange is not None and (not isinstance(exchange, str) or not EXCHANGE_RE.match(exchange)):
        return None, 'exchange must be a lowercase ccxt id'
    return {'symbol': sym, 'timeframe': tf, 'limit': limit, 'exchange': exchange}, None
