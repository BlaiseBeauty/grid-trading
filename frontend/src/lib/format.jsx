export function formatMoney(value) {
  if (value == null) return '\u2014';
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
  if (value == null) return '\u2014';
  const sign = value >= 0 ? '+' : '\u2212';
  return (
    <span className={`num ${value >= 0 ? 'profit' : 'loss'}`}>
      {sign}{Math.abs(value).toFixed(decimals)}%
    </span>
  );
}

export function formatNum(value, decimals = 2) {
  if (value == null) return '\u2014';
  return <span className="num">{Number(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>;
}

export function formatPrice(value) {
  if (value == null) return '\u2014';
  const v = Number(value);
  const decimals = v >= 1000 ? 2 : v >= 1 ? 4 : 6;
  return <span className="num">${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>;
}

export function timeAgo(date) {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
