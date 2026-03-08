"""
Backtest Data Ingestion — Download historical OHLCV from exchanges via CCXT.
Uses Binance for historical depth, KuCoin/OKX as fallback.
Inserts into historical_ohlcv table with ON CONFLICT DO NOTHING.

Usage:
  python backtest_ingest.py
  python backtest_ingest.py --symbols BTC/USDT ETH/USDT --timeframes 4h
  python backtest_ingest.py --start 2023-01-01
"""

import os
import sys
import time
import argparse
from datetime import datetime, timezone
import ccxt
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

# Load env from project root
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

DEFAULT_SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']
DEFAULT_TIMEFRAMES = ['1h', '4h']
DEFAULT_START = '2022-01-01T00:00:00Z'
BATCH_SIZE = 1000
EXCHANGE_FETCH_LIMIT = 1000  # max candles per API call


def get_db():
    db_url = os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid')
    return psycopg2.connect(db_url)


def get_exchange():
    """Try Binance first (best historical data), fall back to KuCoin, then OKX."""
    for exchange_id in ['binance', 'kucoin', 'okx']:
        try:
            exchange_class = getattr(ccxt, exchange_id)
            exchange = exchange_class({'enableRateLimit': True})
            exchange.load_markets()
            print(f'[INGEST] Using exchange: {exchange_id}')
            return exchange
        except Exception as e:
            print(f'[INGEST] {exchange_id} unavailable: {e}')
            continue
    raise RuntimeError('No exchange available')


def timeframe_to_ms(tf):
    """Convert timeframe string to milliseconds."""
    units = {'m': 60_000, 'h': 3_600_000, 'd': 86_400_000}
    num = int(tf[:-1])
    unit = tf[-1]
    return num * units[unit]


def fetch_and_insert(exchange, conn, symbol, timeframe, start_ts, end_ts):
    """Fetch OHLCV data in chunks and batch-insert into historical_ohlcv."""
    tf_ms = timeframe_to_ms(timeframe)
    total_expected = int((end_ts - start_ts) / tf_ms)
    current_ts = start_ts
    total_inserted = 0
    total_fetched = 0

    while current_ts < end_ts:
        try:
            candles = exchange.fetch_ohlcv(
                symbol, timeframe,
                since=current_ts,
                limit=EXCHANGE_FETCH_LIMIT
            )
        except Exception as e:
            print(f'[INGEST] Fetch error {symbol} {timeframe} @ {datetime.fromtimestamp(current_ts/1000, tz=timezone.utc)}: {e}')
            time.sleep(5)
            continue

        if not candles:
            break

        # Prepare batch
        rows = []
        for c in candles:
            ts = datetime.fromtimestamp(c[0] / 1000, tz=timezone.utc)
            if c[0] > end_ts:
                break
            rows.append((symbol, timeframe, ts, c[1], c[2], c[3], c[4], c[5]))

        if not rows:
            break

        # Batch insert
        cur = conn.cursor()
        insert_sql = """
            INSERT INTO historical_ohlcv (symbol, timeframe, timestamp, open, high, low, close, volume)
            VALUES %s
            ON CONFLICT (symbol, timeframe, timestamp) DO NOTHING
        """
        psycopg2.extras.execute_values(cur, insert_sql, rows, page_size=BATCH_SIZE)
        inserted = cur.rowcount
        conn.commit()
        cur.close()

        total_fetched += len(rows)
        total_inserted += inserted

        # Progress
        progress_pct = min(100, int((total_fetched / max(total_expected, 1)) * 100))
        print(f'[INGEST] {symbol} {timeframe}: {total_fetched}/{total_expected} candles ({progress_pct}%)', end='\r')

        # Advance to next chunk
        last_ts = candles[-1][0]
        if last_ts <= current_ts:
            # No progress — move forward by one interval to avoid infinite loop
            current_ts += tf_ms
        else:
            current_ts = last_ts + tf_ms

        # Rate limiting
        time.sleep(exchange.rateLimit / 1000 if hasattr(exchange, 'rateLimit') else 0.5)

    print(f'\n[INGEST] {symbol} {timeframe}: {total_fetched} fetched, {total_inserted} new rows inserted')
    return total_fetched, total_inserted


