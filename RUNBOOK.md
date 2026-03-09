# GRID Platform — Operational Runbook

> Last updated: 2026-03-08
> Status: Paper trading / Pre-live

---

## System Architecture Quick Reference

| System  | Port | Cron | Purpose |
|---------|------|------|---------|
| Node.js | 3100 | All crons | Main server, API, WebSocket, orchestration |
| Python  | 5100 | None | Binance order execution via CCXT |
| PostgreSQL | Railway | — | All state |

---

## Health Checks

```bash
# Is the server running?
curl https://your-railway-url/api/platform/health

# All 3 systems in one view:
curl -H "Authorization: Bearer $JWT" https://your-railway-url/api/platform/health | jq .

# Is the Python engine running?
curl https://your-railway-url/api/system/engine-health  # if proxied via Node
```

---

## Emergency Procedures

### SCRAM — Halt all trading immediately
**When to use:** Any drawdown > 8%, exchange connectivity failure, suspicious
positions, or any situation where you need everything stopped NOW.

```bash
# Option 1: Environment variable (Railway — takes effect on next cycle)
# Set LIVE_TRADING_ENABLED=false in Railway dashboard

# Option 2: API call (immediate — closes positions via Python engine)
curl -X POST -H "Authorization: Bearer $JWT" \
  https://your-railway-url/api/system/scram \
  -H "Content-Type: application/json" \
  -d '{"level": "EMERGENCY", "reason": "Manual SCRAM - [your reason]"}'

# Option 3: Railway — stop the deployment entirely
# Railway Dashboard → Your Service → Settings → Suspend
```

**After SCRAM:**
1. Verify all positions are closed: GET /api/portfolio
2. Check Binance directly: log into Binance, confirm no open orders
3. Check trades table: SELECT * FROM trades WHERE status = 'open';
4. Do NOT restart until root cause identified

---

### Python Engine Down
**Symptoms:** Agent cycle logs "Engine unreachable", no new positions opening

```bash
# Check Railway logs for Python engine service
# Restart just the engine:
# Railway → trading service → Restart

# Verify after restart:
curl https://your-railway-url/health  # Python engine health
```

**Impact:** GRID cannot open/close positions. Existing open trades remain open.
Existing monitoring continues. No data loss.

---

### ORACLE Cycle Failing
**Symptoms:** No new theses, oracle_raw_feed not updating, high API cost

```bash
# Check logs:
# Railway → main service → Logs → filter "ORACLE"

# Manually trigger ingestion only (cheap, no AI cost):
curl -X POST -H "Authorization: Bearer $JWT" \
  https://your-railway-url/api/oracle/ingest

# Check FRED API (free tier, may hit limits):
# https://api.stlouisfed.org/fred/series?series_id=DGS10&api_key=YOUR_KEY

# Check Anthropic status:
# https://status.anthropic.com
```

**Impact:** ORACLE theses go stale. COMPASS falls back to last known posture.
GRID continues on last COMPASS limits. System degrades gracefully.

---

### COMPASS Cycle Failing
**Symptoms:** GRID Risk Manager logs "COMPASS limits unavailable, using defaults"

```bash
# Manually trigger COMPASS:
curl -X POST -H "Authorization: Bearer $JWT" \
  https://your-railway-url/api/compass/cycle/run

# Check what limits GRID is using:
node -e "require('./shared/intelligence-bus').getRiskState().then(r => console.log(r?.payload))"
```

**Impact:** GRID falls back to config/risk-limits.js — hardcoded safe defaults.
Trading continues within conservative limits.

---

### Database Connection Issues
**Symptoms:** Server health returns 500, all API calls failing

```bash
# Check Railway PostgreSQL:
# Railway → Postgres service → Status

# Check connection pool:
# Look for "connection refused" or "too many clients" in logs

# Emergency: reduce pool size in db/connection.js
# max: 10 → max: 3 (reduces load)
```

---

### Anthropic Rate Limit (429)
**Symptoms:** Agent cycle very slow, logs show "Rate limit, waiting Xs"

The retry logic handles this automatically. However, if cycles are consistently
hitting limits:

```bash
# Check token usage:
SELECT agent_name, SUM(input_tokens) FROM agent_decisions
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY agent_name ORDER BY SUM(input_tokens) DESC;

# If consistently > 30k input/min: reduce batch parallelism
# In systems/grid/agents/orchestrator.js — increase delay between batches
```

---

## Monitoring Checklist (Daily)

Run every morning when live:

- [ ] GET /api/platform/health — all 3 systems healthy
- [ ] SELECT * FROM trades WHERE status='open'; — any stale positions?
- [ ] GET /api/compass/risk — risk score reasonable?
- [ ] GET /api/portfolio — P&L within expected range?
- [ ] Railway logs — any ERROR or FATAL in last 24h?
- [ ] Binance account directly — positions match DB?
- [ ] AI costs: GET /api/platform/costs/summary — within budget?

---

## Key Environment Variables

| Variable | Purpose | Value |
|----------|---------|-------|
| LIVE_TRADING_ENABLED | Master trading switch | false → true on go-live |
| ANTHROPIC_API_KEY | Claude API | sk-ant-... |
| BINANCE_API_KEY | Exchange API | |
| BINANCE_SECRET | Exchange secret | |
| PYTHON_ENGINE_URL | Engine internal URL | Railway internal URL |
| DATABASE_URL | PostgreSQL | Railway provides |
| JWT_SECRET | Auth | Generate with openssl rand -hex 32 |

---

## Cron Schedule Reference

```
0 */4 * * *         GRID 4h cycle (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
*/15 * * * *        Position monitor
0 * * * *           Hourly cleanup (signals + bus purge + oracle raw feed)
0 6 * * 1           Weekly performance digest (Monday 06:00)
0 0,6,12,18 * * *   ORACLE ingestion (runs 30min before agents)
30 0,6,12,18 * * *  ORACLE agent cycle (6 domain + synthesis)
15 1,7,13,19 * * *  COMPASS 6h cycle (45min after ORACLE)
0 7 * * 2           Graveyard Auditor + calibration update (Tuesday 07:00)
```

---

## Go-Live Checklist

Before setting LIVE_TRADING_ENABLED=true:

- [ ] All Phase 6 audit checks passed
- [ ] Binance live API keys set (read + trade, NOT withdraw)
- [ ] Small initial balance only ($500-$2,000 recommended first week)
- [ ] COMPASS risk posture is 'neutral' or 'defensive' (not 'aggressive')
- [ ] ORACLE has active theses (evidence ingestion working)
- [ ] Notification drawer working — you will see trade_executed events in real time
- [ ] Phone notifications configured (if available)
- [ ] Know your personal SCRAM threshold — at what drawdown % will you pull the plug manually?
- [ ] You have read this runbook in the last 48h
