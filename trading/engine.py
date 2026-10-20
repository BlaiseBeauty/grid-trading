"""
GRID Trading Engine — Flask REST API
Handles market data fetching, indicator computation, paper trading, and position monitoring.

Security: when ENGINE_API_KEY is set every route except GET /health requires the
header `X-Engine-Key: <ENGINE_API_KEY>`. If it is unset the engine starts OPEN and
logs a loud warning (set it before exposing the port beyond localhost).
"""

import hmac
import os
import sys
from flask import Flask, request, jsonify
from dotenv import load_dotenv

# Load env from project root
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from data import MarketData
from paper import PaperTrader
from live import LiveTrader, LiveTradeError
from indicators import compute_indicators, MIN_CANDLES_FULL
from monitor import PositionMonitor
from common import get_db
import validation

app = Flask(__name__)
market_data = MarketData()
paper_trader = PaperTrader()
live_trader = LiveTrader()
monitor = PositionMonitor()


def _live_enabled():
    return os.environ.get('LIVE_TRADING_ENABLED', 'false').lower() == 'true'


# ── Authentication ───────────────────────────────────────────────────────────

if not os.environ.get('ENGINE_API_KEY'):
    print('!' * 78, flush=True)
    print('[ENGINE] WARNING: ENGINE_API_KEY is NOT set — the trading API is UNAUTHENTICATED '
          'and can place/close trades for anyone who can reach this port. Set ENGINE_API_KEY '
          '(and send it as X-Engine-Key) before deploying.', flush=True)
    print('!' * 78, flush=True)


@app.before_request
def require_engine_key():
    """Shared-secret check on every route except a plain GET /health."""
    if request.method == 'GET' and request.path == '/health':
        return None
    expected = os.environ.get('ENGINE_API_KEY')
    if not expected:
        return None   # open mode (warned at startup)
    supplied = request.headers.get('X-Engine-Key', '')
    if not hmac.compare_digest(supplied.encode('utf-8'), expected.encode('utf-8')):
        return jsonify({'error': 'unauthorized'}), 401
    return None


def _json_body():
    """Parsed JSON object or None (malformed / missing / not an object)."""
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else None


def _bad_request(message):
    return jsonify({'error': message}), 400


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'engine': 'grid-trading'})


@app.route('/price/<symbol>', methods=['GET'])
def get_price(symbol):
    """Get current price for a symbol. Symbol format: BTC-USDT or BTC/USDT"""
    sym, err = validation.validate_symbol(symbol)
    if err:
        return _bad_request(err)
    try:
        price = market_data.get_current_price(sym)
        return jsonify({'symbol': sym, 'price': price})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/fetch-ohlcv', methods=['POST'])
