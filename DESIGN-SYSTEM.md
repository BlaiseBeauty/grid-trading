# GRID Design System

> Reference for all frontend development. Import these tokens into `design-tokens.css`.

---

## Colour Palette

```css
/* Backgrounds — darkest to lightest */
--void: #050608;        /* App background */
--abyss: #090b10;       /* Page background */
--surface: #0d0f15;     /* Card/panel background */
--elevated: #12141c;    /* Hover states, raised panels */
--raised: #171a24;      /* Active states, selected items */
--shelf: #1c1f2c;       /* Highest elevation (modals, dropdowns) */

/* Semantic — STRICT usage rules */
--cyan: #00e5ff;        /* UI elements ONLY (links, buttons, borders, icons) */
--profit: #00ff88;      /* Profit/positive ONLY — never decorative */
--loss: #ff2d55;        /* Loss/negative ONLY — never decorative */
--warn: #ffb800;        /* Warnings, caution states */
--ai: #a78bfa;          /* AI activity attribution (agent decisions, AI-generated content) */

/* Text hierarchy */
--t1: #f4f5f9;          /* Primary text */
--t2: #b8bdd0;          /* Secondary text, labels */
--t3: #6e7590;          /* Tertiary, muted, timestamps */
--t4: #3d4260;          /* Disabled text */
--t5: #252940;          /* Ghost text, barely visible */

/* Borders */
--border-0: rgba(255,255,255,0.03);   /* Subtle dividers */
--border-1: rgba(255,255,255,0.06);   /* Panel borders */
--border-2: rgba(255,255,255,0.10);   /* Active borders */
--border-3: rgba(255,255,255,0.16);   /* Focus borders, emphasis */
```

### Colour Rules

- Green and red are ONLY for profit/loss. Never use them for buttons, links, or decoration.
- Cyan = all interactive UI (links, active tabs, primary buttons, focus rings).
- Purple = anything AI-generated or AI-attributed (agent feed items, confidence badges, AI reasoning panels).
- Amber = warnings, caution, approaching limits.
- SCRAM levels: ELEVATED = `--warn`, CRISIS = `--loss`, EMERGENCY = `--loss` pulsing.
- Bootstrap phases: INFANT/LEARNING = `--warn` badge, MATURING = `--cyan`, GRADUATED = `--profit`.

---

## Typography

### Font Stack

| Role | Font | Weight | Size | Notes |
|------|------|--------|------|-------|
| Brand / page titles | Syne | 800 | 24-32px | `letter-spacing: 6-8px`, `text-transform: uppercase` |
| Panel titles | Instrument Sans | 600 | 14-16px | Clean, technical feel |
| Body / messages | Outfit | 300-500 | 13-15px | Agent feed, descriptions, prose |
| ALL numbers | IBM Plex Mono | 300-600 | varies | `font-variant-numeric: tabular-nums` ALWAYS |
| Micro data | IBM Plex Mono | 400-500 | 8-10px | `text-transform: uppercase` |
| Tags / badges | IBM Plex Mono | 600 | 8-9px | `text-transform: uppercase`, `letter-spacing: 1px` |

### Google Fonts Import

```css
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@800&family=Instrument+Sans:wght@400;500;600&family=Outfit:wght@300;400;500&family=IBM+Plex+Mono:wght@300;400;500;600&display=swap');
```

### Number Formatting Rules

```css
/* ALL number elements */
.number, [data-number] {
  font-family: 'IBM Plex Mono', monospace;
  font-variant-numeric: tabular-nums;
}
```

| Rule | Implementation | Example |
|------|---------------|---------|
| Tabular nums everywhere | `font-variant-numeric: tabular-nums` | Columns align perfectly |
| Light weight for display numbers | `font-weight: 300` for large KPI numbers | P&L hero number |
| Medium weight for data | `font-weight: 400-600` for table cells | Trade table prices |
| Minus sign not hyphen | Use `U+2212` (−) not `U+002D` (-) | −$1,234.56 not -$1,234.56 |
| Cents/decimals smaller + dimmer | Decimal portion at 80% size, `--t2` colour | $1,234<small>.56</small> |
| Always 2 decimal places for money | Pad with zeros | $1,234.00 not $1,234 |
| Percentage: 1-2 decimals | Context-dependent | 67.3% win rate, 1.82 Sharpe |
| Thousands separator | Comma | $12,345.67 |
| Positive P&L prefix | + sign | +$1,234.56 |

```jsx
// React helper
function formatMoney(value) {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '\u2212'; // U+2212
  const [whole, cents] = abs.toFixed(2).split('.');
  const formatted = Number(whole).toLocaleString('en-US');
  return (
    <span className={value >= 0 ? 'profit' : 'loss'}>
      {sign}${formatted}<span className="cents">.{cents}</span>
    </span>
  );
}
```

---

## Spacing & Layout

```css
--space-xs: 4px;
--space-sm: 8px;
--space-md: 12px;
--space-lg: 16px;
--space-xl: 24px;
--space-2xl: 32px;
--space-3xl: 48px;

--radius-sm: 4px;      /* Badges, small elements */
--radius-md: 8px;      /* Cards, panels */
--radius-lg: 12px;     /* Modals, large containers */

--panel-padding: 16px;
--panel-gap: 12px;     /* Gap between panels in grid */
```

### Panel Component

