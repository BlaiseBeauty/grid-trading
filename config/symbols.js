/**
 * Tracked symbols and timeframes.
 * Phase 1-2: Crypto only via Binance public API.
 */

module.exports = {
  symbols: [
    { symbol: 'BTC/USDT', asset_class: 'crypto', exchange: 'binance' },
    { symbol: 'ETH/USDT', asset_class: 'crypto', exchange: 'binance' },
    { symbol: 'SOL/USDT', asset_class: 'crypto', exchange: 'binance' },
  ],
  timeframes: ['1h', '4h', '1d'],
};
