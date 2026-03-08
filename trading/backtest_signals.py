"""
Backtest Signal Computer & Regime Classifier
Computes all indicator signals deterministically from historical OHLCV.
No lookahead bias — signals at timestamp T only use data up to T.
Uses pandas/numpy only (no TA-Lib).

Usage:
  python backtest_signals.py --symbol BTC/USDT --timeframe 4h
  python backtest_signals.py --symbol ETH/USDT --timeframe 1h --store-regimes
"""

import os
import sys
import json
import argparse
import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))


# ──────────────────────────────────────
# Database
# ──────────────────────────────────────

def get_db():
    return psycopg2.connect(os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid'))


def load_ohlcv(symbol, timeframe):
    """Load historical OHLCV from DB as a pandas DataFrame."""
    conn = get_db()
    df = pd.read_sql("""
        SELECT timestamp, open, high, low, close, volume
        FROM historical_ohlcv
        WHERE symbol = %s AND timeframe = %s
        ORDER BY timestamp ASC
    """, conn, params=(symbol, timeframe))
    conn.close()

    for col in ['open', 'high', 'low', 'close', 'volume']:
        df[col] = pd.to_numeric(df[col], errors='coerce')

    return df


# ──────────────────────────────────────
# Indicator helpers (no lookahead)
# ──────────────────────────────────────

def ema(series, period):
    """Exponential moving average."""
    return series.ewm(span=period, adjust=False).mean()


def sma(series, period):
    """Simple moving average."""
    return series.rolling(window=period, min_periods=period).mean()


def rsi(close, period=14):
    """Relative Strength Index."""
    delta = close.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = (-delta).where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def macd(close, fast=12, slow=26, signal=9):
    """MACD line, signal line, histogram."""
    ema_fast = ema(close, fast)
    ema_slow = ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = ema(macd_line, signal)
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def bollinger_bands(close, period=20, std_dev=2):
    """Bollinger Bands: middle, upper, lower, width."""
    middle = sma(close, period)
    std = close.rolling(window=period, min_periods=period).std()
    upper = middle + std_dev * std
    lower = middle - std_dev * std
    width = (upper - lower) / middle * 100  # as percentage
    return middle, upper, lower, width


def atr(high, low, close, period=14):
    """Average True Range."""
    tr1 = high - low
    tr2 = (high - close.shift(1)).abs()
    tr3 = (low - close.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return tr.rolling(window=period, min_periods=period).mean()


def adx(high, low, close, period=14):
    """Average Directional Index."""
    plus_dm = high.diff()
    minus_dm = -low.diff()
    plus_dm = plus_dm.where((plus_dm > minus_dm) & (plus_dm > 0), 0.0)
    minus_dm = minus_dm.where((minus_dm > plus_dm) & (minus_dm > 0), 0.0)

    atr_val = atr(high, low, close, period)
    plus_di = 100 * ema(plus_dm, period) / atr_val.replace(0, np.nan)
    minus_di = 100 * ema(minus_dm, period) / atr_val.replace(0, np.nan)

    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx_val = ema(dx, period)
    return adx_val


def obv(close, volume):
    """On Balance Volume."""
    direction = np.sign(close.diff())
    direction.iloc[0] = 0
    return (volume * direction).cumsum()


def find_swing_points(df, lookback=5):
    """Find swing highs and lows using rolling window."""
    highs = df['high'].rolling(window=2*lookback+1, center=True, min_periods=lookback+1).max()
    lows = df['low'].rolling(window=2*lookback+1, center=True, min_periods=lookback+1).min()
    swing_highs = df['high'] == highs
    swing_lows = df['low'] == lows
    return swing_highs, swing_lows


# ──────────────────────────────────────
# Pre-compute all indicators
# ──────────────────────────────────────

def precompute_indicators(df):
    """Pre-compute all indicators on the full DataFrame.
    These are causal (use only past data at each point) due to
    the nature of EMA/SMA/rolling operations."""

    ind = pd.DataFrame(index=df.index)
    ind['close'] = df['close']
    ind['high'] = df['high']
    ind['low'] = df['low']
    ind['volume'] = df['volume']

    # EMAs
    ind['ema20'] = ema(df['close'], 20)
    ind['ema50'] = ema(df['close'], 50)
    ind['ema200'] = ema(df['close'], 200)

    # RSI
    ind['rsi14'] = rsi(df['close'], 14)

    # MACD
    ind['macd_line'], ind['macd_signal'], ind['macd_hist'] = macd(df['close'])

    # Bollinger Bands
    ind['bb_mid'], ind['bb_upper'], ind['bb_lower'], ind['bb_width'] = bollinger_bands(df['close'])

    # ATR
    ind['atr14'] = atr(df['high'], df['low'], df['close'], 14)
    ind['atr14_avg20'] = sma(ind['atr14'], 20)

    # ADX
    ind['adx14'] = adx(df['high'], df['low'], df['close'], 14)

    # Volume averages
    ind['vol_avg20'] = sma(df['volume'], 20)

    # OBV
    ind['obv'] = obv(df['close'], df['volume'])

    # BB width percentile (rolling 100-bar)
    ind['bb_width_pct'] = ind['bb_width'].rolling(100, min_periods=50).rank(pct=True) * 100

    return ind


# ──────────────────────────────────────
# Signal generators
# ──────────────────────────────────────

def compute_signals_at_bar(ind, i, symbol, timeframe, timestamp):
    """Compute all signals for bar i. Returns list of signal dicts."""
    signals = []

    if i < 200:  # Need at least 200 bars for EMA200
        return signals

    def add_signal(signal_type, category, direction, strength, metadata=None):
        signals.append({
            'symbol': symbol,
            'signal_type': signal_type,
            'signal_category': category,
            'direction': direction,
            'strength': min(100, max(0, round(strength, 1))),
            'timeframe': timeframe,
            'timestamp': str(timestamp),
            'decay_model': 'linear',
            'metadata': metadata or {},
        })

    c = ind.iloc[i]

    # ── TREND SIGNALS ──

    # EMA alignment
    if pd.notna(c['ema200']):
        if c['ema20'] > c['ema50'] > c['ema200']:
            spread = (c['ema20'] - c['ema200']) / c['ema200'] * 100
            add_signal('ema_aligned_bullish', 'trend', 'bullish',
                       min(80 + spread * 2, 100),
                       {'ema20': round(c['ema20'], 2), 'ema50': round(c['ema50'], 2), 'ema200': round(c['ema200'], 2)})

        if c['ema20'] < c['ema50'] < c['ema200']:
            spread = (c['ema200'] - c['ema20']) / c['ema200'] * 100
            add_signal('ema_aligned_bearish', 'trend', 'bearish',
                       min(80 + spread * 2, 100),
                       {'ema20': round(c['ema20'], 2), 'ema50': round(c['ema50'], 2), 'ema200': round(c['ema200'], 2)})

        if c['close'] > c['ema200']:
            dist = (c['close'] - c['ema200']) / c['ema200'] * 100
            add_signal('price_above_ema200', 'trend', 'bullish',
                       min(60 + dist * 3, 100),
                       {'close': round(c['close'], 2), 'ema200': round(c['ema200'], 2), 'dist_pct': round(dist, 2)})

        if c['close'] < c['ema200']:
            dist = (c['ema200'] - c['close']) / c['ema200'] * 100
            add_signal('price_below_ema200', 'trend', 'bearish',
                       min(60 + dist * 3, 100),
                       {'close': round(c['close'], 2), 'ema200': round(c['ema200'], 2), 'dist_pct': round(dist, 2)})

    # EMA crossovers (within last 3 bars)
    if i >= 3 and pd.notna(c['ema50']):
        for j in range(max(0, i-2), i+1):
            prev = ind.iloc[j-1] if j > 0 else None
            curr = ind.iloc[j]
            if prev is not None and pd.notna(prev['ema20']) and pd.notna(prev['ema50']):
                if prev['ema20'] <= prev['ema50'] and curr['ema20'] > curr['ema50']:
                    add_signal('ema_crossover_bullish', 'trend', 'bullish', 75,
                               {'cross_bar': j, 'ema20': round(curr['ema20'], 2), 'ema50': round(curr['ema50'], 2)})
                    break
                if prev['ema20'] >= prev['ema50'] and curr['ema20'] < curr['ema50']:
                    add_signal('ema_crossover_bearish', 'trend', 'bearish', 75,
                               {'cross_bar': j, 'ema20': round(curr['ema20'], 2), 'ema50': round(curr['ema50'], 2)})
                    break

    # ── MOMENTUM SIGNALS ──

    if pd.notna(c['rsi14']):
        if c['rsi14'] < 35:
            strength = min((35 - c['rsi14']) * 3, 100)
            add_signal('rsi_oversold', 'momentum', 'bullish', strength,
                       {'rsi14': round(c['rsi14'], 2)})
        if c['rsi14'] > 65:
            strength = min((c['rsi14'] - 65) * 3, 100)
            add_signal('rsi_overbought', 'momentum', 'bearish', strength,
                       {'rsi14': round(c['rsi14'], 2)})

    # MACD crossovers
    if i >= 1 and pd.notna(c['macd_line']) and pd.notna(c['macd_signal']):
        prev = ind.iloc[i-1]
        if pd.notna(prev['macd_line']) and pd.notna(prev['macd_signal']):
            if prev['macd_line'] <= prev['macd_signal'] and c['macd_line'] > c['macd_signal']:
                add_signal('macd_bullish_cross', 'momentum', 'bullish', 70,
                           {'macd': round(c['macd_line'], 4), 'signal': round(c['macd_signal'], 4)})
            if prev['macd_line'] >= prev['macd_signal'] and c['macd_line'] < c['macd_signal']:
                add_signal('macd_bearish_cross', 'momentum', 'bearish', 70,
                           {'macd': round(c['macd_line'], 4), 'signal': round(c['macd_signal'], 4)})

    # MACD histogram expanding
    if i >= 3 and pd.notna(c['macd_hist']):
        h = [ind.iloc[i-2]['macd_hist'], ind.iloc[i-1]['macd_hist'], c['macd_hist']]
        if all(pd.notna(x) for x in h):
            if all(x > 0 for x in h) and h[1] > h[0] and h[2] > h[1]:
                add_signal('macd_histogram_expanding_bullish', 'momentum', 'bullish', 65,
                           {'hist_values': [round(x, 4) for x in h]})
            if all(x < 0 for x in h) and h[1] < h[0] and h[2] < h[1]:
                add_signal('macd_histogram_expanding_bearish', 'momentum', 'bearish', 65,
                           {'hist_values': [round(x, 4) for x in h]})

    # ── VOLATILITY SIGNALS ──

    if pd.notna(c.get('bb_width_pct')):
        if c['bb_width_pct'] < 20:
            add_signal('bb_squeeze', 'volatility', 'neutral', 70,
                       {'bb_width_pct': round(c['bb_width_pct'], 1)})
        if c['bb_width_pct'] > 80:
            add_signal('bb_expansion', 'volatility', 'neutral', 65,
                       {'bb_width_pct': round(c['bb_width_pct'], 1)})

    if pd.notna(c['atr14']) and pd.notna(c['atr14_avg20']) and c['atr14_avg20'] > 0:
        atr_ratio = c['atr14'] / c['atr14_avg20']
        if atr_ratio > 1.5:
            add_signal('atr_elevated', 'volatility', 'neutral',
                       min(60 + (atr_ratio - 1.5) * 40, 100),
                       {'atr14': round(c['atr14'], 4), 'atr14_avg20': round(c['atr14_avg20'], 4), 'ratio': round(atr_ratio, 2)})

    if pd.notna(c['bb_lower']) and c['bb_lower'] > 0:
        dist_lower = abs(c['close'] - c['bb_lower']) / c['bb_lower'] * 100
        if dist_lower < 0.5:
            add_signal('price_at_bb_lower', 'volatility', 'bullish', 70,
                       {'close': round(c['close'], 2), 'bb_lower': round(c['bb_lower'], 2), 'dist_pct': round(dist_lower, 3)})

    if pd.notna(c['bb_upper']) and c['bb_upper'] > 0:
        dist_upper = abs(c['close'] - c['bb_upper']) / c['bb_upper'] * 100
        if dist_upper < 0.5:
            add_signal('price_at_bb_upper', 'volatility', 'bearish', 70,
                       {'close': round(c['close'], 2), 'bb_upper': round(c['bb_upper'], 2), 'dist_pct': round(dist_upper, 3)})

    # ── VOLUME SIGNALS ──

    if pd.notna(c['vol_avg20']) and c['vol_avg20'] > 0:
        vol_ratio = c['volume'] / c['vol_avg20']
        if vol_ratio > 2.0:
            add_signal('volume_surge', 'volume', 'neutral',
                       min(60 + (vol_ratio - 2) * 20, 100),
                       {'volume': round(c['volume'], 2), 'avg20': round(c['vol_avg20'], 2), 'ratio': round(vol_ratio, 2)})
        if vol_ratio < 0.5:
            add_signal('volume_dry_up', 'volume', 'neutral',
                       min(60 + (0.5 - vol_ratio) * 80, 100),
                       {'volume': round(c['volume'], 2), 'avg20': round(c['vol_avg20'], 2), 'ratio': round(vol_ratio, 2)})

    # OBV divergence (compare last 20 bars)
    if i >= 20:
        window = 20
        price_lows = ind['close'].iloc[i-window:i+1]
        obv_lows = ind['obv'].iloc[i-window:i+1]

        # Bullish divergence: price lower lows, OBV higher lows
        price_min_idx = price_lows.idxmin()
        price_min2 = price_lows.drop(price_min_idx).idxmin() if len(price_lows) > 1 else None

        if price_min2 is not None:
            if price_min_idx > price_min2 and price_lows[price_min_idx] < price_lows[price_min2]:
                if obv_lows[price_min_idx] > obv_lows[price_min2]:
                    add_signal('obv_divergence_bullish', 'volume', 'bullish', 65,
                               {'type': 'price_lower_low_obv_higher_low'})

            # Bearish divergence: price higher highs, OBV lower highs
            price_highs = ind['close'].iloc[i-window:i+1]
            obv_highs = ind['obv'].iloc[i-window:i+1]
            price_max_idx = price_highs.idxmax()
            price_max2 = price_highs.drop(price_max_idx).idxmax() if len(price_highs) > 1 else None

            if price_max2 is not None:
                if price_max_idx > price_max2 and price_highs[price_max_idx] > price_highs[price_max2]:
                    if obv_highs[price_max_idx] < obv_highs[price_max2]:
                        add_signal('obv_divergence_bearish', 'volume', 'bearish', 65,
                                   {'type': 'price_higher_high_obv_lower_high'})

    # Volume distribution (bearish)
    if i >= 20:
        window_data = ind.iloc[i-19:i+1]
        up_bars = window_data[window_data['close'] > window_data['close'].shift(1)]
        down_bars = window_data[window_data['close'] < window_data['close'].shift(1)]
        avg_up_vol = up_bars['volume'].mean() if len(up_bars) > 0 else 0
        avg_down_vol = down_bars['volume'].mean() if len(down_bars) > 0 else 0
        if avg_up_vol > 0:
            dist_ratio = avg_down_vol / avg_up_vol
            if dist_ratio > 1.5:
                add_signal('volume_distribution_bearish', 'volume', 'bearish',
                           min(60 + (dist_ratio - 1.5) * 40, 100),
                           {'up_vol_avg': round(avg_up_vol, 2), 'down_vol_avg': round(avg_down_vol, 2), 'ratio': round(dist_ratio, 2)})

    # ── PATTERN SIGNALS ──

    # Higher highs / higher lows (last 10 bars, find 5 pivots)
    if i >= 10:
        recent_highs = []
        recent_lows = []
        for j in range(i-9, i+1):
            if j >= 2:
                if ind.iloc[j]['high'] > ind.iloc[j-1]['high'] and ind.iloc[j]['high'] > ind.iloc[j+1]['high'] if j+1 < len(ind) else False:
                    recent_highs.append(ind.iloc[j]['high'])
                if ind.iloc[j]['low'] < ind.iloc[j-1]['low'] and ind.iloc[j]['low'] < ind.iloc[j+1]['low'] if j+1 < len(ind) else False:
                    recent_lows.append(ind.iloc[j]['low'])

        if len(recent_highs) >= 3 and len(recent_lows) >= 2:
            hh = all(recent_highs[k] > recent_highs[k-1] for k in range(1, min(len(recent_highs), 3)))
            hl = all(recent_lows[k] > recent_lows[k-1] for k in range(1, min(len(recent_lows), 3)))
            if hh and hl:
                add_signal('higher_highs_higher_lows', 'pattern', 'bullish', 70,
                           {'pivot_highs': [round(x, 2) for x in recent_highs[-3:]], 'pivot_lows': [round(x, 2) for x in recent_lows[-3:]]})

            lh = all(recent_highs[k] < recent_highs[k-1] for k in range(1, min(len(recent_highs), 3)))
            ll = all(recent_lows[k] < recent_lows[k-1] for k in range(1, min(len(recent_lows), 3)))
            if lh and ll:
                add_signal('lower_highs_lower_lows', 'pattern', 'bearish', 70,
                           {'pivot_highs': [round(x, 2) for x in recent_highs[-3:]], 'pivot_lows': [round(x, 2) for x in recent_lows[-3:]]})

    # Support bounce / resistance rejection (last 50 bars)
    if i >= 50:
        lookback = 50
        recent_lows_arr = ind['low'].iloc[i-lookback:i].values
        recent_highs_arr = ind['high'].iloc[i-lookback:i].values
        swing_low = np.min(recent_lows_arr)
        swing_high = np.max(recent_highs_arr)

        if swing_low > 0:
            dist_to_support = abs(c['close'] - swing_low) / swing_low * 100
            if dist_to_support < 0.5 and pd.notna(c['vol_avg20']) and c['vol_avg20'] > 0 and c['volume'] > c['vol_avg20']:
                add_signal('support_bounce', 'pattern', 'bullish', 72,
                           {'close': round(c['close'], 2), 'swing_low': round(swing_low, 2), 'dist_pct': round(dist_to_support, 3)})

        if swing_high > 0:
            dist_to_resistance = abs(c['close'] - swing_high) / swing_high * 100
            if dist_to_resistance < 0.5 and pd.notna(c['vol_avg20']) and c['vol_avg20'] > 0 and c['volume'] > c['vol_avg20']:
                add_signal('resistance_rejection', 'pattern', 'bearish', 72,
                           {'close': round(c['close'], 2), 'swing_high': round(swing_high, 2), 'dist_pct': round(dist_to_resistance, 3)})

    return signals


# ──────────────────────────────────────
# Regime classifier
# ──────────────────────────────────────

def compute_regime_at_bar(ind, i):
    """Classify market regime at bar i. Returns (regime, confidence)."""
    if i < 200:
        return 'ranging', 30.0

    c = ind.iloc[i]
    adx_val = c.get('adx14', 0)
    atr_val = c.get('atr14', 0)
    atr_avg = c.get('atr14_avg20', 0)
    ema20 = c.get('ema20', 0)
    ema50 = c.get('ema50', 0)

    if pd.isna(adx_val):
        adx_val = 0
    if pd.isna(atr_val) or pd.isna(atr_avg):
        atr_val, atr_avg = 0, 1

    # Confidence: ADX normalised 0-100, capped at 95
    confidence = min(float(adx_val), 95.0)

    # Trending up: ADX > 25 AND EMA20 > EMA50
    if adx_val > 25 and ema20 > ema50:
        return 'trending_up', confidence

    # Trending down: ADX > 25 AND EMA20 < EMA50
    if adx_val > 25 and ema20 < ema50:
        return 'trending_down', confidence

    # Volatile: ATR > 1.3x average AND ADX < 25
    if atr_avg > 0 and atr_val > 1.3 * atr_avg and adx_val < 25:
        return 'volatile', confidence

    # Default: ranging
    return 'ranging', confidence


def compute_regimes(ind):
    """Compute regime for every bar. Returns DataFrame with columns: regime, confidence."""
    regimes = []
    for i in range(len(ind)):
        regime, conf = compute_regime_at_bar(ind, i)
        regimes.append({'regime': regime, 'confidence': conf})
    return pd.DataFrame(regimes, index=ind.index)


# ──────────────────────────────────────
# Regime period extraction (for DB storage)
# ──────────────────────────────────────

def extract_regime_periods(df, regime_df, symbol, timeframe):
    """Convert per-bar regime labels into contiguous periods."""
    periods = []
    current_regime = None
    period_start = None
    current_conf = 0

    for i in range(len(regime_df)):
        r = regime_df.iloc[i]['regime']
        conf = regime_df.iloc[i]['confidence']
        ts = df.iloc[i]['timestamp']

        if r != current_regime:
            if current_regime is not None:
                periods.append({
                    'symbol': symbol,
                    'timeframe': timeframe,
                    'regime': current_regime,
                    'confidence': round(current_conf, 2),
                    'period_start': period_start,
                    'period_end': ts,
                })
            current_regime = r
            period_start = ts
            current_conf = conf
        else:
            current_conf = (current_conf + conf) / 2  # running average

    # Close final period
    if current_regime is not None:
        periods.append({
            'symbol': symbol,
            'timeframe': timeframe,
            'regime': current_regime,
            'confidence': round(current_conf, 2),
            'period_start': period_start,
            'period_end': df.iloc[-1]['timestamp'],
        })

    return periods


def store_regime_periods(periods):
    """Store regime periods in backtest_regime_periods table."""
    if not periods:
        return

    conn = get_db()
    cur = conn.cursor()

    # Clear existing for this symbol/timeframe
    symbol = periods[0]['symbol']
    timeframe = periods[0]['timeframe']
    cur.execute("DELETE FROM backtest_regime_periods WHERE symbol = %s AND timeframe = %s",
                (symbol, timeframe))

    insert_sql = """
        INSERT INTO backtest_regime_periods (symbol, timeframe, regime, confidence, period_start, period_end)
        VALUES %s
    """
    rows = [(p['symbol'], p['timeframe'], p['regime'], float(p['confidence']),
             p['period_start'], p['period_end']) for p in periods]
    psycopg2.extras.execute_values(cur, insert_sql, rows)
    conn.commit()
    cur.close()
    conn.close()


# ──────────────────────────────────────
# Main CLI
# ──────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Backtest Signal Computer & Regime Classifier')
    parser.add_argument('--symbol', default='BTC/USDT', help='Symbol to process')
    parser.add_argument('--timeframe', default='4h', help='Timeframe')
    parser.add_argument('--store-regimes', action='store_true', help='Store regime periods to DB')
    args = parser.parse_args()

    print(f'[SIGNALS] Loading {args.symbol} {args.timeframe} from DB...')
    df = load_ohlcv(args.symbol, args.timeframe)
    if df.empty:
        print(f'[SIGNALS] No data found for {args.symbol} {args.timeframe}')
        sys.exit(1)

    print(f'[SIGNALS] Loaded {len(df)} bars: {df.iloc[0]["timestamp"]} → {df.iloc[-1]["timestamp"]}')

    # Pre-compute indicators
    print(f'[SIGNALS] Pre-computing indicators...')
    ind = precompute_indicators(df)

    # Compute signals bar by bar
    print(f'[SIGNALS] Computing signals (no lookahead)...')
    all_signals = []
    signal_counts = {}
    for i in range(len(df)):
        signals = compute_signals_at_bar(ind, i, args.symbol, args.timeframe, df.iloc[i]['timestamp'])
        all_signals.extend(signals)
        for s in signals:
            cat = s['signal_category']
            signal_counts[cat] = signal_counts.get(cat, 0) + 1

        if (i + 1) % 2000 == 0:
            print(f'[SIGNALS] Processed {i+1}/{len(df)} bars, {len(all_signals)} signals so far', end='\r')

    print(f'\n[SIGNALS] Total signals: {len(all_signals)}')

    # Signal summary by category
    print(f'\n[SIGNALS] ═══════════════════════════════════════')
    print(f'[SIGNALS] SIGNAL SUMMARY')
    print(f'[SIGNALS] ═══════════════════════════════════════')
    print(f'{"Category":<15} {"Count":<10} {"Per Bar":<10}')
    print(f'{"─"*15} {"─"*10} {"─"*10}')
    for cat in sorted(signal_counts.keys()):
        per_bar = signal_counts[cat] / len(df)
        print(f'{cat:<15} {signal_counts[cat]:<10} {per_bar:.2f}')
    print(f'{"─"*15} {"─"*10} {"─"*10}')
    print(f'{"TOTAL":<15} {len(all_signals):<10} {len(all_signals)/len(df):.2f}')

    # Signal type breakdown
    type_counts = {}
    for s in all_signals:
        t = s['signal_type']
        type_counts[t] = type_counts.get(t, 0) + 1

    print(f'\n[SIGNALS] SIGNAL TYPE BREAKDOWN:')
    for t in sorted(type_counts.keys(), key=lambda x: type_counts[x], reverse=True):
        print(f'  {t:<40} {type_counts[t]:>6}')

    # Compute regimes
    print(f'\n[SIGNALS] Computing regimes...')
    regime_df = compute_regimes(ind)

    # Regime distribution
    regime_counts = regime_df['regime'].value_counts()
    total_bars = len(regime_df)

    print(f'\n[SIGNALS] ═══════════════════════════════════════')
    print(f'[SIGNALS] REGIME DISTRIBUTION')
    print(f'[SIGNALS] ═══════════════════════════════════════')
    print(f'{"Regime":<20} {"Bars":<8} {"Pct":<8}')
    print(f'{"─"*20} {"─"*8} {"─"*8}')
    for regime in ['trending_up', 'trending_down', 'volatile', 'ranging']:
        count = regime_counts.get(regime, 0)
        pct = count / total_bars * 100
        print(f'{regime:<20} {count:<8} {pct:.1f}%')

    # Extract and optionally store regime periods
    periods = extract_regime_periods(df, regime_df, args.symbol, args.timeframe)
    print(f'\n[SIGNALS] Regime periods: {len(periods)} distinct periods')

    if args.store_regimes:
        store_regime_periods(periods)
        print(f'[SIGNALS] Stored {len(periods)} regime periods to DB')

    print(f'\n[SIGNALS] Done.')


if __name__ == '__main__':
    main()
