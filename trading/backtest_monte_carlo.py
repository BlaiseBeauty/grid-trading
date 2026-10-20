"""
GRID Monte Carlo Simulation & Parameter Sensitivity Analysis

1. Monte Carlo: bootstrap per-trade equity returns (percent, with replacement) on compounding equity
2. Parameter Sensitivity: Sweep SL/TP/position_size/drawdown_limit parameters
3. Outputs summary statistics and percentile distributions

Usage:
  python backtest_monte_carlo.py --run-id 3
"""

import os
import sys
import json
import argparse
import numpy as np
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))


def get_db():
    return psycopg2.connect(os.getenv('DATABASE_URL', 'postgresql://localhost:5432/grid'))


def load_trades(conn, run_id):
    """Load all trades from a backtest run."""
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("""
        SELECT pnl_pct, pnl_usd, position_size_pct, close_reason, template_name, regime,
               confidence, is_in_sample, side, symbol, entry_time, exit_time
        FROM backtest_trades
        WHERE run_id = %s
        ORDER BY exit_time ASC
    """, (run_id,))
    trades = cur.fetchall()
    cur.close()
    return trades


def _trades_per_year(trades):
    """Observed trade frequency (trades/year) from the first entry to the last exit."""
    try:
        start = min(t['entry_time'] for t in trades)
        end = max(t['exit_time'] for t in trades)
        years = (end - start).total_seconds() / (365 * 24 * 3600)
        if years > 0:
            return len(trades) / years
    except (KeyError, TypeError, AttributeError) as e:
        print(f'  (could not derive trade frequency: {e}; assuming 100 trades/year)')
    return 100.0


def trade_equity_returns(trades):
    """Per-trade return as a FRACTION OF EQUITY: net position return (pnl_pct,
    % of position notional) x position size (% of equity at entry)."""
    return [float(t['pnl_pct']) / 100.0 * float(t['position_size_pct']) / 100.0 for t in trades]


def simulate_equity(return_sequence, initial_capital=10000, drawdown_limit=None):
    """Simulate a COMPOUNDING equity curve from a sequence of per-trade equity
    returns (fractions, e.g. 0.004 = +0.4% of equity)."""
    equity = initial_capital
    peak = initial_capital
    max_dd = 0
    curve = [equity]

    for r in return_sequence:
        equity *= max(0.0, 1.0 + float(r))
        if equity > peak:
            peak = equity
        dd = (peak - equity) / peak * 100 if peak > 0 else 0
        if dd > max_dd:
            max_dd = dd
        if drawdown_limit and dd > drawdown_limit:
            break
        curve.append(equity)

    total_return = (equity - initial_capital) / initial_capital * 100
    return {
        'final_equity': equity,
        'total_return': total_return,
        'max_drawdown': max_dd,
        'trades_executed': len(curve) - 1,
    }


def monte_carlo(trades, n_simulations=1000, initial_capital=10000, drawdown_limit=None, seed=None):
    """Monte Carlo by BOOTSTRAPPING trade returns (percent of equity, sampled
    with replacement) applied to compounding equity. Reshuffling dollar P&L
    (the old method) ignores compounding and keeps every path's total fixed."""
    returns_pct = np.array(trade_equity_returns(trades), dtype=float)
    n_trades = len(returns_pct)
    rng = np.random.default_rng(seed)

    results = []
    for _ in range(n_simulations):
        sample = rng.choice(returns_pct, size=n_trades, replace=True)
        result = simulate_equity(sample, initial_capital, drawdown_limit)
        results.append(result)

    returns = [r['total_return'] for r in results]
    drawdowns = [r['max_drawdown'] for r in results]
    equities = [r['final_equity'] for r in results]

    return {
        'n_simulations': n_simulations,
        'n_trades': n_trades,
        'return': {
            'mean': np.mean(returns),
            'median': np.median(returns),
            'std': np.std(returns),
            'p5': np.percentile(returns, 5),
            'p25': np.percentile(returns, 25),
            'p75': np.percentile(returns, 75),
            'p95': np.percentile(returns, 95),
            'worst': np.min(returns),
            'best': np.max(returns),
        },
        'max_drawdown': {
            'mean': np.mean(drawdowns),
            'median': np.median(drawdowns),
            'p5': np.percentile(drawdowns, 5),
            'p95': np.percentile(drawdowns, 95),
            'worst': np.max(drawdowns),
        },
        'final_equity': {
            'mean': np.mean(equities),
            'median': np.median(equities),
            'p5': np.percentile(equities, 5),
            'p95': np.percentile(equities, 95),
        },
        'profit_probability': sum(1 for r in returns if r > 0) / len(returns) * 100,
    }


