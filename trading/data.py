"""
Market Data — ccxt integration for crypto OHLCV data.
Primary exchange: KuCoin (globally available, no geo-restrictions).
Fallback exchange: OKX.
"""

import ccxt
import pandas as pd
import psycopg2
import psycopg2.pool
import os
from datetime import datetime, timezone

# Primary and fallback exchanges — KuCoin is globally available (no geo-blocks like Binance).
# OKX is the fallback, also globally available with good liquidity.
PRIMARY_EXCHANGE = os.getenv('CCXT_EXCHANGE', 'kucoin')
FALLBACK_EXCHANGE = os.getenv('CCXT_FALLBACK_EXCHANGE', 'okx')


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

    def store_candles(self, symbol, timeframe, candles, asset_class='crypto'):
        """Store OHLCV candles in PostgreSQL using a single transaction with savepoints."""
        conn = self._get_db()
        try:
            cur = conn.cursor()
            stored = 0
            skipped = 0

            for i, candle in enumerate(candles):
                ts = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
                try:
                    cur.execute(f"SAVEPOINT candle_{i}")
                    cur.execute("""
                        INSERT INTO market_data (symbol, asset_class, timeframe, open, high, low, close, volume, timestamp)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (symbol, timeframe, timestamp) DO UPDATE SET
                            open = EXCLUDED.open, high = EXCLUDED.high,
                            low = EXCLUDED.low, close = EXCLUDED.close,
                            volume = EXCLUDED.volume
                    """, (symbol, asset_class, timeframe,
                          candle[1], candle[2], candle[3], candle[4], candle[5], ts))
                    cur.execute(f"RELEASE SAVEPOINT candle_{i}")
                    stored += 1
                except Exception as e:
                    cur.execute(f"ROLLBACK TO SAVEPOINT candle_{i}")
                    skipped += 1
                    if skipped <= 3:
                        print(f'[DATA] Candle insert failed for {symbol} {timeframe} @ {ts}: {e}')
                    continue

            conn.commit()
            cur.close()
            if skipped > 0:
                print(f'[DATA] {symbol} {timeframe}: {stored} stored, {skipped} skipped')
            return stored
        except Exception as e:
            conn.rollback()
            print(f'[DATA] Batch store failed for {symbol} {timeframe}: {e}')
            raise
        finally:
            self._put_db(conn)

    def get_candles_df(self, symbol, timeframe='4h', limit=200):
        """Retrieve stored candles as a pandas DataFrame."""
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