def get_existing_counts(conn):
    """Get current row counts per symbol/timeframe."""
    cur = conn.cursor()
    cur.execute("""
        SELECT symbol, timeframe, COUNT(*), MIN(timestamp), MAX(timestamp)
        FROM historical_ohlcv
        GROUP BY symbol, timeframe
        ORDER BY symbol, timeframe
    """)
    results = cur.fetchall()
    cur.close()
    return results


def main():
    parser = argparse.ArgumentParser(description='Backtest OHLCV Data Ingestion')
    parser.add_argument('--symbols', nargs='+', default=DEFAULT_SYMBOLS, help='Symbols to fetch')
    parser.add_argument('--timeframes', nargs='+', default=DEFAULT_TIMEFRAMES, help='Timeframes to fetch')
    parser.add_argument('--start', default=DEFAULT_START, help='Start date (ISO format)')
    parser.add_argument('--end', default=None, help='End date (ISO format, default: now)')
    args = parser.parse_args()

    start_dt = datetime.fromisoformat(args.start.replace('Z', '+00:00'))
    end_dt = datetime.fromisoformat(args.end.replace('Z', '+00:00')) if args.end else datetime.now(timezone.utc)
    start_ms = int(start_dt.timestamp() * 1000)
    end_ms = int(end_dt.timestamp() * 1000)

    print(f'[INGEST] ═══════════════════════════════════════════')
    print(f'[INGEST] Backtest Data Ingestion')
    print(f'[INGEST] Symbols:    {", ".join(args.symbols)}')
    print(f'[INGEST] Timeframes: {", ".join(args.timeframes)}')
    print(f'[INGEST] Period:     {start_dt.strftime("%Y-%m-%d")} → {end_dt.strftime("%Y-%m-%d")}')
    print(f'[INGEST] ═══════════════════════════════════════════')

    exchange = get_exchange()
    conn = get_db()

    results = []
    for symbol in args.symbols:
        for timeframe in args.timeframes:
            print(f'\n[INGEST] Starting: {symbol} {timeframe}')
            t0 = time.time()
            fetched, inserted = fetch_and_insert(exchange, conn, symbol, timeframe, start_ms, end_ms)
            elapsed = time.time() - t0
            results.append({
                'symbol': symbol,
                'timeframe': timeframe,
                'fetched': fetched,
                'inserted': inserted,
                'elapsed': elapsed,
            })

    # Summary table
    print(f'\n[INGEST] ═══════════════════════════════════════════')
    print(f'[INGEST] INGESTION COMPLETE')
    print(f'[INGEST] ═══════════════════════════════════════════')
    print(f'{"Symbol":<12} {"Timeframe":<10} {"Fetched":<10} {"Inserted":<10} {"Time":<8}')
    print(f'{"─"*12} {"─"*10} {"─"*10} {"─"*10} {"─"*8}')
    for r in results:
        print(f'{r["symbol"]:<12} {r["timeframe"]:<10} {r["fetched"]:<10} {r["inserted"]:<10} {r["elapsed"]:.1f}s')

    # Verify from DB
    print(f'\n[INGEST] DATABASE VERIFICATION:')
    counts = get_existing_counts(conn)
    print(f'{"Symbol":<12} {"Timeframe":<10} {"Candles":<10} {"Date From":<22} {"Date To":<22}')
    print(f'{"─"*12} {"─"*10} {"─"*10} {"─"*22} {"─"*22}')
    for symbol, tf, count, date_from, date_to in counts:
        print(f'{symbol:<12} {tf:<10} {count:<10} {date_from.strftime("%Y-%m-%d %H:%M"):<22} {date_to.strftime("%Y-%m-%d %H:%M"):<22}')

    conn.close()
    print(f'\n[INGEST] Done.')


if __name__ == '__main__':
    main()
