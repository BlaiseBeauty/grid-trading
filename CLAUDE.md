# GRID — Unified Trading Intelligence Platform
## Three systems. One deployment. One database.

---

## Quick Start

```bash
# Terminal 1: Python trading engine
cd trading && source venv/bin/activate && python engine.py  # port 5100

# Terminal 2: Node.js server (auto-runs migrations)
npm start   # port 3100

# Terminal 3: Frontend dev server
cd frontend && npm run dev   # port 5173
```

---

## Platform Architecture

GRID is a federated monolith hosting three domain systems that communicate
exclusively through the intelligence bus. Systems never import each other.

### The Three Systems

| System  | Role         | Time Horizon    | Status      |
|---------|--------------|-----------------|-------------|
| GRID    | Execution    | Minutes → Hours | Live        |
| COMPASS | Navigation   | Days → Weeks    | Live        |
| ORACLE  | Intelligence | Weeks → Years   | Live        |

### Folder Structure

```
systems/
  grid/         ← all GRID domain logic
    agents/     ← 13 agents (orchestrator, base-agent, all specialists)
    api/        ← all GRID API route handlers
    config/     ← agent-prompts.js, risk-limits.js
  compass/      ← COMPASS portfolio navigation + risk
    agents/     ← base-agent, portfolio-agent, risk-assessor, correlation-tracker, orchestrator
    api/        ← COMPASS API route handlers (portfolio, risk, allocations)
    db/         ← (reserved for future COMPASS persistence)
  oracle/       ← ORACLE macro intelligence system
    agents/     ← base-agent, 6 domain agents, synthesis, orchestrator
    api/        ← Oracle API route handlers (theses, evidence, etc.)
    db/         ← thesis persistence (upsert, retire, query)
    ingestion/  ← FRED, RSS, GDELT data ingestion pipeline
shared/
  intelligence-bus.js   ← ONLY cross-system communication channel
  notifications.js      ← unified notification system
  conflict-resolver.js  ← thesis vs signal conflict rules (live)
  ai-costs.js           ← token budget + cost tracking
  system-health.js      ← heartbeat recording
api/
  auth.js               ← JWT auth (shared)
  platform/
    notifications.js    ← GET/POST /api/platform/notifications
    health.js           ← GET /api/platform/health
    costs.js            ← GET /api/platform/costs/*
config/
  symbols.js            ← tracked symbols (shared)
db/
  connection.js         ← query(), queryOne(), queryAll()
  migrate.js
  migrations/           ← 027 migrations total
trading/
  engine.py             ← Python Flask + CCXT, port 5100
server.js               ← entry point, routes, cron, WebSocket
```

---

## Intelligence Bus

The ONLY way systems communicate. Never import cross-system directly.

```javascript
const bus = require('./shared/intelligence-bus');  // from root
const bus = require('../../shared/intelligence-bus');  // from systems/*/
const bus = require('../../../shared/intelligence-bus'); // from systems/*/agents/
```

### Event Taxonomy

| event_type                 | publisher | consumers        | expires     |
|----------------------------|-----------|------------------|-------------|
| thesis_created             | oracle    | grid, compass    | never       |
| thesis_conviction_updated  | oracle    | grid, compass    | never       |
| thesis_retired             | oracle    | grid, compass    | never       |
| macro_regime_update        | oracle    | grid, compass    | 6h          |
| opportunity_map_update     | oracle    | compass          | 6h          |
| trade_executed             | grid      | oracle, compass  | never       |
| trade_closed               | grid      | oracle, compass  | never       |
| scram_triggered            | grid      | compass          | 24h         |
| performance_digest         | grid      | oracle, compass  | never       |
| portfolio_risk_state       | compass   | grid             | 4h          |
| allocation_guidance        | compass   | grid             | 4h          |
| conflict_flagged           | system    | oracle, grid     | 24h         |

### Publish pattern

```javascript
await bus.publish({
  source_system: 'grid',
  event_type: 'trade_closed',
  payload: { trade_id, symbol, pnl_usd, close_reason },
  affected_assets: ['BTC'],
  direction: 'bull',       // optional
  conviction: null,        // optional, 0–10
  time_horizon: null,      // optional: tactical|strategic|structural
  expires_at: null,        // optional ISO string, null = never
});
```

Always wrap in try/catch. Bus failures must never crash the calling system.

---

## GRID Agent Pipeline

### Layer 1 — Knowledge (8 agents, Sonnet, parallel batches of 2)
trend, momentum, volatility, volume, pattern, orderflow, macro, sentiment

### Layer 2 — Strategy (3 agents, sequential)
Regime Classifier → Synthesizer (Opus) → Risk Manager

