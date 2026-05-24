#!/bin/bash
# =============================================================================
# GRID Phase 0 Verification Script
# Run from project root: bash verify-phase0.sh
# Requires: server running on localhost:3100, .env loaded
# =============================================================================

source .env 2>/dev/null || true

BASE="http://localhost:3100"
PASS=0
FAIL=0
WARN=0

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL + 1)); }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; WARN=$((WARN + 1)); }
section() { echo -e "\n${CYAN}── $1 ──────────────────────────────────────${NC}"; }

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     GRID PHASE 0 — VERIFICATION SUITE               ║"
echo "╚══════════════════════════════════════════════════════╝"

# =============================================================================
# 1. FILE STRUCTURE
# =============================================================================
section "1. FOLDER STRUCTURE"

dirs=(
  "systems/grid/agents"
  "systems/grid/api"
  "systems/grid/config"
  "systems/compass/agents"
  "systems/compass/api"
  "systems/compass/db"
  "systems/oracle/agents"
  "systems/oracle/api"
  "systems/oracle/db"
  "systems/oracle/ingestion"
  "shared"
  "api/platform"
)
for d in "${dirs[@]}"; do
  [ -d "$d" ] && pass "Directory exists: $d" || fail "MISSING directory: $d"
done

files=(
  "shared/intelligence-bus.js"
  "shared/notifications.js"
  "shared/conflict-resolver.js"
  "shared/ai-costs.js"
  "api/platform/notifications.js"
  "api/platform/health.js"
  "systems/grid/agents/orchestrator.js"
  "systems/grid/api/trades.js"
  "systems/grid/api/portfolio.js"
  "server.js"
)
for f in "${files[@]}"; do
  [ -f "$f" ] && pass "File exists: $f" || fail "MISSING file: $f"
done

# =============================================================================
# 2. OLD PATHS GONE
# =============================================================================
section "2. OLD PATHS CLEANED UP"

if grep -q "require('./agents/" server.js 2>/dev/null; then
  fail "server.js still has require('./agents/') — old path not updated"
else
  pass "server.js: no old ./agents/ paths"
fi

if grep "require('./api/" server.js 2>/dev/null | grep -v "auth" | grep -v "platform" | grep -q .; then
  fail "server.js still has require('./api/') — old GRID API path not updated"
else
  pass "server.js: no old ./api/ paths (auth + platform correctly at root)"
fi

# =============================================================================
# 3. CROSS-SYSTEM IMPORT CHECK
# =============================================================================
section "3. CROSS-SYSTEM BOUNDARY CHECK"

if grep -rq "require.*systems/oracle" systems/grid/ 2>/dev/null; then
  fail "GRID imports ORACLE directly — boundary violation"
else
  pass "GRID does not import ORACLE directly"
fi

if grep -rq "require.*systems/compass" systems/grid/ 2>/dev/null; then
  fail "GRID imports COMPASS directly — boundary violation"
else
  pass "GRID does not import COMPASS directly"
fi

if grep -rq "require.*systems/grid" systems/oracle/ 2>/dev/null; then
  warn "ORACLE imports GRID directly (may be intentional in stubs — check)"
else
  pass "ORACLE does not import GRID directly"
fi

# =============================================================================
# 4. MODULE LOAD TEST
# =============================================================================
section "4. MODULE LOAD (require check)"

node_check() {
  local mod=$1
  node -e "require('$mod')" 2>/dev/null \
    && pass "Loads OK: $mod" \
    || fail "LOAD ERROR: $mod"
}

node_check "./shared/intelligence-bus"
node_check "./shared/notifications"
node_check "./shared/conflict-resolver"
node_check "./shared/ai-costs"
node_check "./systems/grid/agents/orchestrator"
node_check "./systems/grid/api/trades"
node_check "./systems/grid/api/portfolio"
node_check "./db/connection"

# =============================================================================
# 5. SERVER RUNNING CHECK
# =============================================================================
section "5. SERVER HEALTH CHECK"

if ! curl -sf "$BASE/api/system/health" -o /dev/null 2>/dev/null; then
  warn "Server not reachable at $BASE — skipping HTTP tests"
  warn "Start the server with 'npm start' and re-run to test API endpoints"
  echo ""
  echo -e "${DIM}  Skipping sections 6–9 (server not running)${NC}"
  SKIP_HTTP=true
else
  pass "Server reachable at $BASE"
  SKIP_HTTP=false
fi

