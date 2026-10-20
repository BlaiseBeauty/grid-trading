"""
Market Data — ccxt integration for crypto OHLCV data.
Primary exchange: KuCoin (globally available, no geo-restrictions).
Fallback exchange: OKX.
"""

import ccxt
import pandas as pd
import psycopg2
import psycopg2.extras
import psycopg2.pool
import os
from datetime import datetime, timezone

# Primary and fallback exchanges — KuCoin is globally available (no geo-blocks like Binance).
# OKX is the fallback, also globally available with good liquidity.
PRIMARY_EXCHANGE = os.getenv('CCXT_EXCHANGE', 'kucoin')
FALLBACK_EXCHANGE = os.getenv('CCXT_FALLBACK_EXCHANGE', 'okx')

_TF_UNIT_MS = {'m': 60_000, 'h': 3_600_000, 'd': 86_400_000, 'w': 604_800_000}


def timeframe_to_ms(timeframe):
    """'4h' -> 14_400_000. Raises ValueError for unknown units."""
    try:
        return int(timeframe[:-1]) * _TF_UNIT_MS[timeframe[-1]]
    except (KeyError, ValueError, IndexError):
        raise ValueError(f'Unsupported timeframe: {timeframe!r}')


def drop_forming_candle(df, timeframe, now=None):
    """Return df without its last row if that candle has not closed yet
    (candle open time + timeframe > now). `df` must be sorted ascending with a
    'timestamp' column. Pure function — no DB/network."""
    if df is None or df.empty:
        return df
    now = now or datetime.now(timezone.utc)
    last_open = pd.Timestamp(df['timestamp'].iloc[-1])
    if last_open.tzinfo is None:
        last_open = last_open.tz_localize('UTC')
    close_time = last_open + pd.Timedelta(milliseconds=timeframe_to_ms(timeframe))
    if close_time > pd.Timestamp(now):
        return df.iloc[:-1].reset_index(drop=True)
    return df