### Layer 3 — Analysis (every 6th cycle)
Performance Analyst, Pattern Discovery

### Cost Tiers (shared/ai-costs.js TOKEN_BUDGETS)
- grid_knowledge:    8k input / 1.2k output
- grid_synthesizer:  32k input / 4k output
- grid_risk_manager: 6k input / 800 output
- grid_performance:  10k input / 2k output
- grid_pattern:      10k input / 2k output
- oracle_domain:     10k input / 2.5k output
- oracle_synthesis:  15k input / 4k output
- oracle_graveyard:  20k input / 3k output
- compass_portfolio: 12k input / 2k output
- compass_risk:      8k input / 1.5k output

Every agent must set: this.costTier = 'grid_knowledge' (or appropriate tier)
Cost is recorded automatically by base-agent after every API call.

---

## ORACLE Agent Pipeline

### Ingestion (every 6h at :00, no AI cost)
FRED macro data → RSS news feeds → GDELT geopolitical events
All stored in oracle_evidence + oracle_raw_feed

### Domain Agents (every 6h at :30, 6 agents, Sonnet, batches of 2)
macro-economist, geopolitical-analyst, tech-disruption,
commodity-specialist, equity-sector, crypto-analyst

### Synthesis (Opus, runs after domain agents)
Cross-thesis confluence/conflict detection → Opportunity Map → Bus events

### Conflict Resolver (runs on every GRID Risk Manager approval)
Adjusts GRID position sizing based on Oracle thesis alignment:
- Confluence (2+ theses same direction): size x1.3
- Single high-conviction confluence (8+): size x1.15
- Strategic conflict (7+ conviction): size x0.6
- Structural conflict (9+ conviction): size x0.5

---

## COMPASS Agent Pipeline

### Portfolio Agent (Opus, runs every 6h at :15 of 1,7,13,19)
Reads ORACLE theses + GRID performance → produces risk posture + allocation weights.
Performance guardrails: drawdown >= 8% forces CASH, drawdown >= 5% or winRate < 40% forces DEFENSIVE.

### Risk Assessor (Opus, runs after Portfolio Agent)
Computes risk score (0–10) + hard limits GRID must operate within.
Hard constraints enforced in code: max_total <= $20k, max_single <= $10k, max_positions <= 6, scram >= 5%.

### Correlation Tracker (no AI, runs before agents)
Calculates pairwise trade-outcome correlation between GRID symbols (30-day rolling).
Stores snapshots in compass_correlation_snapshots.

### COMPASS → GRID Integration
Risk Manager reads COMPASS limits via bus.getRiskState() before approving positions.
Falls back to config/risk-limits.js if COMPASS unavailable. COMPASS only caps sizes — never increases.
Direction bias: if COMPASS allocation opposes proposal direction, size reduced 25%.

---

## Cron Schedule

```
0 */4 * * *         GRID 4h cycle (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
*/15 * * * *        Position monitor
0 * * * *           Hourly cleanup (signals + bus purge + oracle raw feed)
0 6 * * 1           Weekly performance digest (Monday 06:00)
0 0,6,12,18 * * *   ORACLE ingestion (runs 30min before agents)
30 0,6,12,18 * * *  ORACLE agent cycle (6 domain + synthesis)
15 1,7,13,19 * * *  COMPASS 6h cycle (45min after ORACLE)
```

Stagger logic: ORACLE runs at :30 → COMPASS at :15 next hour → GRID reads
COMPASS guidance at its next :00 cycle. Full pipeline completes in order.

---

## Database Conventions

- query()    → raw pg result {rows, rowCount}  — use for INSERT/UPDATE
- queryAll() → result.rows array               — use for SELECT many
- queryOne() → result.rows[0]                  — use for SELECT single

### Table Ownership

| Prefix      | Owner   | Notes                              |
|-------------|---------|-------------------------------------|
| (none)      | Shared  | intelligence_bus, platform_*, users |
| grid_*      | GRID    | signals, trades, positions, etc.    |
| compass_*   | COMPASS | portfolios, allocations, etc.       |
| oracle_*    | ORACLE  | theses, evidence, graveyard, etc.   |

Current migration count: 027
Latest migration: 027_compass_schema.sql

---

## API Routes

### GRID (prefix: /api)
GET  /api/portfolio
GET  /api/trades
GET  /api/agents
GET  /api/market-data
GET  /api/signals
GET  /api/templates
GET  /api/learnings
GET  /api/costs
GET  /api/system
GET  /api/analytics
GET  /api/standing-orders
GET  /api/events
GET  /api/performance-digest
GET  /api/performance-digest/latest
GET  /api/performance-digest/:id
POST /api/performance-digest/build

