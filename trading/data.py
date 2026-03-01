"""
Market Data — ccxt integration for crypto OHLCV data.
"""

import ccxt
import pandas as pd
import psycopg2
import os
from datetime import datetime, timezone


class MarketData:
    def __init__(self):
        self.exchanges = {}
        self.db_url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid')

    def _get_exchange(self, exchange_id='binance'):
        if exchange_id not in self.exchanges:
            exchange_class = getattr(ccxt, exchange_id)
            self.exchanges[exchange_id] = exchange_class({
                'enableRateLimit': True,
            })
        return self.exchanges[exchange_id]

    def _get_db(self):
        return psycopg2.connect(self.db_url)

    def get_current_price(self, symbol, exchange_id='binance'):
        exchange = self._get_exchange(exchange_id)
        ticker = exchange.fetch_ticker(symbol)
        return float(ticker['last'])

    def fetch_ohlcv(self, symbol, timeframe='4h', limit=100, exchange_id='binance'):
        exchange = self._get_exchange(exchange_id)
        ohlcv = exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
        return ohlcv

    def store_candles(self, symbol, timeframe, candles, asset_class='crypto'):
        """Store OHLCV candles in PostgreSQL."""
        conn = self._get_db()
        cur = conn.cursor()
        stored = 0

        for candle in candles:
            ts = datetime.fromtimestamp(candle[0] / 1000, tz=timezone.utc)
            try:
                cur.execute("""
                    INSERT INTO market_data (symbol, asset_class, timeframe, open, high, low, close, volume, timestamp)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (symbol, timeframe, timestamp) DO UPDATE SET
                        open = EXCLUDED.open, high = EXCLUDED.high,
                        low = EXCLUDED.low, close = EXCLUDED.close,
                        volume = EXCLUDED.volume
                """, (symbol, asset_class, timeframe,
                      candle[1], candle[2], candle[3], candle[4], candle[5], ts))
                stored += 1
            except Exception:
                conn.rollback()
                continue

        conn.commit()
        cur.close()
        conn.close()
        return stored

    def get_candles_df(self, symbol, timeframe='4h', limit=200):
        """Retrieve stored candles as a pandas DataFrame."""
        conn = self._get_db()
        query = """
            SELECT timestamp, open, high, low, close, volume
            FROM market_data
            WHERE symbol = %s AND timeframe = %s
            ORDER BY timestamp DESC
            LIMIT %s
        """
        df = pd.read_sql(query, conn, params=(symbol, timeframe, limit))
        conn.close()

        if df.empty:
            return None

        df = df.sort_values('timestamp').reset_index(drop=True)
        for col in ['open', 'high', 'low', 'close', 'volume']:
            df[col] = pd.to_numeric(df[col], errors='coerce')

        return df