def parameter_sensitivity(trades, initial_capital=10000):
    """Sweep parameters and show how results change."""
    results = []

    # Per-trade equity returns (fractions); the trade sequence is replayed in order.
    base_returns = trade_equity_returns(trades)
    base_pnl_pct = [float(t['pnl_pct']) for t in trades]
    trades_per_year = _trades_per_year(trades)

    # 1. Drawdown limit sensitivity
    print('\n  DRAWDOWN LIMIT SENSITIVITY:')
    print(f'  {"Limit":<12} {"Return":<12} {"Max DD":<12} {"Trades":<10} {"Sharpe":<10}')
    print(f'  {"─"*12} {"─"*12} {"─"*12} {"─"*10} {"─"*10}')
    for dd_limit in [15, 20, 25, 30, 40, 50, None]:
        result = simulate_equity(base_returns, initial_capital, dd_limit)
        # Per-trade Sharpe on equity returns, annualised by the observed trade frequency
        executed = np.array(base_returns[:result['trades_executed']], dtype=float)
        if len(executed) > 1 and executed.std(ddof=1) > 0:
            sharpe = executed.mean() / executed.std(ddof=1) * np.sqrt(trades_per_year)
        else:
            sharpe = 0
        label = f'{dd_limit}%' if dd_limit else 'None'
        print(f'  {label:<12} {result["total_return"]:>+8.2f}%   {result["max_drawdown"]:>8.2f}%   '
              f'{result["trades_executed"]:<10} {sharpe:>+.4f}')

    # 2. Position size multiplier sensitivity
    print('\n  POSITION SIZE MULTIPLIER:')
    print(f'  {"Multiplier":<12} {"Return":<12} {"Max DD":<12} {"Final $":<10}')
    print(f'  {"─"*12} {"─"*12} {"─"*12} {"─"*10}')
    for mult in [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0]:
        scaled = [r * mult for r in base_returns]
        result = simulate_equity(scaled, initial_capital, None)
        print(f'  {mult:<12.2f} {result["total_return"]:>+8.2f}%   {result["max_drawdown"]:>8.2f}%   '
              f'${result["final_equity"]:>8.2f}')

    # 3. Win rate needed for breakeven analysis
    wins = sum(1 for t in trades if float(t['pnl_usd']) > 0)       # net pnl
    losses = sum(1 for t in trades if float(t['pnl_usd']) <= 0)
    avg_win = np.mean([float(t['pnl_pct']) for t in trades if float(t['pnl_pct']) > 0]) if wins else 0
    avg_loss = abs(np.mean([float(t['pnl_pct']) for t in trades if float(t['pnl_pct']) <= 0])) if losses else 0

    if avg_win + avg_loss > 0:
        breakeven_wr = avg_loss / (avg_win + avg_loss) * 100
    else:
        breakeven_wr = 50

    print(f'\n  BREAKEVEN ANALYSIS:')
    print(f'  Avg Win:       {avg_win:+.4f}%')
    print(f'  Avg Loss:      {-avg_loss:+.4f}%')
    print(f'  Win/Loss Ratio: {avg_win/avg_loss:.2f}:1' if avg_loss > 0 else '  Win/Loss Ratio: N/A')
    print(f'  Breakeven WR:  {breakeven_wr:.1f}%')
    print(f'  Actual WR:     {wins/(wins+losses)*100:.1f}%')
    print(f'  Edge:          {wins/(wins+losses)*100 - breakeven_wr:+.1f}pp')

    # 4. By close reason analysis
    print(f'\n  BY CLOSE REASON:')
    print(f'  {"Reason":<20} {"Count":<8} {"Avg PnL":<10} {"Win Rate":<10}')
    print(f'  {"─"*20} {"─"*8} {"─"*10} {"─"*10}')
    reasons = {}
    for t in trades:
        r = t['close_reason']
        pnl = float(t['pnl_pct'])
        if r not in reasons:
            reasons[r] = {'count': 0, 'total_pnl': 0, 'wins': 0}
        reasons[r]['count'] += 1
        reasons[r]['total_pnl'] += pnl
        if pnl > 0:
            reasons[r]['wins'] += 1
    for r, s in sorted(reasons.items(), key=lambda x: x[1]['count'], reverse=True):
        avg = s['total_pnl'] / s['count']
        wr = s['wins'] / s['count'] * 100
        print(f'  {r:<20} {s["count"]:<8} {avg:>+.4f}%   {wr:.1f}%')