```css
.panel {
  background: var(--surface);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-md);
  padding: var(--panel-padding);
}

.panel-title {
  font-family: 'Instrument Sans', sans-serif;
  font-weight: 600;
  font-size: 13px;
  color: var(--t2);
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: var(--space-md);
}
```

---

## Micro-Interactions

```css
/* Transitions */
--transition-fast: 100ms ease;    /* Hover states */
--transition-normal: 200ms ease;  /* Panel state changes */
--transition-slow: 400ms ease;    /* Page transitions, chart animations */

/* Loading states — skeleton screens, not spinners */
.skeleton {
  background: linear-gradient(90deg, var(--surface) 25%, var(--elevated) 50%, var(--surface) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Profit/loss flash — brief highlight on value change */
.value-flash-profit { animation: flash-green 600ms ease; }
.value-flash-loss { animation: flash-red 600ms ease; }

@keyframes flash-green {
  0% { background: rgba(0, 255, 136, 0.15); }
  100% { background: transparent; }
}

@keyframes flash-red {
  0% { background: rgba(255, 45, 85, 0.15); }
  100% { background: transparent; }
}
```

---

## Status Badges

```css
/* System states */
.badge { font-family: 'IBM Plex Mono'; font-weight: 600; font-size: 9px;
         text-transform: uppercase; letter-spacing: 1px; padding: 2px 8px;
         border-radius: var(--radius-sm); }

.badge-profit   { color: var(--profit); background: rgba(0, 255, 136, 0.10); }
.badge-loss     { color: var(--loss);   background: rgba(255, 45, 85, 0.10); }
.badge-warn     { color: var(--warn);   background: rgba(255, 184, 0, 0.10); }
.badge-ai       { color: var(--ai);     background: rgba(167, 139, 250, 0.10); }
.badge-neutral  { color: var(--t3);     background: rgba(255, 255, 255, 0.05); }

/* Bootstrap phases */
.badge-infant   { color: var(--warn); background: rgba(255, 184, 0, 0.10); }
.badge-learning { color: var(--warn); background: rgba(255, 184, 0, 0.10); }
.badge-maturing { color: var(--cyan); background: rgba(0, 229, 255, 0.10); }
.badge-graduated { color: var(--profit); background: rgba(0, 255, 136, 0.10); }

/* SCRAM levels */
.badge-elevated  { color: var(--warn); background: rgba(255, 184, 0, 0.15); }
.badge-crisis    { color: var(--loss); background: rgba(255, 45, 85, 0.15); }
.badge-emergency { color: var(--loss); background: rgba(255, 45, 85, 0.25);
                   animation: pulse 1s infinite; }

/* Template status */
.badge-testing  { color: var(--ai); background: rgba(167, 139, 250, 0.10); }
.badge-active   { color: var(--profit); background: rgba(0, 255, 136, 0.10); }
.badge-paused   { color: var(--warn); background: rgba(255, 184, 0, 0.10); }
.badge-retired  { color: var(--t3); background: rgba(255, 255, 255, 0.05); }
```

---

## Agent Feed Items

```css
.agent-feed-item {
  border-left: 2px solid var(--ai);
  padding: var(--space-sm) var(--space-md);
  background: rgba(167, 139, 250, 0.03);
}

.agent-name {
  font-family: 'IBM Plex Mono';
  font-weight: 600;
  font-size: 10px;
  color: var(--ai);
  text-transform: uppercase;
}

.agent-reasoning {
  font-family: 'Outfit';
  font-weight: 300;
  font-size: 13px;
  color: var(--t2);
}
```

---

## Chart Integration (TradingView Lightweight Charts)

```javascript
const chartOptions = {
  layout: {
    background: { color: '#0d0f15' },
    textColor: '#6e7590',
  },
  grid: {
    vertLines: { color: 'rgba(255,255,255,0.03)' },
    horzLines: { color: 'rgba(255,255,255,0.03)' },
  },
  crosshair: { mode: 0 },
  timeScale: {
    borderColor: 'rgba(255,255,255,0.06)',
    timeVisible: true,
  },
};

const candlestickOptions = {
  upColor: '#00ff88',
  downColor: '#ff2d55',
  borderUpColor: '#00ff88',
  borderDownColor: '#ff2d55',
  wickUpColor: '#00ff88',
  wickDownColor: '#ff2d55',
};
```

---

## Dashboard Pages — Panel Inventory

| Page | Key Panels | Primary Data |
|------|-----------|-------------|
| Command Centre | KPI bar, chart, trades, agent feed, SCRAM status, bootstrap badge | Real-time |
| Agents | Agent grid (3 layers), decision trails, cost breakdown, cycle history | Per-agent |
| Trades | Trade table, equity curve, P&L attribution, confidence scatter, rejected opps | Historical |
| Strategy Lab | Template library, signal heatmap, combinations, anti-patterns, validation results | Templates |
| Research | Regime timeline, correlation matrix, event calendar, learning explorer, benchmarks | Analysis |
| Backtest | Template selector, equity curve, trade log, stats, regime breakdown | Simulated |
| Settings | Exchange keys, risk limits, notifications, bootstrap override, paper/live toggle | Config |

---

## Responsive Behaviour

- Desktop-first (1440px+ primary design target)
- Tablet (768-1440px): 2-column grid collapses, charts stack
- Mobile (Phase 8): single column, KPI bar becomes swipeable cards, chart fullscreen on tap
- Panel grid: CSS Grid with `auto-fit, minmax(320px, 1fr)`
