/**
 * Shared chart config.
 * lightweight-charts cannot read CSS variables, so every option set is built by a function that
 * reads the CURRENT theme's tokens (design-system.css) from the document. Call the function again
 * (see useChartTheme) to re-apply colours after a light/dark switch.
 */
import { useEffect } from 'react';
import { useTheme } from './theme';

const FONT = "'JetBrains Mono', 'IBM Plex Mono', monospace";

function cssVar(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// '#rrggbb' + alpha -> 'rgba(r, g, b, a)'. Tokens used here are hex; anything else is returned unchanged.
export function withAlpha(color, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function getChartColors() {
  return {
    cyan: cssVar('--v2-accent-cyan', '#0277bd'),
    green: cssVar('--v2-accent-green', '#2e7d32'),
    red: cssVar('--v2-accent-red', '#c62828'),
    amber: cssVar('--v2-accent-amber', '#a85a00'),
    magenta: cssVar('--v2-accent-magenta', '#6a4fb3'),
    textMuted: cssVar('--chart-text', '#667085'),
    textPrimary: cssVar('--v2-text-primary', '#1b1f29'),
    border: cssVar('--chart-border', 'rgba(15, 20, 35, 0.12)'),
    gridLine: cssVar('--chart-grid', 'rgba(15, 20, 35, 0.06)'),
    crosshair: cssVar('--chart-crosshair', 'rgba(15, 20, 35, 0.35)'),
  };
}

export function getChartOptions() {
  const c = getChartColors();
  return {
    layout: {
      background: { color: 'transparent' },
      textColor: c.textMuted,
      fontFamily: FONT,
      fontSize: 10,
    },
    grid: {
      vertLines: { color: c.gridLine },
      horzLines: { color: c.gridLine },
    },
    crosshair: {
      mode: 0,
      vertLine: { color: c.crosshair },
      horzLine: { color: c.crosshair },
    },
    timeScale: {
      borderColor: c.border,
      timeVisible: true,
      secondsVisible: false,
    },
    rightPriceScale: {
      borderColor: c.border,
    },
    handleScale: { mouseWheel: true, pinch: true },
    handleScroll: { mouseWheel: true, pressedMouseMove: true },
  };
}

export function getCandlestickOptions() {
  const c = getChartColors();
  return {
    upColor: c.green,
    downColor: c.red,
    borderUpColor: c.green,
    borderDownColor: c.red,
    wickUpColor: c.green,
    wickDownColor: c.red,
  };
}

export function getEquityAreaOptions() {
  const c = getChartColors();
  return {
    topColor: withAlpha(c.cyan, 0.2),
    bottomColor: withAlpha(c.cyan, 0.02),
    lineColor: c.cyan,
    lineWidth: 2,
  };
}

export function getDrawdownAreaOptions() {
  const c = getChartColors();
  return {
    topColor: withAlpha(c.red, 0.01),
    bottomColor: withAlpha(c.red, 0.15),
    lineColor: c.red,
    lineWidth: 2,
    invertFilledArea: true,
  };
}

export function getPriceLineOptions() {
  const c = getChartColors();
  return {
    priceLineColor: c.cyan,
    priceLineStyle: 2,
    priceLineWidth: 1,
  };
}

/**
 * Re-applies theme colours to live charts whenever the theme changes.
 *   useChartTheme(() => [
 *     [chart, getChartOptions],
 *     [series, getEquityAreaOptions],
 *   ])
 * `getTargets` is called inside the effect, so refs read their current values; entries whose
 * target is missing are skipped. Pass chart-level factories (getChartOptions) for charts and
 * series-level factories (getEquityAreaOptions, ...) for series.
 */
export function useChartTheme(getTargets) {
  const theme = useTheme();
  useEffect(() => {
    for (const [target, factory] of getTargets()) {
      if (target) target.applyOptions(factory());
    }
    // getTargets is a fresh closure each render by design; re-run only on theme change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);
}
