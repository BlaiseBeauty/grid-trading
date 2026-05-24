# VAZOM V2 — Master Plan

## Vision

Transform VAZOM from a functional prototype into a best-in-class autonomous trading platform. The V2 dashboard combines Bloomberg Terminal information density with Bybit/Deribit real-time polish — every pixel earns its place, everything moves, nothing is static.

---

## Current State (V1 Honest Assessment)

### What Works
- 8 knowledge agents producing 70+ signals per cycle
- Synthesizer + Risk Manager making intelligent entry decisions
- Active Position Manager reviewing and closing positions with reasoned logic
- Standing orders with conditional triggers
- Live WebSocket price feeds with 4-level fallback
- Paper trading with slippage simulation
- Railway deployment (3 services: Node, Python, Postgres)

### What's Broken
- **P&L Bug**: `pnl_realised` stores percentage instead of dollar amount (paper.py + monitor.py)
- **Win Rate**: Shows 100% when it shouldn't — stale data or calculation timing issue
- **Total P&L**: May not reflect realized losses properly
- **Trade count inconsistency**: Dashboard shows different counts than DB
- **14 unused database tables** (30% of schema) — Phase 3-5 placeholders
- **70+ inline SQL queries** scattered outside the query layer
- **No input validation** on API endpoints
- **Silent error swallowing** in catch blocks throughout the codebase
- **FRED/VIX data never populated** — macro agent always operates blind
- **Portfolio state UNIQUE constraint** was missing (fixed)
- **Standing order race conditions** (fixed with SELECT FOR UPDATE)

