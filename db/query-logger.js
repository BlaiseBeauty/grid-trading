const SLOW_THRESHOLD_MS = 500;

function wrapPoolQuery(pool) {
  const originalQuery = pool.query.bind(pool);

  pool.query = async function (...args) {
    const start = performance.now();
    const result = await originalQuery(...args);
    const duration = Math.round(performance.now() - start);

    if (duration > SLOW_THRESHOLD_MS) {
      const queryText = typeof args[0] === 'string' ? args[0] : args[0]?.text || '(unknown)';
      const truncated = queryText.length > 200 ? queryText.slice(0, 200) + '...' : queryText;
      console.warn(`[SLOW QUERY] ${duration}ms: ${truncated}`);
    }

    return result;
  };
}

module.exports = { wrapPoolQuery };