class MarketData:
    def __init__(self):
        self.exchanges = {}
        self.db_url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid')
        self._pool = None

    def _get_pool(self):
        if self._pool is None:
            self._pool = psycopg2.pool.ThreadedConnectionPool(2, 10, self.db_url)
        return self._pool

    def _get_db(self):
        return self._get_pool().getconn()

    def _put_db(self, conn):
        if self._pool:
            self._pool.putconn(conn)

    def _get_exchange(self, exchange_id=None):
        exchange_id = exchange_id or PRIMARY_EXCHANGE
        # Normalize legacy 'binance' references to the primary exchange
        if exchange_id == 'binance':
            exchange_id = PRIMARY_EXCHANGE
        if exchange_id not in self.exchanges:
            exchange_class = getattr(ccxt, exchange_id)
            self.exchanges[exchange_id] = exchange_class({
                'enableRateLimit': True,
            })
        return self.exchanges[exchange_id]

    def get_current_price(self, symbol, exchange_id=None):
        """Fetch current price with automatic fallback to secondary exchange."""
        exchange_id = exchange_id or PRIMARY_EXCHANGE
        if exchange_id == 'binance':
            exchange_id = PRIMARY_EXCHANGE
        try:
            exchange = self._get_exchange(exchange_id)
            ticker = exchange.fetch_ticker(symbol)
            return float(ticker['last'])
        except Exception as primary_err:
            if exchange_id != FALLBACK_EXCHANGE:
                print(f'[DATA] Price fetch failed on {exchange_id} for {symbol}: {primary_err}')
                print(f'[DATA] Trying fallback exchange: {FALLBACK_EXCHANGE}')
                try:
                    exchange = self._get_exchange(FALLBACK_EXCHANGE)
                    ticker = exchange.fetch_ticker(symbol)
                    return float(ticker['last'])
                except Exception as fallback_err:
                    print(f'[DATA] Fallback {FALLBACK_EXCHANGE} also failed for {symbol}: {fallback_err}')
                    raise fallback_err
            raise primary_err

    def fetch_ohlcv(self, symbol, timeframe='4h', limit=100, exchange_id=None):
        """Fetch OHLCV candles with automatic fallback to secondary exchange."""
        exchange_id = exchange_id or PRIMARY_EXCHANGE
        if exchange_id == 'binance':
            exchange_id = PRIMARY_EXCHANGE
        try:
            exchange = self._get_exchange(exchange_id)
            ohlcv = exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
            return ohlcv
        except Exception as primary_err:
            if exchange_id != FALLBACK_EXCHANGE:
                print(f'[DATA] OHLCV fetch failed on {exchange_id} for {symbol} {timeframe}: {primary_err}')
                print(f'[DATA] Trying fallback exchange: {FALLBACK_EXCHANGE}')
                try:
                    exchange = self._get_exchange(FALLBACK_EXCHANGE)
                    ohlcv = exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
                    return ohlcv
                except Exception as fallback_err:
                    print(f'[DATA] Fallback {FALLBACK_EXCHANGE} also failed for {symbol} {timeframe}: {fallback_err}')
                    raise fallback_err
            raise primary_err

    def get_prices(self, symbols, exchange_id=None):
        """Batch last-prices for many symbols in ONE fetch_tickers call.
        Returns {symbol: price}. Symbols that could not be priced are omitted
        (callers decide how to handle them); falls back to the secondary
        exchange for the missing ones."""
        symbols = sorted(set(symbols))
        prices = {}
        if not symbols:
            return prices
        exchange_id = exchange_id or PRIMARY_EXCHANGE
        if exchange_id == 'binance':
            exchange_id = PRIMARY_EXCHANGE
        for ex_id in dict.fromkeys([exchange_id, FALLBACK_EXCHANGE]):
            missing = [s for s in symbols if s not in prices]
            if not missing:
                break
            try:
                tickers = self._get_exchange(ex_id).fetch_tickers(missing)
                for sym in missing:
                    t = tickers.get(sym)
                    if t and t.get('last'):
                        prices[sym] = float(t['last'])
            except Exception as e:
                print(f'[DATA] Batch ticker fetch failed on {ex_id} for {missing}: {e}')
        return prices

    def store_candles(self, symbol, timeframe, candles, asset_class='crypto'):
        """Upsert OHLCV candles with ONE multi-row INSERT ... ON CONFLICT.
        The still-forming last candle is stored too (it is overwritten on the
        next fetch); consumers must drop it before computing indicators."""
        rows_by_ts = {}
        skipped = 0
        for candle in candles:
            try:
                if any(candle[k] is None for k in range(6)):
                    skipped += 1
                    continue
                ts = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
                rows_by_ts[ts] = (symbol, asset_class, timeframe,
                                  candle[1], candle[2], candle[3], candle[4], candle[5], ts)
            except (TypeError, ValueError, IndexError) as e:
                skipped += 1
                if skipped <= 3:
                    print(f'[DATA] Malformed candle for {symbol} {timeframe}: {candle!r} ({e})')
        rows = list(rows_by_ts.values())  # de-duplicated: ON CONFLICT cannot hit a key twice per statement
        if not rows:
            return 0

        conn = self._get_db()
        try:
            cur = conn.cursor()
            psycopg2.extras.execute_values(cur, """
                INSERT INTO market_data (symbol, asset_class, timeframe, open, high, low, close, volume, timestamp)
                VALUES %s
                ON CONFLICT (symbol, timeframe, timestamp) DO UPDATE SET
                    open = EXCLUDED.open, high = EXCLUDED.high,
                    low = EXCLUDED.low, close = EXCLUDED.close,
                    volume = EXCLUDED.volume
            """, rows, page_size=500)
            conn.commit()
            cur.close()
            if skipped > 0:
                print(f'[DATA] {symbol} {timeframe}: {len(rows)} stored, {skipped} skipped')
            return len(rows)
        except Exception as e:
            conn.rollback()
            print(f'[DATA] Batch store failed for {symbol} {timeframe}: {e}')
            raise
        finally:
            self._put_db(conn)

    def get_candles_df(self, symbol, timeframe='4h', limit=200, closed_only=False):
        """Retrieve stored candles as a pandas DataFrame.
        closed_only=True drops a still-forming last candle (use for indicators)."""
        df = self._load_candles(symbol, timeframe, limit + (1 if closed_only else 0))
        if df is None or not closed_only:
            return df
        df = drop_forming_candle(df, timeframe)
        return df if not df.empty else None

    def _load_candles(self, symbol, timeframe, limit):
        conn = self._get_db()
        try:
            query = """
                SELECT timestamp, open, high, low, close, volume
                FROM market_data
                WHERE symbol = %s AND timeframe = %s
                ORDER BY timestamp DESC
                LIMIT %s
            """
            df = pd.read_sql(query, conn, params=(symbol, timeframe, limit))
        finally:
            self._put_db(conn)

        if df.empty:
            return None

        df = df.sort_values('timestamp').reset_index(drop=True)
        for col in ['open', 'high', 'low', 'close', 'volume']:
            df[col] = pd.to_numeric(df[col], errors='coerce')

        return df
