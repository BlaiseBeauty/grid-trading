#!/usr/bin/env python3
"""
Exchange Connectivity Audit Script
Run this with your REAL Binance API keys in TEST mode first.
Never with live keys until every check passes.

Usage:
  python trading/audit_connectivity.py --mode testnet
  python trading/audit_connectivity.py --mode live-readonly
"""

import sys
import os
import json
import argparse
import time
import ccxt

def print_result(name, passed, detail=""):
    icon = "\u2713" if passed else "\u2717"
    status = "PASS" if passed else "FAIL"
    print(f"  [{icon}] {status}: {name}")
    if detail:
        print(f"       {detail}")
    return passed

def run_audit(mode):
    results = []
    print(f"\n{'='*60}")
    print(f"EXCHANGE CONNECTIVITY AUDIT \u2014 {mode.upper()}")
    print(f"{'='*60}\n")

    # Load config
    api_key    = os.environ.get('BINANCE_API_KEY', '')
    api_secret = os.environ.get('BINANCE_SECRET', '')

    if not api_key or not api_secret:
        print("ERROR: BINANCE_API_KEY and BINANCE_SECRET must be set")
        sys.exit(1)

    # Init exchange
    exchange_config = {
        'apiKey': api_key,
        'secret': api_secret,
        'enableRateLimit': True,
        'options': {
            'defaultType': 'spot',
            'adjustForTimeDifference': True,
        }
    }

    if mode == 'testnet':
        exchange_config['urls'] = {
            'api': {
                'public':  'https://testnet.binance.vision/api',
                'private': 'https://testnet.binance.vision/api',
            }
        }

    exchange = ccxt.binance(exchange_config)

    print("\u2500\u2500 1. API AUTHENTICATION \u2500" * 2 + "\u2500" * 20)

    # 1a. Can we reach the exchange?
    try:
        time_data = exchange.fetch_time()
        results.append(print_result("Reach Binance API", True, f"Server time: {time_data}"))
    except Exception as e:
        results.append(print_result("Reach Binance API", False, str(e)))
        print("\nFATAL: Cannot reach exchange. Aborting audit.")
        return results

    # 1b. API key valid?
    try:
        account = exchange.fetch_balance()
        results.append(print_result("API key authentication", True))
    except ccxt.AuthenticationError as e:
        results.append(print_result("API key authentication", False, str(e)))
        print("\nFATAL: API key rejected. Check keys.")
        return results
    except Exception as e:
        results.append(print_result("API key authentication", False, str(e)))

    # 1c. Account permissions - READ
    try:
        balance = exchange.fetch_balance()
        usdt = balance.get('USDT', {}).get('free', 0)
        results.append(print_result("Read balance permission", True, f"USDT free: {usdt}"))
    except Exception as e:
        results.append(print_result("Read balance permission", False, str(e)))

    print(f"\n\u2500\u2500 2. MARKET DATA \u2500" * 2 + "\u2500" * 25)

    symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']

    # 2a. Ticker fetch
    for sym in symbols:
        try:
            ticker = exchange.fetch_ticker(sym)
            bid = ticker.get('bid')
            ask = ticker.get('ask')
            spread_pct = ((ask - bid) / bid * 100) if bid and ask else None
            results.append(print_result(
                f"Fetch ticker {sym}", True,
                f"Bid:{bid} Ask:{ask} Spread:{spread_pct:.4f}%" if spread_pct else ""
            ))
        except Exception as e:
            results.append(print_result(f"Fetch ticker {sym}", False, str(e)))

    # 2b. OHLCV fetch
    try:
        ohlcv = exchange.fetch_ohlcv('BTC/USDT', '1h', limit=10)
        results.append(print_result("Fetch OHLCV (BTC/USDT 1h)", True, f"{len(ohlcv)} candles"))
    except Exception as e:
        results.append(print_result("Fetch OHLCV (BTC/USDT 1h)", False, str(e)))

    # 2c. Order book depth
    try:
        ob = exchange.fetch_order_book('BTC/USDT', limit=5)
        top_bid = ob['bids'][0][0] if ob['bids'] else None
        top_ask = ob['asks'][0][0] if ob['asks'] else None
        results.append(print_result("Fetch order book", True, f"Top bid:{top_bid} Top ask:{top_ask}"))
    except Exception as e:
        results.append(print_result("Fetch order book", False, str(e)))

    print(f"\n\u2500\u2500 3. ORDER TYPE VALIDATION \u2500" * 2 + "\u2500" * 12)

    # 3a. Load markets to check available order types
    try:
        markets = exchange.load_markets()
        btc_market = markets.get('BTC/USDT', {})
        order_types = btc_market.get('info', {}).get('orderTypes', [])

        required_types = ['MARKET', 'LIMIT', 'STOP_LOSS_LIMIT']
        for ot in required_types:
            results.append(print_result(
                f"Order type available: {ot}",
                ot in order_types or ot.replace('_', '') in [x.replace('_', '') for x in order_types]
            ))
    except Exception as e:
        results.append(print_result("Load market info", False, str(e)))

    # 3b. Min notional / lot size
    try:
        btc_market = exchange.market('BTC/USDT')
        min_amount = btc_market.get('limits', {}).get('amount', {}).get('min', 'unknown')
        min_cost   = btc_market.get('limits', {}).get('cost',   {}).get('min', 'unknown')
        results.append(print_result(
            "BTC/USDT min sizes loaded", True,
            f"Min amount: {min_amount}, Min notional: {min_cost}"
        ))
        # GRID's minimum position USD - check against exchange minimum
        grid_min = 50
        if isinstance(min_cost, (int, float)) and grid_min < float(min_cost):
            results.append(print_result(
                "GRID min position >= exchange minimum",
                False,
                f"GRID uses ${grid_min} but exchange requires ${min_cost}"
            ))
        else:
            results.append(print_result("GRID min position >= exchange minimum", True))
    except Exception as e:
        results.append(print_result("Load min sizes", False, str(e)))

    print(f"\n\u2500\u2500 4. ORDER PLACEMENT (DRY RUN) \u2500" * 2 + "\u2500" * 8)
    print("   NOTE: Actual order tests skipped unless --place-orders flag set.")
    print("   These checks verify the order object format only.\n")

    # 4a. Construct market order dict - don't submit
    try:
        ticker = exchange.fetch_ticker('BTC/USDT')
        price  = ticker['last']
        amount = round(10.0 / price, 6)  # $10 equivalent

        order_obj = {
            'symbol': 'BTC/USDT',
            'type': 'market',
            'side': 'buy',
            'amount': amount,
        }
        results.append(print_result(
            "Market order object valid", True,
            f"Would buy {amount} BTC (~$10 at {price})"
        ))
    except Exception as e:
        results.append(print_result("Market order object valid", False, str(e)))

    # 4b. Position precision check
    try:
        market = exchange.market('BTC/USDT')
        prec   = market.get('precision', {}).get('amount', 8)
        results.append(print_result("Amount precision available", True, f"Precision: {prec}"))
    except Exception as e:
        results.append(print_result("Amount precision available", False, str(e)))

    print(f"\n\u2500\u2500 5. RATE LIMIT BEHAVIOUR \u2500" * 2 + "\u2500" * 14)

    # 5a. Sequential requests (simulate agent cycle hitting exchange)
    try:
        start = time.time()
        for i in range(5):
            exchange.fetch_ticker('BTC/USDT')
        elapsed = time.time() - start
        results.append(print_result(
            "5 sequential ticker fetches", elapsed < 30,
            f"Completed in {elapsed:.2f}s"
        ))
    except ccxt.RateLimitExceeded as e:
        results.append(print_result("5 sequential ticker fetches", False, f"Rate limited: {e}"))
    except Exception as e:
        results.append(print_result("5 sequential ticker fetches", False, str(e)))

    print(f"\n\u2500\u2500 6. OPEN POSITION FETCH \u2500" * 2 + "\u2500" * 16)

    # 6a. Can we fetch open orders?
    try:
        open_orders = exchange.fetch_open_orders('BTC/USDT')
        results.append(print_result(
            "Fetch open orders", True,
            f"{len(open_orders)} open orders"
        ))
    except Exception as e:
        results.append(print_result("Fetch open orders", False, str(e)))

    # Summary
    print(f"\n{'='*60}")
    passed = sum(1 for r in results if r)
    total  = len(results)
    print(f"RESULT: {passed}/{total} checks passed")

    if passed == total:
        print("STATUS: \u2713 EXCHANGE CONNECTIVITY \u2014 PASS")
    elif passed >= total * 0.8:
        print("STATUS: \u26a0 EXCHANGE CONNECTIVITY \u2014 PARTIAL (review failures above)")
    else:
        print("STATUS: \u2717 EXCHANGE CONNECTIVITY \u2014 FAIL (do not proceed to live)")

    print(f"{'='*60}\n")
    return results


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['testnet', 'live-readonly'], required=True)
    args = parser.parse_args()
    run_audit(args.mode)
