#!/usr/bin/env node
/**
 * Silent Failure Audit
 * Identifies code patterns that could cause undetected failures.
 * Does not run code — performs static analysis on key files.
 *
 * Run with: node tests/audit-silent-failures.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

let warnings = 0;
let criticals = 0;

function warn(file, message) {
  console.log(`  \u26a0 WARN [${file}]: ${message}`);
  warnings++;
}

function critical(file, message) {
  console.log(`  \u2717 CRITICAL [${file}]: ${message}`);
  criticals++;
}

function ok(message) {
  console.log(`  \u2713 OK: ${message}`);
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function checkFile(filePath, checks) {
  const src = readFile(filePath);
  if (!src) {
    warn(filePath, 'File not found \u2014 skip');
    return;
  }
  for (const check of checks) {
    check(src, path.basename(filePath));
  }
}

// -- Checks --

function noUnhandledPromises(src, name) {
  // Bare .catch(() => {}) with no logging swallows errors silently
  const silentCatch = src.match(/\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || [];
  if (silentCatch.length > 3) {
    warn(name, `${silentCatch.length} silent .catch(() => {}) found \u2014 consider logging`);
  } else {
    ok(`${name}: silent catches within acceptable range (${silentCatch.length})`);
  }
}

function tradeCloseIsAtomic(src, name) {
  // If we update trades status to closed AND pnl, both should ideally be atomic
  const hasStatusClosed = src.includes("status = 'closed'") || src.includes("status='closed'");
  const hasPnlUpdate    = src.includes('pnl_realised') || src.includes('closed_at');
  const hasTransaction  = src.includes('BEGIN') || src.includes('transaction');

  if (hasStatusClosed && hasPnlUpdate && !hasTransaction) {
    critical(name,
      'Trade close updates status and PnL WITHOUT a transaction \u2014 ' +
      'partial failure leaves DB in inconsistent state'
    );
  } else if (hasStatusClosed && hasPnlUpdate) {
    ok(`${name}: trade close appears to use transaction`);
  }
}

function engineUrlNotHardcoded(src, name) {
  if (src.includes('127.0.0.1:5100') || src.includes('localhost:5100')) {
    if (!src.includes('process.env.PYTHON_ENGINE_URL') && !src.includes('PYTHON_ENGINE_URL')) {
      critical(name, 'Python engine URL hardcoded \u2014 will fail on Railway (use PYTHON_ENGINE_URL env var)');
    }
  }
}

function positionDeduplication(src, name) {
  // Check that trade/position creation has ON CONFLICT or a prior existence check
  if (src.includes('INSERT INTO trades') || src.includes('INSERT INTO positions')) {
    const hasConflict = src.includes('ON CONFLICT') || src.includes('WHERE NOT EXISTS');
    if (!hasConflict) {
      warn(name, 'INSERT into trades/positions without ON CONFLICT \u2014 may create duplicates under race conditions');
    } else {
      ok(`${name}: trade/position insert has conflict guard`);
    }
  }
}

function tokenBudgetEnforced(src, name) {
  // Agents with large context should have explicit token limits
  if (src.includes('max_tokens') || src.includes('maxTokens')) {
    ok(`${name}: explicit token limit found`);
  } else if (src.includes('callClaude') || src.includes('messages.create')) {
    warn(name, 'Claude call found without explicit max_tokens \u2014 may overflow on large context');
  }
}

function busPublishWrapped(src, name) {
  // bus.publish() must never block a primary operation
  const busPublishCount   = (src.match(/bus\.publish\(/g) || []).length;
  const tryCatchCount     = (src.match(/try\s*\{/g) || []).length;

  if (busPublishCount > 0 && tryCatchCount === 0) {
    warn(name, `${busPublishCount} bus.publish() calls without any try/catch \u2014 bus failure could break primary operation`);
  } else if (busPublishCount > 0) {
    ok(`${name}: bus.publish() present with try/catch coverage`);
  }
}

function noDirectCrossSystemImport(src, name) {
  // systems/grid should never import from systems/oracle and vice versa
  const importsOracle  = src.includes("require('../oracle") || src.includes("require('../../oracle");
  const importsGrid    = src.includes("require('../grid") || src.includes("require('../../grid");
  const importsCompass = src.includes("require('../compass") || src.includes("require('../../compass");

  if (importsOracle || importsGrid || importsCompass) {
    critical(name, 'Direct cross-system import detected \u2014 violates bus-only cross-system rule');
  }
}

// -- Run audit --

console.log('\n' + '='.repeat(60));
console.log('SILENT FAILURE AUDIT \u2014 STATIC ANALYSIS');
console.log('='.repeat(60));

const filesToAudit = [
  // Core orchestrators
  { path: 'systems/grid/agents/orchestrator.js',         checks: [noUnhandledPromises, engineUrlNotHardcoded, positionDeduplication, busPublishWrapped] },
  { path: 'systems/oracle/agents/orchestrator.js',       checks: [noUnhandledPromises, tokenBudgetEnforced, busPublishWrapped] },
  { path: 'systems/compass/agents/orchestrator.js',      checks: [noUnhandledPromises, busPublishWrapped] },

  // Trade execution
  { path: 'systems/grid/agents/strategy/risk-manager.js', checks: [tradeCloseIsAtomic, positionDeduplication, noDirectCrossSystemImport] },

  // Base agents
  { path: 'systems/grid/agents/base-agent.js',           checks: [tokenBudgetEnforced] },
  { path: 'systems/oracle/agents/base-agent.js',         checks: [tokenBudgetEnforced] },
  { path: 'systems/compass/agents/base-agent.js',        checks: [tokenBudgetEnforced] },

  // Intelligence bus
  { path: 'shared/intelligence-bus.js',                  checks: [noUnhandledPromises] },
  { path: 'shared/thesis-linker.js',                     checks: [busPublishWrapped] },

  // Server
  { path: 'server.js',                                   checks: [engineUrlNotHardcoded] },

  // API trade close handlers
  { path: 'systems/grid/api/trades.js',                  checks: [tradeCloseIsAtomic, busPublishWrapped] },
];

for (const { path: filePath, checks } of filesToAudit) {
  console.log(`\nAuditing: ${filePath}`);
  checkFile(filePath, checks);
}

// -- Manual checklist --
console.log('\n\u2500\u2500 MANUAL CHECKS REQUIRED \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
console.log(`
These cannot be automatically verified \u2014 review manually:

  \u25a1 Does the position monitor (every 15min) have a timeout?
    If it hangs indefinitely, it blocks future monitors and positions
    stay open indefinitely. Add a 60s timeout to the monitor HTTP call.

  \u25a1 If the Python engine is unreachable, does GRID:
    (a) Fail gracefully and skip the trade?
    (b) Log the error with the URL attempted?
    (c) NOT retry indefinitely?

  \u25a1 If PostgreSQL connection drops mid-cycle:
    (a) Does the cycle fail cleanly?
    (b) Does the heartbeat still get written?
    (c) Can the next cycle start fresh?

  \u25a1 If Anthropic returns a 529 (overloaded):
    (a) Does the retry logic handle it with exponential backoff?
    (b) Does it eventually give up and mark the cycle as failed?
    (c) Does it NOT leave positions open without oversight?

  \u25a1 Are all Railway environment variables set?
    Verify: DATABASE_URL, ANTHROPIC_API_KEY, PYTHON_ENGINE_URL,
            JWT_SECRET, JWT_REFRESH_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
    LIVE_TRADING_ENABLED should be 'false' until go/no-go.

  \u25a1 Is Railway's health check endpoint (/api/platform/health)
    returning 200 consistently? Check Railway logs for restarts.
`);

// -- Summary --
console.log('='.repeat(60));
console.log(`AUTOMATED RESULT: ${warnings} warnings, ${criticals} criticals`);
if (criticals === 0 && warnings <= 3) {
  console.log('STATUS: \u2713 SILENT FAILURE AUDIT \u2014 PASS');
} else if (criticals === 0) {
  console.log('STATUS: \u26a0 SILENT FAILURE AUDIT \u2014 REVIEW WARNINGS');
} else {
  console.log('STATUS: \u2717 SILENT FAILURE AUDIT \u2014 FAIL (fix criticals before going live)');
}
console.log('='.repeat(60) + '\n');

process.exit(criticals > 0 ? 1 : 0);
