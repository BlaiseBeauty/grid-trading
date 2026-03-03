/**
 * Tracked symbols and timeframes.
 * Primary exchange: KuCoin (globally available, no geo-restrictions).
 */

module.exports = {
  symbols: [
    { symbol: 'BTC/USDT', asset_class: 'crypto', exchange: 'kucoin' },
    { symbol: 'ETH/USDT', asset_class: 'crypto', exchange: 'kucoin' },
    { symbol: 'SOL/USDT', asset_class: 'crypto', exchange: 'kucoin' },
  ],
  timeframes: ['1h', '4h', '1d'],
};