# =============================================================================
# 6. AUTH + TOKEN
# =============================================================================
if [ "$SKIP_HTTP" != "true" ]; then

section "6. AUTHENTICATION"

LOGIN=$(curl -sf -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" 2>/dev/null)

TOKEN=$(echo "$LOGIN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).token||JSON.parse(d).accessToken||'')}catch(e){}})" 2>/dev/null)

if [ -n "$TOKEN" ]; then
  pass "Login successful — JWT token received"
else
  fail "Login failed — no token returned. Check ADMIN_EMAIL / ADMIN_PASSWORD in .env"
fi

AUTH="-H \"Authorization: Bearer $TOKEN\""

# =============================================================================
# 7. EXISTING GRID ENDPOINTS (regression)
# =============================================================================
section "7. GRID ENDPOINT REGRESSION"

check_endpoint() {
  local label=$1
  local url=$2
  HTTP=$(curl -sf -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" "$url" 2>/dev/null)
  if [ "$HTTP" = "200" ]; then
    pass "$label → HTTP $HTTP"
  elif [ "$HTTP" = "401" ]; then
    fail "$label → HTTP $HTTP (auth failed)"
  elif [ "$HTTP" = "404" ]; then
    fail "$label → HTTP $HTTP (route not found — path may not be updated in server.js)"
  else
    warn "$label → HTTP $HTTP (unexpected)"
  fi
}

check_endpoint "GET /api/portfolio"       "$BASE/api/portfolio"
check_endpoint "GET /api/trades"          "$BASE/api/trades"
check_endpoint "GET /api/agents"          "$BASE/api/agents"
check_endpoint "GET /api/signals"         "$BASE/api/signals"
check_endpoint "GET /api/market-data"     "$BASE/api/market-data"
check_endpoint "GET /api/templates"       "$BASE/api/templates"
check_endpoint "GET /api/learnings"       "$BASE/api/learnings"
check_endpoint "GET /api/analytics"       "$BASE/api/analytics"

# =============================================================================
# 8. NEW PLATFORM ENDPOINTS
# =============================================================================
section "8. NEW PLATFORM ENDPOINTS"

check_endpoint "GET /api/platform/notifications" "$BASE/api/platform/notifications"
check_endpoint "GET /api/platform/health"        "$BASE/api/platform/health"

# Validate health response structure
HEALTH=$(curl -sf -H "Authorization: Bearer $TOKEN" "$BASE/api/platform/health" 2>/dev/null)
HAS_SYSTEMS=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const h=JSON.parse(d);console.log(h.systems?'yes':'no')}catch(e){console.log('no')}})" 2>/dev/null)
HAS_BUS=$(echo "$HEALTH" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const h=JSON.parse(d);console.log(h.intelligence_bus?'yes':'no')}catch(e){console.log('no')}})" 2>/dev/null)

[ "$HAS_SYSTEMS" = "yes" ] && pass "Health response has 'systems' field" || fail "Health response missing 'systems' field"
[ "$HAS_BUS" = "yes" ]     && pass "Health response has 'intelligence_bus' field" || fail "Health response missing 'intelligence_bus' field"

fi # end SKIP_HTTP

# =============================================================================
# 9. DATABASE CHECKS
# =============================================================================
section "9. DATABASE TABLES"

if [ -z "$DATABASE_URL" ]; then
  warn "DATABASE_URL not set — skipping DB checks"