### Platform (prefix: /api/platform)
GET  /api/platform/notifications
POST /api/platform/notifications/read-all
POST /api/platform/notifications/:id/read
GET  /api/platform/health
GET  /api/platform/costs/summary
GET  /api/platform/costs/daily
GET  /api/platform/costs/budget

### ORACLE (prefix: /api/oracle)
GET  /api/oracle/theses
GET  /api/oracle/theses/:id
GET  /api/oracle/opportunity-map
GET  /api/oracle/macro-regime
GET  /api/oracle/graveyard
GET  /api/oracle/evidence
POST /api/oracle/theses/:id/retire
POST /api/oracle/cycle/run

### COMPASS (prefix: /api/compass)
GET  /api/compass/portfolio
GET  /api/compass/portfolio/history
GET  /api/compass/allocations
GET  /api/compass/risk
GET  /api/compass/risk/history
GET  /api/compass/rebalance
POST /api/compass/rebalance/:id/acknowledge
POST /api/compass/cycle/run

### Auth (prefix: /api/auth)
POST /api/auth/login
POST /api/auth/refresh
POST /api/auth/logout

---

## WebSocket Events

All events broadcast on ws://host/ws as { type, data, ts }

| type              | source              | data shape                      |
|-------------------|---------------------|---------------------------------|
| cycle_complete    | GRID orchestrator   | { regime, signals, proposals }  |
| positions_closed  | Position monitor    | { closed[] }                    |
| bus_event         | Intelligence bus    | { id, source_system, event_type, direction, conviction, affected_assets, payload_summary, created_at } |

Frontend handles bus_event in the WS message handler.
Add to busEvents ring buffer (max 50). Increment unreadCount for
trade_closed, scram_triggered, thesis_created, thesis_conviction_updated,
performance_digest.

---

## Environment Variables

```
PORT=3100
DATABASE_URL=postgresql://...
ANTHROPIC_API_KEY=...
PYTHON_ENGINE_URL=http://127.0.0.1:5100
JWT_SECRET=...
JWT_REFRESH_SECRET=...
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
LIVE_TRADING_ENABLED=false
FRED_API_KEY=       (optional — get free at fred.stlouisfed.org)
```

---

## Coding Conventions

- API routes: Fastify 5 — fastify.get/post(path, handler) with request, reply
- All routes require JWT auth via fastify.authenticate preHandler
- POST endpoints must accept {} body (Fastify rejects empty body with content-type: json)
- Frontend: functional React components, Zustand stores, lib/api.js for HTTP
- Design system: DESIGN-SYSTEM.md — colour tokens, typography, spacing rules

### Cross-system rules (enforced by ESLint)
- systems/grid/* cannot require systems/compass/* or systems/oracle/*
- systems/compass/* cannot require systems/grid/* or systems/oracle/*
- systems/oracle/* cannot require systems/grid/* or systems/compass/*
- All cross-system reads/writes go through shared/intelligence-bus.js ONLY

### Error handling for bus/costs/health
- Always try/catch around bus.publish()
- Always try/catch around aiCosts.recordUsage()
- Always try/catch around recordHeartbeat()
- These are enhancements — never let them crash the primary operation

---

## Phase Status

| Phase | Description                              | Status    |
|-------|------------------------------------------|-----------|
| 0     | Federated monolith foundation            | COMPLETE  |
| 1     | AI costs, digest, WebSocket, docs        | COMPLETE  |
| 2     | ORACLE core — thesis agents + bus        | COMPLETE  |
| 3     | COMPASS core — portfolio + risk          | COMPLETE  |
| 4     | Platform shell frontend + notifications  | PLANNED   |
| 5     | Learning loop closure + graveyard        | PLANNED   |
| 6     | Live trading readiness audit             | PLANNED   |

---

## Active Feedback Loops (Phase 3+)

Loop 1: ORACLE → GRID
  thesis_created/updated events → GRID Synthesizer context
  High conviction thesis boosts proposal confidence
  Opposing structural thesis reduces position size

Loop 2: GRID → ORACLE
  trade_closed events carry thesis_ids (populated Phase 5)
  Graveyard Auditor correlates trade outcomes to thesis accuracy

Loop 3: COMPASS → GRID
  portfolio_risk_state → Risk Manager hard limits
  allocation_guidance → direction bias for position sizing

Loop 4: GRID → COMPASS
  performance_digest → posture guardrails
  Drawdown > 8% forces CASH posture
  Win rate < 40% forces DEFENSIVE posture

Loop 5: ORACLE → COMPASS
  getAllActiveTheses() → portfolio allocation weights
  thesis direction bias informs per-symbol max_position_usd

Loops 6 + 7: Phase 5 (Graveyard Auditor + Pattern Discovery)
