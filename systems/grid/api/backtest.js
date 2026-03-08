'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { query, queryOne, queryAll } = require('../../../db/connection');

async function routes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // POST /api/backtest/run — start a new backtest
  fastify.post('/backtest/run', async (request, reply) => {
    const {
      name = 'Backtest Run',
      symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe = '4h',
      date_from = '2022-01-01',
      date_to = new Date().toISOString().slice(0, 10),
      in_sample_cutoff = '2024-01-01',
    } = request.body || {};

    // Create run record
    const result = await query(`
      INSERT INTO backtest_runs (name, symbols, timeframe, date_from, date_to, in_sample_cutoff, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING id
    `, [name, JSON.stringify(symbols), timeframe, date_from, date_to, in_sample_cutoff]);

    const runId = result.rows[0].id;

    // Spawn Python backtest engine as background process
    const pythonPath = path.join(__dirname, '..', '..', '..', 'trading', 'venv', 'bin', 'python');
    const scriptPath = path.join(__dirname, '..', '..', '..', 'trading', 'backtest_engine.py');

    const child = spawn(pythonPath, [scriptPath, '--run-id', String(runId)], {
      cwd: path.join(__dirname, '..', '..', '..', 'trading'),
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Stream progress via WebSocket
    let progressInterval = null;
    const progressFile = `/tmp/backtest_progress_${runId}.json`;

    progressInterval = setInterval(() => {
      try {
        if (fs.existsSync(progressFile)) {
          const data = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
          fastify.broadcast('backtest_progress', data);
        }
      } catch { /* ignore read errors */ }
    }, 2000);

    child.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`[BACKTEST #${runId}] ${line}`);
    });

    child.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.error(`[BACKTEST #${runId}] ${line}`);
    });

    child.on('close', (code) => {
      if (progressInterval) clearInterval(progressInterval);
      try { fs.unlinkSync(progressFile); } catch { /* ignore */ }

      if (code === 0) {
        fastify.broadcast('backtest_complete', { run_id: runId });
      } else {
        fastify.broadcast('backtest_failed', { run_id: runId, exit_code: code });
      }
    });

    child.unref();

    return reply.code(201).send({ run_id: runId, status: 'pending' });
  });

  // GET /api/backtest/runs — list all runs
  fastify.get('/backtest/runs', async (request) => {
    const rows = await queryAll(`
      SELECT id, name, symbols, timeframe, date_from, date_to, in_sample_cutoff,
             status, total_trades, win_rate, total_return, sharpe_ratio, max_drawdown,
             created_at, completed_at, error_text
      FROM backtest_runs
      ORDER BY created_at DESC
      LIMIT 50
    `);
    return { runs: rows };
  });

  // GET /api/backtest/runs/:id — run detail with trades
  fastify.get('/backtest/runs/:id', async (request) => {
    const { id } = request.params;

    const run = await queryOne(
      'SELECT * FROM backtest_runs WHERE id = $1', [id]
    );
    if (!run) return { error: 'Run not found' };

    const trades = await queryAll(`
      SELECT id, symbol, side, template_id, template_name, regime, confidence,
             entry_price, exit_price, entry_time, exit_time, pnl_pct, pnl_usd,
             position_size_pct, close_reason, signals_matched, is_in_sample, fees_paid
      FROM backtest_trades
      WHERE run_id = $1
      ORDER BY entry_time ASC
    `, [id]);

    // Compute additional breakdowns
    const byRegime = {};
    const byTemplate = {};
    const bySymbol = {};

    for (const t of trades) {
      // By regime
      if (!byRegime[t.regime]) byRegime[t.regime] = { trades: 0, wins: 0, total_pnl: 0 };
      byRegime[t.regime].trades++;
      if (parseFloat(t.pnl_pct) > 0) byRegime[t.regime].wins++;
      byRegime[t.regime].total_pnl += parseFloat(t.pnl_pct);

      // By template
      const tn = t.template_name || 'Unknown';
      if (!byTemplate[tn]) byTemplate[tn] = { template_id: t.template_id, trades: 0, wins: 0, total_pnl: 0, returns: [] };
      byTemplate[tn].trades++;
      if (parseFloat(t.pnl_pct) > 0) byTemplate[tn].wins++;
      byTemplate[tn].total_pnl += parseFloat(t.pnl_pct);
      byTemplate[tn].returns.push(parseFloat(t.pnl_pct));

      // By symbol
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, wins: 0, total_pnl: 0 };
      bySymbol[t.symbol].trades++;
      if (parseFloat(t.pnl_pct) > 0) bySymbol[t.symbol].wins++;
      bySymbol[t.symbol].total_pnl += parseFloat(t.pnl_pct);
    }

    // Compute per-template Sharpe
    for (const [name, data] of Object.entries(byTemplate)) {
      const returns = data.returns;
      if (returns.length > 1) {
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const std = Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length);
        data.sharpe = std > 0 ? (mean / std) * Math.sqrt(2190) : 0;  // annualized for 4h
      } else {
        data.sharpe = 0;
      }
      delete data.returns;
      data.win_rate = data.trades > 0 ? (data.wins / data.trades * 100) : 0;
      data.avg_return = data.trades > 0 ? data.total_pnl / data.trades : 0;
    }

    // Format regime and symbol stats
    for (const data of Object.values(byRegime)) {
      data.win_rate = data.trades > 0 ? (data.wins / data.trades * 100) : 0;
      data.avg_pnl = data.trades > 0 ? data.total_pnl / data.trades : 0;
    }
    for (const data of Object.values(bySymbol)) {
      data.win_rate = data.trades > 0 ? (data.wins / data.trades * 100) : 0;
      data.avg_pnl = data.trades > 0 ? data.total_pnl / data.trades : 0;
    }

    // In-sample vs Out-of-sample comparison
    const inSample = trades.filter(t => t.is_in_sample);
    const outSample = trades.filter(t => !t.is_in_sample);

    const sampleComparison = {
      in_sample: {
        trades: inSample.length,
        win_rate: inSample.length > 0 ? (inSample.filter(t => parseFloat(t.pnl_pct) > 0).length / inSample.length * 100) : 0,
        avg_return: inSample.length > 0 ? inSample.reduce((a, t) => a + parseFloat(t.pnl_pct), 0) / inSample.length : 0,
        total_return: inSample.reduce((a, t) => a + parseFloat(t.pnl_pct), 0),
      },
      out_of_sample: {
        trades: outSample.length,
        win_rate: outSample.length > 0 ? (outSample.filter(t => parseFloat(t.pnl_pct) > 0).length / outSample.length * 100) : 0,
        avg_return: outSample.length > 0 ? outSample.reduce((a, t) => a + parseFloat(t.pnl_pct), 0) / outSample.length : 0,
        total_return: outSample.reduce((a, t) => a + parseFloat(t.pnl_pct), 0),
      },
    };

    // Compute validation status
    if (sampleComparison.in_sample.win_rate > 0 && sampleComparison.out_of_sample.trades > 0) {
      const wrDiff = Math.abs(sampleComparison.in_sample.win_rate - sampleComparison.out_of_sample.win_rate);
      const wrPctDiff = wrDiff / sampleComparison.in_sample.win_rate * 100;
      if (wrPctDiff <= 10) {
        sampleComparison.validation = 'VALIDATED';
      } else if (wrPctDiff > 20) {
        sampleComparison.validation = 'OVERFITTED';
      } else {
        sampleComparison.validation = 'INCONCLUSIVE';
      }
    } else {
      sampleComparison.validation = 'INSUFFICIENT_DATA';
    }

    return {
      run,
      trades,
      breakdowns: { byRegime, byTemplate, bySymbol },
      sampleComparison,
    };
  });

  // GET /api/backtest/runs/:id/equity-curve
  fastify.get('/backtest/runs/:id/equity-curve', async (request) => {
    const { id } = request.params;

    const run = await queryOne('SELECT * FROM backtest_runs WHERE id = $1', [id]);
    if (!run) return { error: 'Run not found' };

    // Reconstruct equity curve from trades
    const trades = await queryAll(`
      SELECT exit_time, pnl_usd, is_in_sample
      FROM backtest_trades
      WHERE run_id = $1
      ORDER BY exit_time ASC
    `, [id]);

    const initialCapital = 10000;
    let equity = initialCapital;
    const curve = [{ timestamp: run.date_from, equity: initialCapital, is_in_sample: true }];

    for (const t of trades) {
      equity += parseFloat(t.pnl_usd);
      curve.push({
        timestamp: t.exit_time,
        equity: Math.round(equity * 100) / 100,
        is_in_sample: t.is_in_sample,
      });
    }

    return { curve, initial_capital: initialCapital };
  });

  // POST /api/backtest/runs/:id/feed-learnings
  fastify.post('/backtest/runs/:id/feed-learnings', async (request) => {
    const { id } = request.params;

    const run = await queryOne('SELECT * FROM backtest_runs WHERE id = $1', [id]);
    if (!run || run.status !== 'complete') {
      return { error: 'Run not found or not complete' };
    }

    const trades = await queryAll(`
      SELECT template_id, template_name, regime, pnl_pct, is_in_sample
      FROM backtest_trades
      WHERE run_id = $1
    `, [id]);

    // Group by template + regime
    const groups = {};
    for (const t of trades) {
      const key = `${t.template_id}_${t.regime}`;
      if (!groups[key]) {
        groups[key] = {
          template_id: t.template_id,
          template_name: t.template_name,
          regime: t.regime,
          trades: [],
          oos_trades: [],
        };
      }
      groups[key].trades.push(parseFloat(t.pnl_pct));
      if (!t.is_in_sample) {
        groups[key].oos_trades.push(parseFloat(t.pnl_pct));
      }
    }

    let learningsStored = 0;
    let antiPatternsStored = 0;

    for (const [key, group] of Object.entries(groups)) {
      if (group.trades.length < 20) continue;

      const returns = group.trades;
      const wins = returns.filter(r => r > 0).length;
      const winRate = (wins / returns.length * 100).toFixed(1);
      const avgReturn = (returns.reduce((a, b) => a + b, 0) / returns.length).toFixed(2);

      // Sharpe
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length);
      const sharpe = std > 0 ? (mean / std * Math.sqrt(2190)).toFixed(2) : '0.00';

      // OOS Sharpe
      let oosSharpe = 0;
      if (group.oos_trades.length > 5) {
        const oosMean = group.oos_trades.reduce((a, b) => a + b, 0) / group.oos_trades.length;
        const oosStd = Math.sqrt(group.oos_trades.reduce((a, b) => a + Math.pow(b - oosMean, 2), 0) / group.oos_trades.length);
        oosSharpe = oosStd > 0 ? oosMean / oosStd * Math.sqrt(2190) : 0;
      }

      // Determine validation status
      let validation = 'INCONCLUSIVE';
      if (group.oos_trades.length >= 10) {
        const isWR = wins / returns.length * 100;
        const oosWins = group.oos_trades.filter(r => r > 0).length;
        const oosWR = oosWins / group.oos_trades.length * 100;
        const diff = Math.abs(isWR - oosWR) / isWR * 100;
        if (diff <= 10) validation = 'VALIDATED';
        else if (diff > 20) validation = 'OVERFITTED';
      }

      const confidenceScore = Math.min(returns.length, 100);

      const insightText = `Template "${group.template_name}" in ${group.regime} regime: ${winRate}% win rate over ${returns.length} historical trades (backtest validated). Avg return ${avgReturn}%. Sharpe ${sharpe}. ${validation} on out-of-sample data.`;

      await query(`
        INSERT INTO learnings (insight_text, category, confidence, symbols, source_agent,
                               learning_type, scope_level, evidence)
        VALUES ($1, 'strategy_performance', $2, $3, 'backtest_engine',
                'observation', 'template', $4)
      `, [
        insightText,
        confidenceScore >= 70 ? 'high' : confidenceScore >= 40 ? 'med' : 'low',
        JSON.stringify(run.symbols),
        JSON.stringify({
          source: 'backtest',
          run_id: parseInt(id),
          template_id: group.template_id,
          regime: group.regime,
          sample_size: returns.length,
          win_rate: parseFloat(winRate),
          avg_return: parseFloat(avgReturn),
          sharpe: parseFloat(sharpe),
          validation,
        }),
      ]);
      learningsStored++;

      // Anti-pattern for poor OOS performance
      if (oosSharpe < 0.3 && group.oos_trades.length >= 10) {
        const antiText = `ANTI-PATTERN: Template "${group.template_name}" in ${group.regime} regime has OOS Sharpe of ${oosSharpe.toFixed(2)} — historically underperforming. Consider pausing or revising.`;
        await query(`
          INSERT INTO learnings (insight_text, category, confidence, symbols, source_agent,
                                 learning_type, scope_level, evidence)
          VALUES ($1, 'anti_pattern', 'high', $2, 'backtest_engine',
                  'rule', 'template', $3)
        `, [
          antiText,
          JSON.stringify(run.symbols),
          JSON.stringify({
            source: 'backtest',
            run_id: parseInt(id),
            template_id: group.template_id,
            regime: group.regime,
            oos_sharpe: parseFloat(oosSharpe.toFixed(4)),
            oos_trades: group.oos_trades.length,
          }),
        ]);
        antiPatternsStored++;
      }
    }

    return {
      learnings_stored: learningsStored,
      anti_patterns_flagged: antiPatternsStored,
    };
  });
}

module.exports = routes;
