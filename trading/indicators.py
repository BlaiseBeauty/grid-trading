"""
Technical Indicator Library — pure pandas/numpy implementation.
Computes indicators needed by the 8 knowledge agents.
"""

import numpy as np
import pandas as pd

import indicator_core as core

# Closed candles required before the SMA(200) etc. are meaningful. Callers
# should fetch at least this many (plus one forming candle).
MIN_CANDLES_FULL = 250


def compute_indicators(df):
    """Compute a comprehensive set of indicators and return as dict."""
    if df is None or len(df) < 20:
        return {'error': f'Insufficient data: {len(df) if df is not None else 0} candles (need 20+)'}
    results = {}
    c = df['close'].astype(float)
    h = df['high'].astype(float)
    l = df['low'].astype(float)
    v = df['volume'].astype(float)

    # --- Trend ---
    results['sma_20'] = _last(c.rolling(20).mean())
    results['sma_50'] = _last(c.rolling(50).mean())
    results['sma_200'] = _last(c.rolling(200).mean())
    results['ema_12'] = _last(c.ewm(span=12, adjust=False).mean())
    results['ema_26'] = _last(c.ewm(span=26, adjust=False).mean())

    # ADX
    adx_vals = _adx(h, l, c, 14)
    results.update(adx_vals)

    # --- Momentum ---
    results['rsi_14'] = _last(_rsi(c, 14))

    # MACD
    ema12 = c.ewm(span=12, adjust=False).mean()
    ema26 = c.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    macd_signal = macd_line.ewm(span=9, adjust=False).mean()
    results['macd'] = _last(macd_line)
    results['macd_signal'] = _last(macd_signal)
    results['macd_histogram'] = _last(macd_line - macd_signal)

    # Stochastic
    stoch_k, stoch_d = core.stochastic(h, l, c, 14, 3)
    results['stoch_k'] = _last(stoch_k)
    results['stoch_d'] = _last(stoch_d)

    # CCI
    tp = (h + l + c) / 3
    sma_tp = tp.rolling(20).mean()
    mad = tp.rolling(20).apply(lambda x: np.mean(np.abs(x - x.mean())), raw=True)
    cci = (tp - sma_tp) / (0.015 * mad)
    results['cci'] = _last(cci)

    # Williams %R
    high14 = h.rolling(14).max()
    low14 = l.rolling(14).min()
    willr_denom = (high14 - low14).replace(0, np.nan)
    willr = -100 * (high14 - c) / willr_denom
    results['willr'] = _last(willr)

    # ROC
    results['roc'] = _last(100 * (c / c.shift(12) - 1))

    # --- Volatility ---
    # Bollinger Bands
    bb_mid, bb_up, bb_lo, bb_width, bb_pct = core.bollinger(c, 20, 2.0)
    results['bb_upper'] = _last(bb_up)
    results['bb_mid'] = _last(bb_mid)
    results['bb_lower'] = _last(bb_lo)
    results['bb_bandwidth'] = _last(bb_width)   # ratio (upper-lower)/mid
    results['bb_pct'] = _last(bb_pct)           # %B in 0..1 (can exceed)

    # ATR
    atr = _atr(h, l, c, 14)
    results['atr_14'] = _last(atr)

    # --- Volume ---
    # OBV
    obv = (np.sign(c.diff()) * v).fillna(0).cumsum()
    results['obv'] = _last(obv)

    # MFI
    results['mfi'] = _last(_mfi(h, l, c, v, 14))

    # Volume SMA
    results['volume_sma_20'] = _last(v.rolling(20).mean())
    if results['volume_sma_20'] and results['volume_sma_20'] > 0:
        results['volume_ratio'] = float(v.iloc[-1]) / results['volume_sma_20']
    else:
        results['volume_ratio'] = None

    # Current price (last CLOSED candle's close — callers drop the forming candle)
    results['current_price'] = float(c.iloc[-1])

    # Enforce minimum history per indicator: anything computed on too few
    # closed candles is withheld (None -> key dropped) instead of reported
    # as if it were converged/valid.
    n = len(df)
    groups = {
        'sma_20': ['sma_20'], 'sma_50': ['sma_50'], 'sma_200': ['sma_200'],
        'ema_12': ['ema_12'], 'ema_26': ['ema_26'],
        'rsi_14': ['rsi_14'], 'atr_14': ['atr_14'],
        'adx': ['adx', 'dmp', 'dmn'],
        'macd': ['macd', 'macd_signal', 'macd_histogram'],
        'stoch': ['stoch_k', 'stoch_d'], 'cci': ['cci'], 'willr': ['willr'],
        'roc': ['roc'], 'mfi': ['mfi'],
        'bb': ['bb_upper', 'bb_mid', 'bb_lower', 'bb_bandwidth', 'bb_pct'],
        'volume_sma_20': ['volume_sma_20', 'volume_ratio'],
    }
    for name, keys in groups.items():
        if n < core.WARMUP_BARS.get(name, 0):
            for k in keys:
                results[k] = None

    # Clean
    return {k: round(v, 8) if isinstance(v, float) else v
            for k, v in results.items() if v is not None}


def _rsi(series, period=14):
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def _atr(high, low, close, period=14):
    """ATR with Wilder smoothing (shared with the backtester)."""
    return core.atr(high, low, close, period)


def _adx(high, low, close, period=14):
    """ADX / +DI / -DI with Wilder smoothing (shared with the backtester)."""
    plus_di, minus_di, adx = core.adx_components(high, low, close, period)
    return {
        'adx': _last(adx),
        'dmp': _last(plus_di),
        'dmn': _last(minus_di),
    }


def _mfi(high, low, close, volume, period=14):
    tp = (high + low + close) / 3
    mf = tp * volume
    pos_mf = mf.where(tp > tp.shift(1), 0).rolling(period).sum()
    neg_mf = mf.where(tp < tp.shift(1), 0).rolling(period).sum()
    neg_mf_safe = neg_mf.replace(0, np.nan)
    mfi = 100 - (100 / (1 + pos_mf / neg_mf_safe))
    return mfi


def _last(series):
    if series is None or (isinstance(series, pd.Series) and series.empty):
        return None
    if isinstance(series, pd.Series):
        val = series.iloc[-1]
        if pd.isna(val) or np.isinf(val):
            return None
        return float(val)
    if isinstance(series, (int, float)):
        if np.isnan(series) or np.isinf(series):
            return None
        return float(series)
    return None
