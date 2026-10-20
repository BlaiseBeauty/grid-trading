/**
 * Tracked symbols and timeframes.
 * Primary exchange: KuCoin (globally available, no geo-restrictions).
 *
 * Symbol conventions:
 *   - GRID trades full pairs:          'BTC/USDT'
 *   - ORACLE / COMPASS use tickers:    'BTC'   (canonical form stored in oracle_theses)
 * Use baseAsset()/normalizeSymbol() to move between the two. Never string-compare raw symbols
 * across systems.
 */

const symbols = [
  { symbol: 'BTC/USDT', asset_class: 'crypto', exchange: 'kucoin' },
  { symbol: 'ETH/USDT', asset_class: 'crypto', exchange: 'kucoin' },
  { symbol: 'SOL/USDT', asset_class: 'crypto', exchange: 'kucoin' },
];

const timeframes = ['1h', '4h', '1d'];

const DEFAULT_QUOTE = 'USDT';
const QUOTE_SUFFIXES = ['USDT', 'USDC', 'BUSD', 'USD', 'PERP'];

/**
 * Canonical ticker / base asset: 'BTC/USDT' | 'btc-usd' | 'BTCUSDT' | 'BTC' -> 'BTC'.
 * Returns '' for empty/non-string input.
 */
function baseAsset(sym) {
  if (typeof sym !== 'string') return '';
  let s = sym.trim().toUpperCase();
  if (!s) return '';
  const sep = s.search(/[\/\-_:]/);
  if (sep > 0) {
    // Only strip a recognised QUOTE ('BTC/USDT', 'ETH-USD'); keep class-share tickers like 'BRK-B' intact.
    const quote = s.slice(sep + 1);
    return QUOTE_SUFFIXES.includes(quote) ? s.slice(0, sep) : s;
  }
  for (const q of QUOTE_SUFFIXES) {
    if (s.length >= q.length + 2 && s.endsWith(q)) return s.slice(0, -q.length);
  }
  return s;
}

/** Tracked crypto base assets, e.g. ['BTC','ETH','SOL']. */
function trackedBaseAssets() {
  return symbols.map((s) => baseAsset(s.symbol));
}

/** Tracked full pairs, e.g. ['BTC/USDT','ETH/USDT','SOL/USDT']. */
function trackedPairs() {
  return symbols.map((s) => s.symbol);
}

/**
 * GRID pair form. Tracked crypto bases get '/USDT'; anything else (SPY, GLD, DXY...) is
 * returned upper-cased and unchanged so it is never mangled into a fake pair.
 */
function normalizeSymbol(sym, quote = DEFAULT_QUOTE) {
  const base = baseAsset(sym);
  if (!base) return '';
  const tracked = symbols.find((s) => baseAsset(s.symbol) === base);
  if (tracked) return tracked.symbol;
  const raw = String(sym).trim().toUpperCase();
  if (/[\/\-_:]/.test(raw)) return raw.replace(/[\-_:]/, '/');
  return isKnownCryptoBase(base) ? `${base}/${quote}` : raw;
}

// Bases we are willing to pair with the default quote even if not currently tracked.
const EXTRA_CRYPTO_BASES = new Set(['BNB', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT', 'LINK', 'MATIC', 'LTC']);
function isKnownCryptoBase(base) {
  return trackedBaseAssets().includes(base) || EXTRA_CRYPTO_BASES.has(base);
}

/** All spellings of a symbol worth matching against stored asset arrays. */
function symbolVariants(sym) {
  const base = baseAsset(sym);
  if (!base) return [];
  return [...new Set([
    base,
    `${base}/${DEFAULT_QUOTE}`,
    `${base}/USD`,
    `${base}-USD`,
    `${base}-${DEFAULT_QUOTE}`,
    `${base}${DEFAULT_QUOTE}`,
    String(sym).trim().toUpperCase(),
  ])];
}

module.exports = {
  symbols,
  timeframes,
  baseAsset,
  normalizeSymbol,
  trackedBaseAssets,
  trackedPairs,
  symbolVariants,
  DEFAULT_QUOTE,
};
