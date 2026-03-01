/**
 * Notification Service — sends alerts via configured channels.
 * Supports: webhook (HTTP POST)
 * Tiers: critical, trade, cycle, info
 */

const https = require('https');
const http = require('http');
const { queryAll, queryOne, query: dbQuery } = require('../db/connection');

const TIERS = {
  critical: { label: 'Critical', description: 'SCRAM, drawdown, system errors' },
  trade: { label: 'Trade', description: 'Trade executed, closed, TP/SL hit' },
  cycle: { label: 'Cycle', description: 'Cycle complete, analysis results' },
  info: { label: 'Info', description: 'General system events' },
};

/**
 * Send a notification to all enabled channels for the given tier.
 */
async function notify(tier, title, body = '') {
  const configs = await queryAll(
    "SELECT * FROM notification_config WHERE tier = $1 AND enabled = true",
    [tier]
  );

  const results = [];
  for (const config of configs) {
    try {
      await deliverToChannel(config, title, body);
      await logNotification(config.channel, tier, title, body, true);
      results.push({ channel: config.channel, delivered: true });
    } catch (err) {
      await logNotification(config.channel, tier, title, body, false, err.message);
      results.push({ channel: config.channel, delivered: false, error: err.message });
    }
  }

  return results;
}

/**
 * Deliver to a specific channel.
 */
function deliverToChannel(config, title, body) {
  switch (config.channel) {
    case 'webhook':
      return deliverWebhook(config.config, title, body);
    default:
      throw new Error(`Unsupported channel: ${config.channel}`);
  }
}

/**
 * Deliver via webhook (HTTP POST with JSON payload).
 */
function deliverWebhook(webhookConfig, title, body) {
  const url = webhookConfig.url;
  if (!url) throw new Error('No webhook URL configured');

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      text: `*${title}*\n${body}`,
      title,
      body,
      source: 'GRID',
      timestamp: new Date().toISOString(),
    });

    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'https:' ? https : http;

    const req = transport.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(webhookConfig.headers || {}),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`Webhook returned ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Webhook timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * Log notification attempt.
 */
function logNotification(channel, tier, title, body, delivered, error = null) {
  return dbQuery(`
    INSERT INTO notification_log (channel, tier, title, body, delivered, error)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [channel, tier, title, body, delivered, error]);
}

/**
 * Pre-built notification helpers for common events.
 */
const notifications = {
  tradeExecuted: (trade) => notify('trade', 'Trade Executed',
    `${trade.side === 'buy' ? 'LONG' : 'SHORT'} ${trade.symbol} @ ${trade.entry_price}\nConfidence: ${trade.confidence}%`),

  tradeClosed: (trade) => notify('trade', 'Trade Closed',
    `${trade.symbol} ${parseFloat(trade.pnl_realised) >= 0 ? 'WIN' : 'LOSS'}\nP&L: $${parseFloat(trade.pnl_realised).toFixed(2)} (${parseFloat(trade.pnl_pct).toFixed(2)}%)`),

  scramActivated: (level) => notify('critical', `SCRAM ${level.toUpperCase()} Activated`,
    `Trading restrictions in effect. Level: ${level}`),

  scramCleared: () => notify('critical', 'SCRAM Cleared', 'All trading restrictions lifted.'),

  cycleComplete: (data) => notify('cycle', `Cycle ${data.cycleNumber} Complete`,
    `Duration: ${data.elapsed}\nProposals: ${data.strategy?.proposals || 0}\nApproved: ${data.strategy?.approved || 0}\nExecuted: ${data.strategy?.trades || 0}`),

  drawdownAlert: (pct) => notify('critical', 'Drawdown Alert',
    `Portfolio drawdown has reached ${pct.toFixed(1)}%. Max allowed: ${process.env.MAX_DRAWDOWN_PCT || 10}%`),

  systemError: (agent, error) => notify('critical', `Agent Error: ${agent}`, error),
};

module.exports = { notify, notifications, TIERS };
