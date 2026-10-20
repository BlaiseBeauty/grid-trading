"""
Offline unit tests (stdlib unittest; no DB, no network, no exchange).
Run from the trading/ directory with the project interpreter:
    PYTHONDONTWRITEBYTECODE=1 venv/bin/python -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from datetime import datetime, timezone, timedelta

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import common
import validation
import indicator_core as core
import indicators
import data as data_mod
import monitor
import backtest_engine as bt
import backtest_monte_carlo as mc


class ValidationTests(unittest.TestCase):
    good = {'symbol': 'BTC/USDT', 'side': 'buy', 'quantity': 0.1, 'entry_price': 100,
            'sl_price': 98, 'tp_price': 104, 'mode': 'paper', 'client_order_id': 'abc-123'}

    def test_ok(self):
        clean, err = validation.validate_execute(dict(self.good))
        self.assertIsNone(err)
        self.assertEqual(clean['quantity'], 0.1)

    def test_rejects(self):
        for patch in ({'quantity': 0}, {'quantity': float('nan')}, {'quantity': True}, {'quantity': 'x'},
                      {'side': 'long'}, {'entry_price': -1}, {'symbol': 'BTC;DROP'}, {'mode': 'micro'},
                      {'sl_price': 101}, {'tp_price': 99}, {'client_order_id': 'bad id!'}):
            _, err = validation.validate_execute({**self.good, **patch})
            self.assertIsNotNone(err, patch)
        _, err = validation.validate_execute(None)
        self.assertIsNotNone(err)

    def test_allowlist(self):
        os.environ['ENGINE_ALLOWED_SYMBOLS'] = 'ETH/USDT'
        try:
            _, err = validation.validate_execute(dict(self.good))
            self.assertIsNotNone(err)
        finally:
            del os.environ['ENGINE_ALLOWED_SYMBOLS']

    def test_amend_and_ohlcv(self):
        self.assertIsNone(validation.validate_amend({'trade_id': 3, 'sl_price': 99})[1])
        self.assertIsNotNone(validation.validate_amend({'trade_id': 3})[1])
        self.assertIsNotNone(validation.validate_amend({'trade_id': 'x', 'sl_price': 1})[1])
        clean, err = validation.validate_fetch_ohlcv({'symbol': 'BTC/USDT', 'limit': 50})
        self.assertIsNone(err)
        self.assertGreaterEqual(clean['limit'], 250)


class CommonTests(unittest.TestCase):
    def test_pnl_long_short(self):
        net, pct, fees = common.compute_pnl('buy', 2, 100, 110, 0.2, 0.22)
        self.assertAlmostEqual(net, 20 - 0.42)
        self.assertAlmostEqual(fees, 0.42)
        net_s, _, _ = common.compute_pnl('sell', 2, 100, 90, 0.2, 0.18)
        self.assertAlmostEqual(net_s, 20 - 0.38)

    def test_fee_conversion(self):
        o = {'fee': {'cost': 0.001, 'currency': 'BTC'}}
        self.assertAlmostEqual(common.fee_in_quote(o, 'BTC/USDT', 50000), 50.0)
        self.assertAlmostEqual(common.fee_in_base(o, 'BTC/USDT'), 0.001)
        self.assertAlmostEqual(common.fee_in_quote({'fee': {'cost': 2, 'currency': 'USDT'}}, 'BTC/USDT', 1), 2)
        self.assertIsNone(common.fee_in_quote({'fee': {'cost': 2, 'currency': 'KCS'}}, 'BTC/USDT', 1))
        self.assertIsNone(common.fee_in_quote({}, 'BTC/USDT', 1))

    def test_order_fill(self):
        self.assertEqual(common.order_fill({'average': 10, 'filled': 2}), (10.0, 2.0))
        p, q = common.order_fill({'cost': 20, 'filled': 2})
        self.assertEqual((p, q), (10.0, 2.0))
        self.assertEqual(common.order_fill({}), (None, None))

    def test_validate_amend(self):
        self.assertIsNone(common.validate_amend('buy', 98, 99, None, 100))
        self.assertIsNotNone(common.validate_amend('buy', 98, 97, None, 100))   # loosening
        self.assertIsNotNone(common.validate_amend('sell', 102, 103, None, 100))
        self.assertIsNone(common.validate_amend('sell', 102, 101, None, 100))
        self.assertIsNotNone(common.validate_amend('buy', 98, 101, None, 100))  # would trigger now
        self.assertIsNotNone(common.validate_amend('buy', None, None, None))

    def test_slippage_direction(self):
        self.assertGreater(common.apply_slippage('buy', 100), 100)
        self.assertLess(common.apply_slippage('sell', 100), 100)


class IndicatorTests(unittest.TestCase):
    def _df(self, n, seed=1):
        r = np.random.RandomState(seed)
        c = 100 + np.cumsum(r.randn(n))
        return pd.DataFrame({'open': c, 'high': c + 1, 'low': c - 1, 'close': c, 'volume': r.rand(n) * 10 + 1})

    def test_min_rows(self):
        out = indicators.compute_indicators(self._df(100))
        self.assertNotIn('sma_200', out)
        self.assertIn('sma_50', out)
        out = indicators.compute_indicators(self._df(260))
        self.assertIn('sma_200', out)

    def test_wilder_adx_matches_core_in_both_paths(self):
        df = self._df(300)
        live = indicators._adx(df['high'], df['low'], df['close'])['adx']
        import backtest_signals as bs
        back = bs.adx(df['high'], df['low'], df['close']).iloc[-1]
        self.assertAlmostEqual(live, float(back), places=8)
        self.assertAlmostEqual(indicators._last(indicators._atr(df['high'], df['low'], df['close'])),
                               float(bs.atr(df['high'], df['low'], df['close']).iloc[-1]), places=8)

    def test_backtest_stoch_bbpct_match_live(self):
        import backtest_signals as bs
        df = self._df(300)
        ind = bs.precompute_indicators(df)
        live = indicators.compute_indicators(df)
        self.assertAlmostEqual(live['stoch_k'], float(ind['stoch_k'].iloc[-1]), places=6)
        self.assertAlmostEqual(live['bb_pct'], float(ind['bb_pct'].iloc[-1]), places=6)
        self.assertAlmostEqual(live['bb_bandwidth'], float(ind['bb_bandwidth'].iloc[-1]), places=6)

    def test_drop_forming_candle(self):
        now = datetime(2026, 1, 1, 5, 30, tzinfo=timezone.utc)
        ts = [datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc) + timedelta(hours=4 * i) for i in range(3)]  # 00,04,08
        df = pd.DataFrame({'timestamp': ts[:2], 'close': [1, 2]})
        # 04:00 candle closes 08:00 > now(05:30) -> still forming -> dropped
        self.assertEqual(len(data_mod.drop_forming_candle(df, '4h', now)), 1)
        later = datetime(2026, 1, 1, 8, 0, 1, tzinfo=timezone.utc)
        self.assertEqual(len(data_mod.drop_forming_candle(df, '4h', later)), 2)


class MonitorEvaluateTests(unittest.TestCase):
    P = dict(trail_activate_pct=1.0, trail_distance_pct=2.0)

    def ev(self, side, bars, price, sl, tp, peak=None, act=False):
        return monitor.evaluate_exit(side, 100.0, sl, tp, peak, act, bars, price, slippage_bps=0, **self.P)

    def test_wick_through_stop_between_polls(self):
        # last price recovered to 100, but a candle wicked to 97 (< SL 98)
        r = self.ev('buy', [(100, 101, 97, 100)], 100.0, sl=98, tp=110)
        self.assertEqual(r['action'], 'sl_hit')
        self.assertEqual(r['exit_price'], 98)

    def test_gap_through_stop_fills_at_open(self):
        r = self.ev('buy', [(95, 96, 94, 95)], 95.0, sl=98, tp=110)
        self.assertEqual(r['exit_price'], 95)

    def test_slippage_on_stop(self):
        r = monitor.evaluate_exit('buy', 100, 98, 110, None, False, [(100, 100, 97, 99)], 99, 1.0, 2.0, slippage_bps=10)
        self.assertAlmostEqual(r['exit_price'], 98 * 0.999)

    def test_short_mirror(self):
        r = self.ev('sell', [(100, 103, 99, 101)], 101.0, sl=102, tp=90)
        self.assertEqual(r['action'], 'sl_hit')

    def test_tp_hit(self):
        r = self.ev('buy', [(100, 111, 99.5, 110)], 110.0, sl=98, tp=110)
        self.assertEqual(r['action'], 'tp_hit')

    def test_stop_beats_tp_in_same_bar(self):
        r = self.ev('buy', [(100, 111, 97, 105)], 105.0, sl=98, tp=110)
        self.assertEqual(r['action'], 'sl_hit')

    def test_trail_never_looser_than_sl(self):
        # SL very tight at 99.5: trail (peak 101 -> 98.98) is looser, SL must govern
        stop, kind = monitor._effective_stop(True, 99.5, 101.0, True, 2.0)
        self.assertEqual((stop, kind), (99.5, 'sl_hit'))
        # SL far below: trail governs
        stop, kind = monitor._effective_stop(True, 90.0, 110.0, True, 2.0)
        self.assertEqual(kind, 'trail_hit')
        self.assertAlmostEqual(stop, 107.8)

    def test_trail_hit_after_run_up(self):
        bars = [(100, 106, 100, 106), (106, 106, 103, 104)]   # peak 106 -> trail 103.88; 2nd bar low 103
        r = self.ev('buy', bars, 104.0, sl=95, tp=200)
        self.assertEqual(r['action'], 'trail_hit')
        self.assertAlmostEqual(r['exit_price'], 106 * 0.98)

    def test_bar_cannot_trigger_its_own_trail(self):
        r = self.ev('buy', [(100, 110, 100, 108)], 108.0, sl=95, tp=200)
        self.assertIsNone(r['action'])
        self.assertEqual(r['peak'], 110)


class BacktestHelperTests(unittest.TestCase):
    def test_bars_per_year(self):
        self.assertEqual(bt.bars_per_year('4h'), 2190)
        self.assertEqual(bt.bars_per_year('1h'), 8760)
        self.assertEqual(bt.bars_per_year('1d'), 365)

    def test_drawdown_per_bar(self):
        self.assertAlmostEqual(bt.max_drawdown_pct([100, 120, 90, 110]), 25.0)

    def test_sharpe_flat_zero(self):
        self.assertEqual(bt.sharpe_from_equity([100] * 10, 2190), 0.0)
        self.assertGreater(bt.sharpe_from_equity([100, 101, 102.5, 103, 105], 2190), 0)

    def test_gap_and_slippage(self):
        self.assertEqual(bt.stop_fill_price('long', 98, 95, 0), 95)      # gapped below stop
        self.assertEqual(bt.stop_fill_price('long', 98, 99, 0), 98)
        self.assertEqual(bt.stop_fill_price('short', 102, 105, 0), 105)
        self.assertEqual(bt.target_fill_price('long', 104, 106), 106)    # gapped above target
        self.assertAlmostEqual(bt.apply_slippage('long', 100, 5, True), 100.05)
        self.assertAlmostEqual(bt.apply_slippage('long', 100, 5, False), 99.95)

    def test_fees_once_equity_matches_pnl(self):
        eng = bt.BacktestEngine.__new__(bt.BacktestEngine)
        eng.run_id, eng.initial_capital = 1, 10000.0
        eng.equity = 10000.0
        eng.fee_bps, eng.slippage_bps = 10.0, 0.0
        eng.in_sample_cutoff = None
        eng.closed_trades = []
        eng.open_positions = {}
        entry_fee = 1000 * 10 / 10000
        eng.equity -= entry_fee
        eng.open_positions['X'] = {
            'symbol': 'X', 'side': 'long', 'template_id': 1, 'template_name': 't', 'regime': 'r',
            'confidence': 60, 'entry_price': 100.0, 'entry_time': pd.Timestamp('2026-01-01', tz='UTC'),
            'position_size_pct': 10.0, 'position_usd': 1000.0, 'signals_matched': [], 'entry_fee': entry_fee}
        eng._close_position('X', 110.0, pd.Timestamp('2026-01-02', tz='UTC'), 'take_profit')
        t = eng.closed_trades[0]
        self.assertAlmostEqual(eng.equity - 10000.0, t['pnl_usd'], places=3)   # sum(pnl) == delta equity
        self.assertAlmostEqual(t['fees_paid'], 1.0 + 1.1, places=3)


class MonteCarloTests(unittest.TestCase):
    def test_bootstrap_compounds_percent_returns(self):
        trades = [{'pnl_pct': 10.0, 'position_size_pct': 5.0, 'pnl_usd': 50.0}] * 4
        res = mc.simulate_equity(mc.trade_equity_returns(trades), 10000)
        self.assertAlmostEqual(res['final_equity'], 10000 * 1.005 ** 4, places=4)
        out = mc.monte_carlo(trades, 50, seed=1)
        self.assertAlmostEqual(out['return']['std'], 0.0, places=9)   # identical trades -> identical paths


# ── LiveTrader safety paths with a fake exchange + fake DB ───────────────────

class FakeCursor:
    def __init__(self, db):
        self.db = db
        self.description = None
        self._row = None
        self.rowcount = 1

    def execute(self, sql, params=None):
        s = ' '.join(sql.split())
        self.db.log.append((s, params))
        self._row, self.description = None, None
        if 'information_schema' in s:
            self._row = (1,)
        elif s.startswith('SELECT * FROM trades WHERE client_order_id'):
            row = self.db.by_coid.get(params[0])
            self.description = [(k,) for k in row] if row else [('id',)]   # psycopg2 sets it even with 0 rows
            if row:
                self._row = tuple(row.values())
        elif s.startswith('INSERT INTO trades'):
            self.db.next_id += 1
            self._row = (self.db.next_id,)
        elif s.startswith('UPDATE trades SET exchange_sl_order_id'):
            self.db.sl_updates.append(params)

    def fetchone(self):
        return self._row

    def close(self):
        pass


class FakeConn:
    def __init__(self, db):
        self.db = db

    def cursor(self):
        return FakeCursor(self.db)

    def commit(self):
        pass

    def rollback(self):
        pass

    def close(self):
        pass


class FakeDB:
    def __init__(self):
        self.log, self.by_coid, self.next_id, self.sl_updates = [], {}, 0, []

    def conn(self):
        return FakeConn(self)


class FakeExchange:
    def __init__(self, fail_sl=False):
        self.orders, self.fail_sl = [], fail_sl

    def create_order(self, symbol, type_, side, amount, price=None, params=None):
        params = params or {}
        self.orders.append((type_, side, amount, params))
        if 'stopLossPrice' in params:
            if self.fail_sl:
                raise RuntimeError('exchange down')
            return {'id': 'SL1', 'status': 'open'}
        return {'id': f'O{len(self.orders)}', 'status': 'closed', 'average': 100.0, 'filled': amount,
                'fee': {'cost': 0.1, 'currency': 'USDT'}}

    def fetch_order(self, *a, **k):
        import ccxt
        raise ccxt.OrderNotFound('nope')

    def amount_to_precision(self, symbol, amount):
        return str(amount)


class LiveTests(unittest.TestCase):
    def setUp(self):
        import live
        self.live = live
        live.SL_RETRY_DELAYS = (0, 0, 0)
        self.db = FakeDB()
        self.t = live.LiveTrader()
        self.t._get_db = lambda: self.db.conn()
        self.t._has_coid_col = True
        self.td = {'symbol': 'BTC/USDT', 'side': 'buy', 'quantity': 1.0, 'entry_price': 100.0,
                   'sl_price': 98.0, 'tp_price': 105.0, 'client_order_id': 'cid1'}

    def test_happy_path_uses_real_fill_and_fee(self):
        ex = FakeExchange()
        self.t._get_exchange = lambda: ex
        r = self.t.execute(dict(self.td))
        self.assertEqual(r['exchange_sl_order_id'], 'SL1')
        self.assertEqual(r['fee'], 0.1)                      # exchange fee, not 0.1% estimate (=0.1 too) -> check below
        self.assertEqual(ex.orders[0][3].get('clientOid'), 'cid1')
        inserts = [p for s, p in self.db.log if s.startswith('INSERT')]
        self.assertEqual(inserts[0][-2], 'pending')          # pending row written BEFORE the exchange call

    def test_sl_failure_flattens_and_errors(self):
        ex = FakeExchange(fail_sl=True)
        self.t._get_exchange = lambda: ex
        with self.assertRaises(self.live.LiveTradeError) as cm:
            self.t.execute(dict(self.td))
        self.assertTrue(cm.exception.payload.get('flattened'))
        sides = [o[1] for o in ex.orders if 'stopLossPrice' not in o[3]]
        self.assertEqual(sides, ['buy', 'sell'])             # entry then market close

    def test_idempotent_replay_places_no_order(self):
        ex = FakeExchange()
        self.t._get_exchange = lambda: ex
        self.db.by_coid['cid1'] = {'id': 7, 'symbol': 'BTC/USDT', 'side': 'buy', 'quantity': 1.0,
                                   'entry_price': 100.0, 'actual_fill_price': 100.0,
                                   'expected_fill_price': 100.0, 'entry_fee': 0.1, 'status': 'open',
                                   'exchange_entry_order_id': 'O1', 'exchange_sl_order_id': 'SL1',
                                   'exchange_tp_order_id': None, 'client_order_id': 'cid1'}
        r = self.t.execute(dict(self.td))
        self.assertTrue(r['idempotent_replay'])
        self.assertEqual(ex.orders, [])


if __name__ == '__main__':
    unittest.main()
