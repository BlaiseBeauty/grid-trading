/**
 * Exchange connection config.
 * Phase 1: Public API only (no auth needed for price data).
 * Phase 3+: Add encrypted API keys for live trading.
 */

module.exports = {
  binance: {
    name: 'Binance',
    ccxtId: 'binance',
    publicOnly: true,
    defaultPairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    timeframes: ['1h', '4h', '1d'],
    rateLimit: 1200, // ms between requests
  },
  bybit: {
    name: 'Bybit',
    ccxtId: 'bybit',
    publicOnly: true,
    defaultPairs: ['BTC/USDT', 'ETH/USDT'],
    timeframes: ['1h', '4h', '1d'],
    rateLimit: 1000,
  },
  coinbase: {
    name: 'Coinbase',
    ccxtId: 'coinbase',
    publicOnly: true,
    defaultPairs: ['BTC/USD', 'ETH/USD'],
    timeframes: ['1h', '4h', '1d'],
    rateLimit: 1000,
  },
};