def main():
    parser = argparse.ArgumentParser(description='Monte Carlo & Parameter Sensitivity')
    parser.add_argument('--run-id', type=int, required=True, help='Backtest run ID to analyze')
    parser.add_argument('--simulations', type=int, default=1000, help='Number of MC simulations')
    args = parser.parse_args()

    conn = get_db()
    trades = load_trades(conn, args.run_id)
    conn.close()

    if not trades:
        print(f'No trades found for run #{args.run_id}')
        sys.exit(1)

    print(f'\n═══════════════════════════════════════════════')
    print(f'  MONTE CARLO & SENSITIVITY — Run #{args.run_id}')
    print(f'  {len(trades)} trades, {args.simulations} MC simulations')
    print(f'═══════════════════════════════════════════════')

    # 1. Monte Carlo (no drawdown limit for pure distribution)
    print(f'\n  MONTE CARLO SIMULATION (no drawdown limit):')
    mc = monte_carlo(trades, args.simulations, drawdown_limit=None)
    print(f'  Return Distribution:')
    print(f'    Mean:   {mc["return"]["mean"]:>+8.2f}%')
    print(f'    Median: {mc["return"]["median"]:>+8.2f}%')
    print(f'    Std:    {mc["return"]["std"]:>8.2f}%')
    print(f'    5th:    {mc["return"]["p5"]:>+8.2f}%  (worst 5%)')
    print(f'    25th:   {mc["return"]["p25"]:>+8.2f}%')
    print(f'    75th:   {mc["return"]["p75"]:>+8.2f}%')
    print(f'    95th:   {mc["return"]["p95"]:>+8.2f}%  (best 5%)')
    print(f'    Worst:  {mc["return"]["worst"]:>+8.2f}%')
    print(f'    Best:   {mc["return"]["best"]:>+8.2f}%')
    print(f'\n  Max Drawdown Distribution:')
    print(f'    Mean:   {mc["max_drawdown"]["mean"]:>8.2f}%')
    print(f'    Median: {mc["max_drawdown"]["median"]:>8.2f}%')
    print(f'    5th:    {mc["max_drawdown"]["p5"]:>8.2f}%  (best case)')
    print(f'    95th:   {mc["max_drawdown"]["p95"]:>8.2f}%  (worst case)')
    print(f'\n  Probability of Profit: {mc["profit_probability"]:.1f}%')

    # 2. Monte Carlo with drawdown limit
    print(f'\n  MONTE CARLO WITH 25% DD LIMIT:')
    mc_dd = monte_carlo(trades, args.simulations, drawdown_limit=25)
    print(f'    Mean Return:  {mc_dd["return"]["mean"]:>+8.2f}%')
    print(f'    Median Return:{mc_dd["return"]["median"]:>+8.2f}%')
    print(f'    P(Profit):    {mc_dd["profit_probability"]:.1f}%')

    # 3. Parameter sensitivity
    parameter_sensitivity(trades)

    print(f'\n═══════════════════════════════════════════════')


if __name__ == '__main__':
    main()