else
  # Use Node.js for DB checks (psql may not be installed locally)
  db_check() {
    local label=$1
    local sql=$2
    local expected=$3
    RESULT=$(node -e "
      require('dotenv').config();
      const { queryOne } = require('./db/connection');
      queryOne(\`$sql\`).then(r => {
        console.log('DBRESULT:' + Object.values(r)[0]);
        setTimeout(() => process.exit(0), 100);
      }).catch(() => { console.log('DBRESULT:'); process.exit(0); });
    " 2>/dev/null | grep 'DBRESULT:' | sed 's/DBRESULT://' | tr -d ' \n')
    if [ "$RESULT" = "$expected" ]; then
      pass "DB: $label"
    else
      fail "DB: $label (got '$RESULT', expected '$expected')"
    fi
  }

  db_check "intelligence_bus table exists" \
    "SELECT COUNT(*)::int FROM information_schema.tables WHERE table_name='intelligence_bus'" "1"

  db_check "platform_notifications table exists" \
    "SELECT COUNT(*)::int FROM information_schema.tables WHERE table_name='platform_notifications'" "1"

  db_check "platform_ai_costs table exists" \
    "SELECT COUNT(*)::int FROM information_schema.tables WHERE table_name='platform_ai_costs'" "1"

  db_check "platform_system_health table exists" \
    "SELECT COUNT(*)::int FROM information_schema.tables WHERE table_name='platform_system_health'" "1"

  db_check "intelligence_bus_active view exists" \
    "SELECT COUNT(*)::int FROM information_schema.views WHERE table_name='intelligence_bus_active'" "1"

  # Check indexes
  db_check "intelligence_bus: idx_bus_source_type index" \
    "SELECT COUNT(*)::int FROM pg_indexes WHERE indexname='idx_bus_source_type'" "1"

  db_check "intelligence_bus: idx_bus_assets GIN index" \
    "SELECT COUNT(*)::int FROM pg_indexes WHERE indexname='idx_bus_assets'" "1"

  # Check bus has events
  BUS_COUNT=$(node -e "
    require('dotenv').config();
    const { queryOne } = require('./db/connection');
    queryOne('SELECT COUNT(*)::int as cnt FROM intelligence_bus').then(r => {
      console.log('DBRESULT:' + r.cnt);
      setTimeout(() => process.exit(0), 100);
    }).catch(() => { console.log('DBRESULT:0'); process.exit(0); });
  " 2>/dev/null | grep 'DBRESULT:' | sed 's/DBRESULT://' | tr -d ' \n')
  if [ -n "$BUS_COUNT" ] && [ "$BUS_COUNT" -gt "0" ] 2>/dev/null; then
    pass "intelligence_bus has $BUS_COUNT events (GRID trade events flowing)"
  else
    warn "intelligence_bus is empty — trigger a paper trade to test event flow"
  fi
fi

# =============================================================================
# 10. BUS EVENT FLOW TEST
# =============================================================================
section "10. INTELLIGENCE BUS PUBLISH TEST"

node -e "
require('dotenv').config();
const bus = require('./shared/intelligence-bus');
bus.publish({
  source_system: 'grid',
  event_type: 'test_event',
  payload: { test: true, phase: 0, ts: Date.now() },
  affected_assets: ['TEST'],
  direction: 'neutral',
  expires_at: new Date(Date.now() + 60000).toISOString()
}).then(r => {
  console.log('BUS_PUBLISH_OK:' + (r ? r.id : 'done'));
  setTimeout(() => process.exit(0), 100);
}).catch(err => {
  console.error('BUS_PUBLISH_FAIL:' + err.message);
  process.exit(1);
});
" 2>/dev/null | grep -q "BUS_PUBLISH_OK" \
  && pass "intelligence_bus.publish() — event written successfully" \
  || fail "intelligence_bus.publish() — FAILED (DB connection issue?)"

# =============================================================================
# SUMMARY
# =============================================================================
TOTAL=$((PASS + FAIL + WARN))
echo ""
echo "╔══════════════════════════════════════════════════════╗"
printf "║  RESULTS: ${GREEN}%d passed${NC}  ${RED}%d failed${NC}  ${YELLOW}%d warnings${NC}  (${TOTAL} total) \n" $PASS $FAIL $WARN
echo "╚══════════════════════════════════════════════════════╝"
echo ""

if [ $FAIL -eq 0 ] && [ $WARN -le 2 ]; then
  echo -e "${GREEN}✓ Phase 0 complete. Ready for Phase 1.${NC}"
  echo ""
  echo "  Next: run Phase 1 prompts to wire:"
  echo "  - AI cost tracking into base-agent.js"
  echo "  - Weekly performance_digest bus events"
  echo "  - WebSocket broadcast for bus events"
  echo ""
elif [ $FAIL -eq 0 ]; then
  echo -e "${YELLOW}⚠ Phase 0 passed with warnings. Review warnings above before Phase 1.${NC}"
elif [ $FAIL -le 3 ]; then
  echo -e "${YELLOW}⚠ ${FAIL} failure(s). Fix before proceeding to Phase 1.${NC}"
  echo "  Most common causes:"
  echo "  - Server not running (re-run with server active)"
  echo "  - DATABASE_URL not in .env"
  echo "  - require() path not updated in a moved file"
else
  echo -e "${RED}✗ ${FAIL} failure(s). Do not proceed to Phase 1 until resolved.${NC}"
fi

echo ""
exit $FAIL
