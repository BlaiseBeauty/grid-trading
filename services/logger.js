const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'debug'];

function log(level, message, context = {}) {
  if (LOG_LEVELS[level] < MIN_LEVEL) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };

  if (context.cycle_id != null) entry.cycle_id = context.cycle_id;
  if (context.agent_name) entry.agent_name = context.agent_name;
  if (context.error_type) entry.error_type = context.error_type;
  if (context.symbol) entry.symbol = context.symbol;

  if (context.err instanceof Error) {
    entry.error = context.err.message;
    if (level === 'error' || level === 'warn') entry.stack = context.err.stack;
  } else if (context.err) {
    entry.error = String(context.err);
  }

  const { cycle_id, agent_name, error_type, symbol, err, ...extra } = context;
  if (Object.keys(extra).length > 0) entry.extra = extra;

  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

module.exports = {
  debug: (msg, ctx) => log('debug', msg, ctx),
  info:  (msg, ctx) => log('info', msg, ctx),
  warn:  (msg, ctx) => log('warn', msg, ctx),
  error: (msg, ctx) => log('error', msg, ctx),
};
