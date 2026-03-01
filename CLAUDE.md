# GRID — Autonomous Trading Intelligence Platform

## Quick Start

```bash
# Terminal 1: Python trading engine
cd trading && source venv/bin/activate && python engine.py  # port 5100

# Terminal 2: Node.js server (auto-runs migrations)
npm start   # port 3100

# Terminal 3: Frontend dev server
cd frontend && npm run dev   # port 5173
```

## Architecture

### 3-Layer Agent Pipeline

**Layer 1 — Knowledge** (8 agents, Sonnet, parallel in batches of 2):
trend, momentum, volatility, volume, pattern, orderflow, macro, sentiment

**Layer 2 — Strategy** (3 agents, sequential):
Regime Classifier → Synthesizer (Opus) → Risk Manager

**Layer 3 — Analysis** (2 agents, every 6th cycle):
Performance Analyst, Pattern Discovery

### Agent Prompt Architecture

- **System prompts**: `config/agent-prompts.js` — centralized, 13 agents
- **Context builders**: `agents/context-builders.js` — query DB for rich market context
- **Base agent**: `agents/base-agent.js` — centralized prompt takes precedence, subclass fallback
- **Memory injection**: `agents/memory-injection.js` — token-budgeted learnings per agent tier
- **Orchestrator**: `agents/orchestrator.js` — runs the 3-layer pipeline, caches indicators

### Stack

| Layer | Technology |
|-------|-----------|
| Backend | Fastify 5, Node.js |
| Database | PostgreSQL (47 tables) |
| Frontend | React 19, Vite, Zustand |
| Trading Engine | Python Flask, CCXT |
| AI | Claude API (Sonnet for knowledge, Opus for strategy) |

## Key Files

```
server.js                          Entry point, cron jobs, WebSocket
agents/orchestrator.js             3-layer pipeline execution
agents/base-agent.js               Shared agent logic + signal storage
agents/context-builders.js         Centralized context builders (DB queries)
config/agent-prompts.js            All 13 system prompts
config/risk-limits.js              Hard-coded risk limits
config/symbols.js                  Tracked symbols + timeframes
db/migrations/001_initial_schema.sql   47-table schema
db/connection.js                   query(), queryOne(), queryAll()
trading/engine.py                  Python Flask API
```

## DB Conventions

- `query()` returns raw pg result `{rows, rowCount}` — use for INSERT/UPDATE
- `queryAll()` returns `result.rows` array — use for SELECT
- `queryOne()` returns `result.rows[0]` — use for SELECT single row
- Signal `decay_model` must be one of: `linear`, `cliff`, `exponential`
- All agent decisions stored in `agent_decisions` table
- Signals stored in `signals` table — require `symbol` field (NOT NULL)

## Rate Limits

- Anthropic API: 30k input tokens/min on current tier
- Knowledge agents run in batches of 2 with 60s delay between batches
- Rate limit retry: 3 attempts with exponential backoff (15s, 30s)

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
```

## Coding Conventions

- API routes: Fastify pattern — `fastify.get/post(path, handler)` with `request, reply` params
- All API routes require JWT auth via `fastify.authenticate` preHandler
- POST endpoints must accept `{}` body (Fastify rejects empty body with content-type: json)
- Frontend: functional React components, Zustand stores, `lib/api.js` for HTTP calls
- Design system: see `DESIGN-SYSTEM.md` for color tokens and UI rules
