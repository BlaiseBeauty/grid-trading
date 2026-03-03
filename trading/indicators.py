"""
Technical Indicator Library — pure pandas/numpy implementation.
Computes indicators needed by the 8 knowledge agents.
"""

import numpy as np
import pandas as pd


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
    low14 = l.rolling(14).min()
    high14 = h.rolling(14).max()
    stoch_denom = (high14 - low14).replace(0, np.nan)
    stoch_k = 100 * (c - low14) / stoch_denom
    stoch_d = stoch_k.rolling(3).mean()
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
    sma20 = c.rolling(20).mean()
    std20 = c.rolling(20).std()
    results['bb_upper'] = _last(sma20 + 2 * std20)
    results['bb_mid'] = _last(sma20)
    results['bb_lower'] = _last(sma20 - 2 * std20)
    bb_width = (sma20 + 2 * std20 - (sma20 - 2 * std20)) / sma20
    results['bb_bandwidth'] = _last(bb_width)
    bb_pct = (c - (sma20 - 2 * std20)) / (4 * std20)
    results['bb_pct'] = _last(bb_pct)

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

    # Current price
    results['current_price'] = float(c.iloc[-1])

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
    tr1 = high - low
    tr2 = abs(high - close.shift(1))
    tr3 = abs(low - close.shift(1))
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def _adx(high, low, close, period=14):
    up = high.diff()
    down = -low.diff()
    plus_dm = np.where((up > down) & (up > 0), up, 0)
    minus_dm = np.where((down > up) & (down > 0), down, 0)

    atr = _atr(high, low, close, period)
    plus_di = 100 * pd.Series(plus_dm).rolling(period).mean() / atr
    minus_di = 100 * pd.Series(minus_dm).rolling(period).mean() / atr
    di_sum = (plus_di + minus_di).replace(0, np.nan)
    dx = 100 * abs(plus_di - minus_di) / di_sum
    adx = dx.rolling(period).mean()

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