### What's Boring
- Static dashboard with no animations or transitions
- Basic TradingView embeds with no interactivity
- No real-time P&L animation (numbers don't tick)
- Generic monospace font aesthetic
- No depth — flat cards, no layering, no atmosphere
- Agent Activity is a simple text log
- No visual representation of agent intelligence or reasoning
- No market microstructure visualization (order flow, liquidations, funding)

---

## V2 Architecture

### Design Philosophy

**"Bloomberg meets Blade Runner"**

- Information density of a terminal — every section shows actionable data
- Dark theme with electric accent colors — cyan, magenta, amber for signals
- Real-time motion everywhere — ticking numbers, pulsing indicators, flowing data
- Depth through layered glass effects, subtle gradients, and ambient glow
- Typography: monospace for data (JetBrains Mono), geometric sans for labels (Outfit)
- Grid-based layout with resizable panels

### Technology Stack Changes

| Component | V1 | V2 |
|-----------|----|----|
| CSS | Plain CSS files | Tailwind + CSS custom properties |
| Charts | TradingView embeds | TradingView Advanced + custom D3/Recharts overlays |
| Animations | None | Framer Motion + CSS transitions |
| Data viz | Basic text | D3.js for heatmaps, flow diagrams, liquidation maps |
| State | Zustand (keep) | Zustand + derived selectors for computed values |
| WebSocket | Basic events | Structured event system with optimistic UI |
| On-chain | CoinGlass only | CoinGlass + Glassnode integration |

---

## Rollout Phases

### Phase 1: Bug Extermination (Days 1-2)
*Fix every known bug before touching the UI. Clean foundation.*

#### 1.1 P&L Calculation Fix (CRITICAL)
- Fix `paper.py close()`: `pnl_realised = (exit - entry) * qty` for longs, `(entry - exit) * qty` for shorts
- Fix `monitor.py`: Same P&L calculation fix + add `close_reason` ('tp_hit' / 'sl_hit')
- Recalculate and UPDATE all closed trades in DB with correct dollar P&L
- Verify: `SUM(pnl_realised)` matches expected values

#### 1.2 Data Integrity
- Audit all closed trades for correct P&L values
- Verify `pnl_pct` is percentage, `pnl_realised` is dollars — everywhere
- Add DB constraint: CHECK that pnl_realised and pnl_pct have same sign
- Fix portfolio_state unrealised_pnl calculation

#### 1.3 Win Rate / Stats
- Verify `getStats()` SQL returns correct win_rate after P&L fix
- Ensure dashboard fetches fresh stats after every cycle
- Add `total_trades` count that includes both open and closed

#### 1.4 Error Handling Hardening
- Replace all silent catch blocks with proper error propagation
- Add structured logging (cycle_id, agent_name, error_type) to every catch
- Add circuit breaker: if Python engine fails 3x consecutively, pause cycles and alert

#### 1.5 Race Condition Prevention
- Add mutex/lock to `runCycle()` — already has guard but verify it works
- Add transaction wrapping for standing order check + execute
- Add optimistic locking on trade updates (version column)

#### 1.6 Consolidate Inline SQL
- Move all 70+ inline queries to `db/queries/*.js`
- Create new query files as needed: `db/queries/signals.js`, `db/queries/cycles.js`
- Single source of truth for every DB operation

---

### Phase 2: Data Layer Enhancement (Days 3-4)
*More data = better decisions. Integrate Glassnode, fix FRED.*

#### 2.1 Glassnode Integration
- Create `data-sources/glassnode.js`
- Key metrics to fetch:
  - NUPL (Net Unrealized Profit/Loss) — market cycle positioning
  - SOPR (Spent Output Profit Ratio) — holder behavior
  - Exchange inflows/outflows — accumulation vs distribution
  - Active addresses — network activity
  - MVRV ratio — market value vs realized value
  - Supply in profit percentage
- Store in `market_data` or new `onchain_metrics` table
- Feed to Macro and Sentiment knowledge agents
- Fetch schedule: every 30 minutes (matches external data cron)

#### 2.2 Fix FRED/VIX Data
- Add FRED_API_KEY to Railway env vars (free API key from FRED)
- Verify `data-sources/fred.js` works with the key
- Feed VIX, DXY, Treasury yields to Macro agent
- Fallback: if FRED unavailable, use alternative source

#### 2.3 Enhanced Context Builders
- Update `buildMacroContext()` with Glassnode on-chain data
- Update `buildSentimentContext()` with exchange flow data
- Create `buildOnChainContext()` for dedicated on-chain analysis
- Ensure all context builders handle missing data gracefully (not silently)

---

### Phase 3: Dashboard V2 — Core Layout (Days 5-8)
*Complete frontend rebuild. Every component from scratch.*

#### 3.1 Design System
```
Colors:
  --bg-primary: #0a0b0e          (near black)
  --bg-secondary: #12141a        (card background)
  --bg-tertiary: #1a1d26         (elevated surface)
  --border: rgba(255,255,255,0.06)
  --text-primary: #e8eaed
  --text-secondary: #8b8d93
  --text-muted: #55575e
  --accent-cyan: #00e5ff         (primary actions, live data)
  --accent-green: #00e676        (profit, bullish)
  --accent-red: #ff1744          (loss, bearish)
  --accent-amber: #ffab00        (warnings, pending)
  --accent-magenta: #e040fb      (AI activity, signals)
  --glow-cyan: 0 0 20px rgba(0,229,255,0.3)
  --glow-green: 0 0 20px rgba(0,230,118,0.3)

Typography:
  Data/numbers: 'JetBrains Mono', monospace
  Labels/headings: 'Outfit', sans-serif
  Agent names: 'Outfit' uppercase, letter-spacing 0.1em

Spacing:
  Panel gap: 8px
  Inner padding: 16px
  Card radius: 8px
```

#### 3.2 Command Centre (Main Dashboard)
**Top Bar — KPI Strip (always visible)**
- Portfolio Value: Large ticking number with sparkline
- Total P&L: Dollar + percentage, color-coded, animated on change
- Win Rate: Circular progress ring
- Open Positions: Count with mini position indicators
- AI Cost: Running total with cost-per-trade average
- System Status: Pulse indicator (green/amber/red)
- Next Cycle: Countdown timer

**Row 1 — Market Overview**
- 3 price cards (BTC, ETH, SOL) with:
  - Live ticking price (WebSocket animated)
  - 24h change with directional arrow
  - Mini sparkline (last 4h, drawn with canvas/SVG, not TradingView)
  - Funding rate badge
  - Volume bar (relative to 30d average)
- Market Regime indicator: Large badge with confidence %, animated transitions between states
- Fear & Greed gauge: Semicircular gauge with needle

**Row 2 — Trading Intelligence (2 columns)**

Left: **Position Command**
- Open positions as expandable cards:
  - Symbol, side, entry, current price (ticking), unrealized P&L (ticking)
  - TP/SL levels as visual range bar (current price marker moves)
  - Time held, confidence at entry
  - Last position review decision + reasoning (expandable)
  - Manual close button
- Closed positions summary: Today's realized P&L

Right: **Agent Neural Network**
- Visual graph showing 8 knowledge agents as nodes
- Animated connections showing signal flow to synthesizer
- Each node pulses when active, dims when idle
- Color indicates signal direction (green = bullish, red = bearish, grey = neutral)
- Click node to see latest signal details
- Synthesizer node in center shows current thesis
- Risk Manager node shows approval/rejection flow

**Row 3 — Market Depth (2 columns)**

Left: **Signal Heatmap**
- 3x8 grid (3 symbols × 8 agents)
- Each cell colored by signal strength and direction
- Animated transitions when signals update
- Hover for signal details

Right: **Activity Feed**
- Streaming log with colored event types
- Agent decisions, trade executions, position reviews, standing order triggers
- Each entry has timestamp, agent badge, and action summary
- Smooth scroll animation for new entries

**Row 4 — Charts**
- Full-width TradingView Advanced chart
- Tabbed: BTC | ETH | SOL
- Overlay trade entries/exits as markers
- Show TP/SL levels as horizontal lines
- Standing order trigger prices as dashed lines

**Row 5 — Standing Orders & Equity**

Left: **Standing Orders**
- Card per order with trigger condition visualization
- Progress bar showing how close price is to trigger
- Confidence badge, expiry countdown
- Cancel button

Right: **Equity Curve**
- Interactive chart with:
  - Portfolio value line
  - Trade markers (entry/exit points)
  - Drawdown shading
  - Benchmark comparison line (BTC buy-and-hold)

#### 3.3 Trades Page
- Filterable table: All / Open / Closed
- Each row expandable to show:
  - Entry/exit details with slippage
  - Contributing signals at time of entry
  - Position review history
  - P&L chart for the trade's duration
- Summary stats: Total trades, win rate, avg return, best/worst, Sharpe

#### 3.4 Agents Page
- Card per agent showing:
  - Current status (active/idle/error)
  - Last signal produced (direction, strength, reasoning)
  - Historical accuracy (if analysis agents have computed this)
  - Cost per cycle
  - Response time
- Expandable to show full latest prompt + response (for debugging)

#### 3.5 Strategy Lab Page
- Standing orders management with visual trigger editor
- Template performance comparison
- Backtesting interface (future)
- Manual trade entry

#### 3.6 Analytics Page
- Performance breakdown by: symbol, agent, template, time period
- Risk metrics: max drawdown, Sharpe ratio, Sortino ratio
- Correlation analysis between agents and outcomes
- AI cost analysis: cost per profitable trade vs losing trade
- On-chain metrics dashboard (Glassnode data visualization)

#### 3.7 Settings Page
- System health with proper endpoint (fixed)
- SCRAM controls
- Cycle frequency adjustment
- Agent enable/disable toggles
- API key management (masked)
- Bootstrap phase progression display

---

### Phase 4: Real-Time Animation Layer (Days 9-10)
*Make everything feel alive.*

#### 4.1 Ticking Numbers
- All price and P&L displays animate between values
- Use `requestAnimationFrame` for smooth 60fps interpolation
- Numbers tick digit by digit (slot machine effect) for major changes
- Subtle pulse glow on value change

#### 4.2 Data Flow Animations
- When a cycle runs, animate data flowing through the agent network graph
- Signals animate from knowledge agents → synthesizer → risk manager → execution
- Trade execution: flash effect on the position card
- Position close: card slides out with P&L summary overlay

#### 4.3 Chart Annotations
- Trade entries appear with animated marker drop
- TP/SL lines animate into position
- Price approaching TP/SL: line pulses with increasing urgency
- Standing order triggers shown as animated zones

#### 4.4 Ambient Effects
- Subtle particle effect in background (very low opacity)
- Card borders glow softly on hover
- Agent nodes in the neural network breathe (subtle scale pulse)
- Status indicators pulse at different rates based on urgency

---

### Phase 5: Backend Optimization (Days 11-12)
*Performance and reliability for production.*

#### 5.1 Database
- Remove or archive 14 unused tables
- Add proper indexes on hot query paths
- Connection pool tuning (max 20, idle timeout 30s)
- Add query timing logs for slow query detection

#### 5.2 Cron Optimization
- Consider increasing position review frequency to every hour (not just every 4h cycle)
- Add health check cron that verifies all services are responsive
- Add dead letter queue for failed agent calls

#### 5.3 Monitoring
- Add structured JSON logging for all major events
- Endpoint for Prometheus/Grafana metrics (future)
- Error rate tracking per agent
- Latency tracking for each cycle step

---

## Implementation Approach

### For Claude Code
The V2 frontend should be implemented page by page, starting with the Design System (shared CSS variables, components, animations) and then building each page. Each page should be a complete unit — committed and tested before moving to the next.

### Prompt Sequence

**Prompt 1** — Bug fixes (Phase 1): Fix all P&L bugs, error handling, race conditions. One commit per fix.

**Prompt 2** — Data layer (Phase 2): Glassnode integration, FRED fix, context builder updates.

**Prompt 3** — Design system: Create shared CSS variables, Tailwind config, animation utilities, base components (TickingNumber, StatusPulse, GlowCard, SignalBadge).

**Prompt 4** — Command Centre: Full rebuild of main dashboard with all rows.

**Prompt 5** — Agent Neural Network: D3-based interactive agent visualization.

**Prompt 6** — Trades + Analytics pages: Full rebuild with expandable rows and charts.

**Prompt 7** — Strategy Lab + Settings + Agents pages.

**Prompt 8** — Animation layer: Ticking numbers, data flow, ambient effects.

**Prompt 9** — Integration testing: End-to-end test of all pages with live data.

**Prompt 10** — Performance: DB optimization, cron tuning, monitoring.

---

## Success Criteria

- [ ] All P&L calculations are correct (dollar amounts, not percentages)
- [ ] Win rate reflects actual closed trade outcomes
- [ ] No silent error swallowing — all failures are logged and visible
- [ ] Dashboard updates in real-time without manual refresh
- [ ] Numbers tick/animate when values change
- [ ] Agent network visualization shows live signal flow
- [ ] Position cards show TP/SL as visual range bars
- [ ] Equity curve includes trade markers and drawdown shading
- [ ] Glassnode on-chain data feeds into agent decisions
- [ ] Every page loads in <2 seconds
- [ ] System runs autonomously for 24h+ without intervention
- [ ] Total P&L = realized (closed) + unrealized (open), always accurate

---

## Timeline Estimate

| Phase | Days | Focus |
|-------|------|-------|
| Phase 1 | 1-2 | Bug fixes |
| Phase 2 | 3-4 | Data layer + Glassnode |
| Phase 3 | 5-8 | Dashboard V2 (all pages) |
| Phase 4 | 9-10 | Animation + polish |
| Phase 5 | 11-12 | Backend optimization |

**Total: ~12 working days to V2**
