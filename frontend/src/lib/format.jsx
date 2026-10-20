// ── Plain-string formatters (no JSX) ─────────────────────────────────────────
// Single source of truth for number text. Always U+2212 for minus (never ASCII hyphen),
// parseFloat first (Postgres NUMERIC arrives as strings), '—' for missing/invalid.
const MINUS = '−';

function toNum(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function groupDigits(absStr) {
  const [whole, dec] = absStr.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec !== undefined ? `${grouped}.${dec}` : grouped;
}

// "$1,234.56" / "−$1,234.56". Use for unsigned amounts such as balances.
export function fmtMoney(value, decimals = 2, prefix = '$') {
  const n = toNum(value);
  if (n == null) return '—';
  return `${n < 0 ? MINUS : ''}${prefix}${groupDigits(Math.abs(n).toFixed(decimals))}`;
}

// "+$1,234.56" / "−$1,234.56". Use for P&L.
export function fmtSignedMoney(value, decimals = 2, prefix = '$') {
  const n = toNum(value);
  if (n == null) return '—';
  return `${n < 0 ? MINUS : '+'}${prefix}${groupDigits(Math.abs(n).toFixed(decimals))}`;
}

// "+1.23%" / "−1.23%"
export function fmtSignedPct(value, decimals = 2) {
  const n = toNum(value);
  if (n == null) return '—';
  return `${n < 0 ? MINUS : '+'}${Math.abs(n).toFixed(decimals)}%`;
}

// "12.3%" / "−1.2%" (no plus sign)
export function fmtPlainPct(value, decimals = 1) {
  const n = toNum(value);
  if (n == null) return '—';
  return `${n < 0 ? MINUS : ''}${Math.abs(n).toFixed(decimals)}%`;
}

// "1,234.50" / "−1,234.50"
export function fmtNumber(value, decimals = 2, prefix = '') {
  const n = toNum(value);
  if (n == null) return '—';
  return `${n < 0 ? MINUS : ''}${prefix}${groupDigits(Math.abs(n).toFixed(decimals))}`;
}

// "$2.31T" market cap in trillions
export function fmtTrillions(value) {
  const n = toNum(value);
  if (n == null) return '—';
  return `${n < 0 ? MINUS : ''}$${(Math.abs(n) / 1e12).toFixed(2)}T`;
}

export function formatMoney(value) {
  if (value == null || !isFinite(value)) return '\u2014';
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '\u2212';
  const [whole, cents] = abs.toFixed(2).split('.');
  const formatted = Number(whole).toLocaleString('en-US');
  return (
    <span className={`num ${value >= 0 ? 'profit' : 'loss'}`}>
      {sign}${formatted}<span className="cents">.{cents}</span>
    </span>
  );
}

export function formatPct(value, decimals = 1) {
  if (value == null || !isFinite(value)) return '\u2014';
  const sign = value >= 0 ? '+' : '\u2212';
  return (
    <span className={`num ${value >= 0 ? 'profit' : 'loss'}`}>
      {sign}{Math.abs(value).toFixed(decimals)}%
    </span>
  );
}

export function formatNum(value, decimals = 2) {
  if (value == null || !isFinite(Number(value))) return '\u2014';
  return <span className="num">{Number(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>;
}

export function formatPrice(value) {
  if (value == null) return '\u2014';
  const v = Number(value);
  const decimals = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
  return <span className="num">${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>;
}

export function formatDuration(start, end) {
  if (!start) return '';
  const ms = (end ? new Date(end) : new Date()) - new Date(start);
  const totalMins = Math.floor(ms / 60000);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  if (days > 0) return `${days}d ${remHrs}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

export function timeAgo(date) {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