def fetch_ohlcv():
    """Fetch and store OHLCV candle data (includes the still-forming candle;
    indicator endpoints drop it)."""
    data = _json_body()
    if data is None:
        return _bad_request('JSON object body required')
    clean, err = validation.validate_fetch_ohlcv(data, min_limit=MIN_CANDLES_FULL)
    if err:
        return _bad_request(err)
    try:
        symbol, timeframe = clean['symbol'], clean['timeframe']
        candles = market_data.fetch_ohlcv(symbol, timeframe, clean['limit'], clean['exchange'])

        if not candles or len(candles) == 0:
            return jsonify({
                'symbol': symbol,
                'timeframe': timeframe,
                'fetched': 0,
                'stored': 0,
                'warning': 'Exchange returned zero candles',
            }), 200

        stored = market_data.store_candles(symbol, timeframe, candles)

        return jsonify({
            'symbol': symbol,
            'timeframe': timeframe,
            'fetched': len(candles),
            'stored': stored,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/indicators/<symbol>', methods=['GET'])
def get_indicators(symbol):
    """Compute technical indicators from CLOSED candles only."""
    sym, err = validation.validate_symbol(symbol)
    if err:
        return _bad_request(err)
    timeframe = request.args.get('timeframe', '4h')
    if timeframe not in validation.VALID_TIMEFRAMES:
        return _bad_request(f'timeframe must be one of {list(validation.VALID_TIMEFRAMES)}')
    try:
        limit = int(request.args.get('limit', MIN_CANDLES_FULL))
    except ValueError:
        return _bad_request('limit must be an integer')
    limit = max(MIN_CANDLES_FULL, min(limit, 1000))   # SMA(200) needs >= 200 closed candles

    try:
        df = market_data.get_candles_df(sym, timeframe, limit, closed_only=True)
        if df is None or df.empty:
            return jsonify({'error': 'No data available. Fetch OHLCV first.'}), 404

        indicators = compute_indicators(df)
        resp = {
            'symbol': sym,
            'timeframe': timeframe,
            'candles': len(df),
            'closed_only': True,
            'indicators': indicators,
        }
        if len(df) < 200:
            resp['warning'] = f'only {len(df)} closed candles stored; sma_200 (needs 200) is unavailable'
        return jsonify(resp)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/execute-trade', methods=['POST'])
def execute_trade():
    """Execute a trade. Routes to LiveTrader when LIVE_TRADING_ENABLED=true and mode=live.
    Live trades are idempotent on `client_order_id`."""
    data = _json_body()
    if data is None:
        return _bad_request('JSON object body required')
    data, err = validation.validate_execute(data)
    if err:
        return _bad_request(err)
    try:
        mode = data['mode']
        if mode != 'paper' and not _live_enabled():
            return jsonify({'error': 'Live trading is disabled. Set LIVE_TRADING_ENABLED=true to enable.'}), 403

        if mode == 'live':
            result = live_trader.execute(data)
        else:
            result = paper_trader.execute(data)
        return jsonify(result)
    except LiveTradeError as e:
        print(f'[ENGINE] live trade error: {e} {e.payload}', flush=True)
        return jsonify({'error': str(e), **e.payload}), e.status
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _lookup_trade_mode(trade_id):
    conn = get_db()
    try:
        cur = conn.cursor()
        cur.execute("SELECT mode FROM trades WHERE id = %s", (trade_id,))
        row = cur.fetchone()
        cur.close()
        return row[0] if row else None
    finally:
        conn.close()


@app.route('/close-trade', methods=['POST'])
def close_trade():
    """Close an open trade. Uses LiveTrader for live trades, PaperTrader for paper."""
    data = _json_body()
    if data is None:
        return _bad_request('JSON object body required')
    clean, err = validation.validate_close(data)
    if err:
        return _bad_request(err)
    try:
        trade_id = clean['trade_id']
        # The DB is the source of truth for mode; a caller-supplied mode must agree.
        db_mode = _lookup_trade_mode(trade_id)
        if db_mode is None:
            return jsonify({'error': f'Trade {trade_id} not found'}), 404
        if clean['mode'] and clean['mode'] != db_mode:
            return _bad_request(f"mode {clean['mode']!r} does not match trade #{trade_id} (mode {db_mode!r})")

        if db_mode == 'live':
            if not _live_enabled():
                return jsonify({'error': 'Live trading is disabled. Set LIVE_TRADING_ENABLED=true to enable.'}), 403
            result = live_trader.close(trade_id)
        else:
            result = paper_trader.close(trade_id)
        return jsonify(result)
    except LiveTradeError as e:
        return jsonify({'error': str(e), **e.payload}), e.status
    except ValueError as e:
        return jsonify({'error': str(e)}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/amend-stops', methods=['POST'])
def amend_stops():
    """Tighten the SL and/or move the TP of an open trade.
    Body: {trade_id, sl_price?, tp_price?}. SL may only tighten. Live trades get
    their exchange stop replaced safely (new placed before old cancelled when the
    exchange allows); paper trades are a DB update."""
    data = _json_body()
    if data is None:
        return _bad_request('JSON object body required')
    clean, err = validation.validate_amend(data)
    if err:
        return _bad_request(err)
    try:
        trade_id = clean['trade_id']
        db_mode = _lookup_trade_mode(trade_id)
        if db_mode is None:
            return jsonify({'error': f'Trade {trade_id} not found'}), 404
        if db_mode == 'live':
            if not _live_enabled():
                return jsonify({'error': 'Live trading is disabled. Set LIVE_TRADING_ENABLED=true to enable.'}), 403
            result = live_trader.amend_stops(trade_id, clean['sl_price'], clean['tp_price'])
        else:
            result = paper_trader.amend_stops(trade_id, clean['sl_price'], clean['tp_price'])
        return jsonify(result)
    except LiveTradeError as e:
        print(f'[ENGINE] amend-stops error: {e} {e.payload}', flush=True)
        return jsonify({'error': str(e), **e.payload}), e.status
    except ValueError as e:
        msg = str(e)
        return jsonify({'error': msg}), (404 if msg.startswith('Trade ') and 'not found' in msg else 400)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/recover-orders', methods=['POST'])
def recover_orders():
    """Crash recovery (idempotent, safe to call on every boot): for open live
    trades with a stop price but no exchange SL order, adopt an already-open
    matching order or place the missing stop. Only missing legs are ever
    placed (TP is monitor-driven, see live.py). Also lists stale 'pending'
    rows that need manual reconciliation."""
    try:
        if not _live_enabled():
            return jsonify({'recovered': 0, 'message': 'Live trading disabled'})

        conn = get_db()
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT id, symbol, side, quantity, entry_price, tp_price, sl_price,
                       exchange_sl_order_id, exchange_tp_order_id, entry_fee
                FROM trades
                WHERE status = 'open' AND mode = 'live'
                  AND sl_price IS NOT NULL AND exchange_sl_order_id IS NULL
            """)
            cols = [desc[0] for desc in cur.description]
            rows = cur.fetchall()
            cur.execute("""
                SELECT id, symbol, side, created_at FROM trades
                WHERE status = 'pending' AND mode = 'live'
                  AND created_at < NOW() - INTERVAL '2 minutes'
            """)
            stale = [{'trade_id': r[0], 'symbol': r[1], 'side': r[2], 'created_at': str(r[3])}
                     for r in cur.fetchall()]
            cur.close()
        finally:
            conn.close()

        recovered = []
        for row in rows:
            trade = dict(zip(cols, row))
            try:
                result = live_trader.place_sl_tp(trade)
                print(f'[RECOVERY] Trade #{trade["id"]}: {result["action"]} SL={result["sl_order_id"]}', flush=True)
                recovered.append({'trade_id': trade['id'], **result})
            except Exception as e:
                print(f'[RECOVERY] Failed for trade #{trade["id"]}: {e}', flush=True)
                recovered.append({'trade_id': trade['id'], 'error': str(e)})

        if stale:
            print(f'[RECOVERY] WARNING: {len(stale)} stale pending live trade(s) need manual reconcile: {stale}',
                  flush=True)
        return jsonify({'recovered': len(recovered), 'details': recovered, 'stale_pending': stale})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/monitor-positions', methods=['POST'])
def monitor_positions():
    """Check TP/SL on open positions."""
    try:
        results = monitor.check_all()
        return jsonify({'checked': len(results), 'results': results})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5100))
    # '::' = dual-stack (IPv4 + IPv6), required for Railway private networking.
    host = os.environ.get('ENGINE_HOST', '::')
    # The Werkzeug debugger executes arbitrary code: only ever with an explicit
    # FLASK_DEBUG=1 AND a loopback bind.
    debug = os.environ.get('FLASK_DEBUG') == '1' and host == '127.0.0.1'
    if os.environ.get('FLASK_DEBUG') == '1' and not debug:
        print(f'[ENGINE] FLASK_DEBUG=1 ignored: debug requires ENGINE_HOST=127.0.0.1 (current {host!r})', flush=True)
    app.run(host=host, port=port, debug=debug)
