/**
 * Shared chart color config — V2 Design System hex values.
 * lightweight-charts cannot read CSS variables, so we define them here.
 * Source of truth: design-system.css --v2-accent-* tokens.
 */

export const V2_COLORS = {
  cyan: '#4fc3f7',
  green: '#66bb6a',
  red: '#ef5350',
  amber: '#ffa726',
  magenta: '#b39ddb',
  textMuted: '#5c5f6b',
  textSecondary: '#8b8e99',
  border: 'rgba(255, 255, 255, 0.07)',
  gridLine: 'rgba(255, 255, 255, 0.04)',
};

export const CHART_OPTIONS = {
  layout: {
    background: { color: 'transparent' },
    textColor: V2_COLORS.textMuted,
    fontFamily: "'JetBrains Mono', 'IBM Plex Mono', monospace",
    fontSize: 10,
  },
  grid: {
    vertLines: { color: V2_COLORS.gridLine },
    horzLines: { color: V2_COLORS.gridLine },
  },
  crosshair: { mode: 0 },
  timeScale: {
    borderColor: V2_COLORS.border,
    timeVisible: true,
    secondsVisible: false,
  },
  rightPriceScale: {
    borderColor: V2_COLORS.border,
  },
  handleScale: { mouseWheel: true, pinch: true },
  handleScroll: { mouseWheel: true, pressedMouseMove: true },
};

export const CANDLESTICK_OPTIONS = {
  upColor: V2_COLORS.green,
  downColor: V2_COLORS.red,
  borderUpColor: V2_COLORS.green,
  borderDownColor: V2_COLORS.red,
  wickUpColor: V2_COLORS.green,
  wickDownColor: V2_COLORS.red,
};

export const EQUITY_AREA_OPTIONS = {
  topColor: 'rgba(79, 195, 247, 0.20)',
  bottomColor: 'rgba(79, 195, 247, 0.02)',
  lineColor: V2_COLORS.cyan,
  lineWidth: 2,
};

export const DRAWDOWN_AREA_OPTIONS = {
  topColor: 'rgba(239, 83, 80, 0.01)',
  bottomColor: 'rgba(239, 83, 80, 0.15)',
  lineColor: V2_COLORS.red,
  lineWidth: 2,
  invertFilledArea: true,
};

export const PRICE_LINE_OPTIONS = {
  priceLineColor: V2_COLORS.cyan,
  priceLineStyle: 2,
  priceLineWidth: 1,
};
