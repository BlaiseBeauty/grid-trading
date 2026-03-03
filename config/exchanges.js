/**
 * Exchange connection config.
 * Primary: KuCoin — globally available, no geo-restrictions.
 * Fallback: OKX — also globally available with good liquidity.
 * Phase 1: Public API only (no auth needed for price data).
 * Phase 3+: Add encrypted API keys for live trading.
 */

module.exports = {
  kucoin: {
    name: 'KuCoin',
    ccxtId: 'kucoin',
    publicOnly: true,
    defaultPairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    timeframes: ['5m', '15m', '1h', '4h', '1d'],
    rateLimit: 500, // ms between requests
    primary: true,
  },
  okx: {
    name: 'OKX',
    ccxtId: 'okx',
    publicOnly: true,
    defaultPairs: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    timeframes: ['5m', '15m', '1h', '4h', '1d'],
    rateLimit: 500,
    fallback: true,
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
