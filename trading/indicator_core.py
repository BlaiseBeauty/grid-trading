"""
Shared indicator implementations — ONE definition used by both the live
engine (indicators.py) and the backtester (backtest_signals.py), so that
thresholds in strategy templates mean the same thing in both places.

Smoothing convention: Wilder (RMA, alpha = 1/period) for ATR, +DM/-DM and ADX.
Note: pandas ewm(adjust=False) seeds with the first observation rather than
the textbook SMA seed; the difference decays within ~3x period bars, which is
why consumers enforce a warm-up (see WARMUP_BARS).
"""

import numpy as np
import pandas as pd


# Minimum closed candles before an indicator is considered valid.
# Wilder/EMA based indicators need ~3x their period to forget the seed.
WARMUP_BARS = {
    'sma_20': 20, 'sma_50': 50, 'sma_200': 200,
    'ema_12': 36, 'ema_26': 78,
    'rsi_14': 42, 'atr_14': 42, 'adx': 84,
    'macd': 78, 'stoch': 17, 'cci': 20, 'willr': 14, 'roc': 13,
    'bb': 20, 'mfi': 15, 'volume_sma_20': 20,
}


def wilder(series, period):
    """Wilder smoothing (RMA)."""
    return series.ewm(alpha=1.0 / period, adjust=False, min_periods=period).mean()


def true_range(high, low, close):
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr


def atr(high, low, close, period=14):
    """Average True Range with Wilder smoothing."""
    return wilder(true_range(high, low, close), period)


def adx_components(high, low, close, period=14):
    """Return (plus_di, minus_di, adx), all Wilder-smoothed."""
    up = high.diff()
    down = -low.diff()
    plus_dm = up.where((up > down) & (up > 0), 0.0)
    minus_dm = down.where((down > up) & (down > 0), 0.0)

    atr_val = atr(high, low, close, period).replace(0, np.nan)
    plus_di = 100 * wilder(plus_dm, period) / atr_val
    minus_di = 100 * wilder(minus_dm, period) / atr_val
    di_sum = (plus_di + minus_di).replace(0, np.nan)
    dx = 100 * (plus_di - minus_di).abs() / di_sum
    adx_val = wilder(dx, period)
    return plus_di, minus_di, adx_val


def stochastic(high, low, close, period=14, smooth_d=3):
    """Raw %K over `period` bars and %D = SMA(%K, smooth_d)."""
    low_n = low.rolling(period).min()
    high_n = high.rolling(period).max()
    denom = (high_n - low_n).replace(0, np.nan)
    k = 100 * (close - low_n) / denom
    d = k.rolling(smooth_d).mean()
    return k, d


def bollinger(close, period=20, num_std=2.0):
    """Return (mid, upper, lower, bandwidth_ratio, pct_b).

    bandwidth_ratio = (upper - lower) / mid  (a ratio, NOT percent)
    pct_b           = (close - lower) / (upper - lower)
    """
    mid = close.rolling(period).mean()
    std = close.rolling(period).std()
    upper = mid + num_std * std
    lower = mid - num_std * std
    width = (upper - lower)
    bandwidth = width / mid
    pct_b = (close - lower) / width.replace(0, np.nan)
    return mid, upper, lower, bandwidth, pct_b
