"""
GRID Trading Engine — Flask REST API
Handles market data fetching, indicator computation, paper trading, and position monitoring.
"""

import os
import sys
from flask import Flask, request, jsonify
from dotenv import load_dotenv

# Load env from project root
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from data import MarketData
from paper import PaperTrader
from indicators import compute_indicators
from monitor import PositionMonitor

app = Flask(__name__)
market_data = MarketData()
paper_trader = PaperTrader()
monitor = PositionMonitor()


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'engine': 'grid-trading'})


@app.route('/price/<symbol>', methods=['GET'])
def get_price(symbol):
    """Get current price for a symbol. Symbol format: BTC-USDT or BTC/USDT"""
    try:
        sym = symbol.replace('-', '/')
        price = market_data.get_current_price(sym)
        return jsonify({'symbol': sym, 'price': price})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/fetch-ohlcv', methods=['POST'])
def fetch_ohlcv():
    """Fetch and store OHLCV candle data."""
    try:
        data = request.json
        symbol = data.get('symbol', 'BTC/USDT')
        timeframe = data.get('timeframe', '4h')
        limit = data.get('limit', 100)
        exchange = data.get('exchange', 'binance')

        candles = market_data.fetch_ohlcv(symbol, timeframe, limit, exchange)
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
    """Compute technical indicators for a symbol."""
    try:
        sym = symbol.replace('-', '/')
        timeframe = request.args.get('timeframe', '4h')
        limit = int(request.args.get('limit', 200))

        df = market_data.get_candles_df(sym, timeframe, limit)
        if df is None or df.empty:
            return jsonify({'error': 'No data available. Fetch OHLCV first.'}), 404

        indicators = compute_indicators(df)
        return jsonify({
            'symbol': sym,
            'timeframe': timeframe,
            'candles': len(df),
            'indicators': indicators,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/execute-trade', methods=['POST'])
def execute_trade():
    """Execute a paper trade."""
    try:
        data = request.json
        result = paper_trader.execute(data)
        return jsonify(result)
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
    port = int(os.getenv('PYTHON_ENGINE_PORT', 5100))
    app.run(host='127.0.0.1', port=port, debug=os.getenv('NODE_ENV') == 'development')
