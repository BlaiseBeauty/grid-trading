'use strict';

const OracleBaseAgent     = require('./base-agent');
const { getEvidenceSummary } = require('../ingestion/orchestrator');
const { queryAll }        = require('../../../db/connection');
const { computeMultipliers, getLearningsForDomain } = require('./calibration');
const llm                 = require('../../../shared/llm-client');
const { MODELS }          = require('../../../shared/models');
const {
  UNTRUSTED_INSTRUCTION, sanitizeExternal, cleanText, wrapUntrusted,
} = require('./validation');

const HEADLINE_MAX = 300;
const DESCRIPTION_MAX = 800;
const SENTIMENTS = ['bullish', 'bearish', 'neutral'];

// ── SHARED CONTEXT BUILDER ────────────────────────────────────────────────────

/**
 * Format one evidence row as a single sanitised line (no tags, no control chars, capped).
 * Pure — exported for tests.
 */
function formatEvidenceLine(e) {
  const rel = Number.isFinite(Number(e.relevance_score)) ? Number(e.relevance_score) : 0;
  const sentiment = SENTIMENTS.includes(e.sentiment) ? e.sentiment : 'unknown';
  return `[${sanitizeExternal(e.source_name, 60)}] ${sanitizeExternal(e.headline, HEADLINE_MAX)} ` +
         `(relevance: ${rel}, sentiment: ${sentiment})`;
}

async function buildEvidenceContext() {
  const summary = await getEvidenceSummary();

  // Format recent high-relevance evidence for agent consumption — EXTERNAL TEXT: sanitised + delimited
  const evidenceLines = summary.recent
    .slice(0, 20)
    .map(formatEvidenceLine)
    .join('\n');

  // Get FRED macro snapshot
  const fredEvidence = await queryAll(
    `SELECT headline, published_at FROM oracle_evidence
     WHERE source_type = 'fred_macro'
     ORDER BY created_at DESC LIMIT 10`
  );
  const fredLines = fredEvidence.map(e => sanitizeExternal(e.headline, HEADLINE_MAX)).join('\n');

  // Get active theses (for cross-reference). These are LLM-written from external text, so they are
  // treated as untrusted too (second-order injection).
  const activeTheses = await queryAll(
    `SELECT name, domain, direction, conviction, summary
     FROM oracle_theses WHERE status = 'active'
     ORDER BY conviction DESC LIMIT 10`
  );
  const thesisLines = activeTheses.length > 0
    ? activeTheses.map(t => `- ${sanitizeExternal(t.name, 120)} (${t.direction}, ${t.conviction}/10): ${sanitizeExternal(t.summary, DESCRIPTION_MAX)}`).join('\n')
    : 'No active theses yet.';

  const multipliers = await computeMultipliers().catch(() => ({}));

  return { evidenceLines, fredLines, thesisLines, activeTheses, multipliers };
}

// ── AGENT FACTORY ─────────────────────────────────────────────────────────────

function makeSystemPrompt(domain, role, focusAreas) {
  return `You are the ${role} for ORACLE, an investment intelligence system.

Your job is to analyse current evidence and generate ONE high-quality investment thesis
in the ${domain} domain. A thesis is a named, falsifiable narrative about where the world
is going and what that forces markets to do.

FOCUS AREAS FOR YOUR DOMAIN:
${focusAreas}

THESIS QUALITY CRITERIA:
- Specific enough to be proven wrong (not "markets might be volatile")
- Has a clear catalyst (the event that would confirm it)
- Has a clear invalidation condition (the event that would kill it)
- Names specific assets (tickers, futures codes, ETFs) with directional bias
- Conviction score reflects evidence strength: 9-10 = overwhelming evidence,
  7-8 = strong evidence, 5-6 = moderate, below 5 = speculative

OUTPUT: Return ONLY a valid JSON object matching this exact schema:
${new OracleBaseAgent().getThesisSchema()}

If the evidence does not support any strong thesis in your domain right now,
return a thesis with conviction between 4-5 and direction 'neutral'.
Do not invent evidence. Only use what is provided.

${UNTRUSTED_INSTRUCTION}`;
}

// ── THE 6 DOMAIN AGENTS ───────────────────────────────────────────────────────

const DOMAIN_CONFIGS = [
  {
    name: 'oracle-macro-economist',
    domain: 'macro',
    role: 'Chief Macro Economist',
    focusAreas: `
- Federal Reserve policy direction (rates, QE/QT, forward guidance)
- Yield curve shape and inversion signals
- CPI/inflation trajectory and Fed response
- USD strength/weakness and global dollar cycle
- Credit spreads and financial conditions index
- Recession probability signals
- G7/G20 fiscal policy and deficit trends`,
  },
  {
    name: 'oracle-geopolitical-analyst',
    domain: 'geopolitical',
    role: 'Senior Geopolitical Analyst',
    focusAreas: `
- Active military conflicts and their commodity/supply chain impact
- Sanctions regimes and their market effects
- Election outcomes and policy implications
- Trade war escalation/de-escalation
- Energy security and pipeline politics
- Taiwan Strait and South China Sea developments
- NATO expansion and European security architecture`,
  },
  {
    name: 'oracle-tech-disruption',
    domain: 'technology',
    role: 'Technology Disruption Analyst',
    focusAreas: `
- AI model capabilities and adoption curves (which categories get automated)
- Enterprise software displacement by AI-native tools
- Semiconductor supply chain and capacity buildout
- Cloud infrastructure demand driven by AI workloads
- Which SaaS categories face existential AI threat (CRM, project mgmt, HR tech)
- Power/energy demand from data centres
- Regulatory risk to big tech (antitrust, AI regulation)`,
  },
  {
    name: 'oracle-commodity-specialist',
    domain: 'commodity',
    role: 'Senior Commodity Specialist',
    focusAreas: `
- Energy: natural gas storage, crude inventory, OPEC+ compliance, LNG flows
- Agriculture: crop yields, weather/drought impact, Black Sea grain shipments
- Metals: copper demand from electrification, gold as macro hedge, silver industrial
- Softs: cocoa supply recovery, coffee weather, sugar ethanol dynamics
- Supply chain: shipping rates, port congestion, freight indices
- China demand signals for all commodities`,
  },
  {
    name: 'oracle-equity-sector',
    domain: 'equity',
    role: 'Equity Sector Analyst',
    focusAreas: `
- Earnings revision cycles by sector (where are estimates rising/falling)
- P/E multiple expansion or compression triggers
- Sector rotation signals (growth vs value, cyclical vs defensive)
- Defence spending wave and prime contractor backlogs
- Healthcare/biotech catalysts (FDA approvals, patent cliffs)
- Financial sector: bank margin pressure, credit quality
- Industrial/infrastructure: IRA spending, reshoring, grid investment`,
  },
  {
    name: 'oracle-crypto-analyst',
    domain: 'crypto',
    role: 'Crypto and Digital Assets Analyst',
    focusAreas: `
- Bitcoin halving cycle position and historical pattern
- Institutional adoption (ETF flows, corporate treasury allocation)
- Regulatory pipeline (SEC, CFTC, MiCA in Europe)
- On-chain metrics: exchange reserves, long-term holder behaviour
- DeFi TVL trends and protocol revenue
- Stablecoin dynamics and USDT/USDC market share
- Layer 2 adoption and Ethereum fee economics`,
  },
];

async function runDomainAgents({ cycleId = null } = {}) {
  console.log(`[ORACLE-AGENTS${cycleId != null ? ` c${cycleId}` : ''}] Running ${DOMAIN_CONFIGS.length} domain thesis agents...`);
  const context = await buildEvidenceContext();
  const results = [];

  // Run in batches of 2 (rate limit management)
  for (let i = 0; i < DOMAIN_CONFIGS.length; i += 2) {
    const batch = DOMAIN_CONFIGS.slice(i, i + 2);

    const batchResults = await Promise.all(
      batch.map(async (config) => {
        const agent = new OracleBaseAgent({
          name:     config.name,
          domain:   config.domain,
          model:    MODELS.oracle_domain,
          costTier: 'oracle_domain',
          cycleId,
        });

        const systemPrompt = makeSystemPrompt(
          config.domain, config.role, config.focusAreas
        );

        const userPrompt = `
CURRENT EVIDENCE (last 24 hours):
${wrapUntrusted('news_evidence', context.evidenceLines || 'No recent evidence available.')}

FRED MACRO DATA:
${wrapUntrusted('fred', context.fredLines || 'No FRED data available.')}

EXISTING ACTIVE THESES (do not duplicate):
${wrapUntrusted('existing_theses', context.thesisLines)}

Based on this evidence, generate your single highest-conviction thesis
for the ${config.domain} domain right now. Return ONLY valid JSON.`;

        try {
          console.log(`[ORACLE-AGENTS] Running ${config.name}...`);

          // Get domain-specific calibration learnings
          const learnings = await getLearningsForDomain(config.domain).catch(() => []);
          const multiplier = context.multipliers?.[config.domain] || 1.0;

          const calibrationContext = [
            multiplier !== 1.0
              ? `\nCALIBRATION: Your domain's historical accuracy warrants a conviction multiplier of ×${multiplier}. ` +
                `${multiplier > 1 ? 'Your theses have been accurate — maintain confidence.' : 'Your theses have underperformed — be more conservative with conviction scores.'}`
              : '',
            learnings.length > 0
              ? `\nRECENT LEARNINGS FOR ${config.domain.toUpperCase()} DOMAIN:\n` +
                learnings.map(l => `  - ${cleanText(l.learning_type, 60)}: ${cleanText(l.summary, 400)}${l.adjustment_rule ? '\n    Rule: ' + cleanText(l.adjustment_rule, 400) : ''}`).join('\n')
              : '',
          ].filter(Boolean).join('\n');

          const finalUserPrompt = userPrompt + calibrationContext;
          const raw    = await agent.callClaude(systemPrompt, finalUserPrompt);
          const thesis = agent.parseThesis(raw);

          if (!thesis) {
            console.error(`[ORACLE-AGENTS] ${config.name} failed to produce valid thesis`);
            return { agent: config.name, thesis: null, error: 'parse_failed' };
          }

          // Apply calibration multiplier to conviction
          if (multiplier !== 1.0) {
            const originalConviction = thesis.conviction;
            thesis.conviction = Math.max(0, Math.min(10,
              parseFloat((thesis.conviction * multiplier).toFixed(2))
            ));
            if (thesis.conviction !== originalConviction) {
              console.log(
                `[ORACLE-AGENTS] ${config.name}: conviction adjusted ` +
                `${originalConviction} → ${thesis.conviction} (×${multiplier})`
              );
            }
          }

          // Always mint our own thesis_id. An LLM-chosen id could collide with (and via the
          // ON CONFLICT (thesis_id) upsert overwrite) a thesis from another domain.
          const ts = Date.now().toString(36).toUpperCase();
          const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
          thesis.thesis_id = `oracle-${config.domain.slice(0, 4)}-${ts}${rnd}`;

          console.log(
            `[ORACLE-AGENTS] ${config.name}: "${thesis.name}" ` +
            `(${thesis.direction}, ${thesis.conviction}/10)`
          );
          return { agent: config.name, thesis, error: null };

        } catch (err) {
          console.error(`[ORACLE-AGENTS] ${config.name} threw:`, err.message);
          return { agent: config.name, thesis: null, error: err.message };
        }
      })
    );

    results.push(...batchResults);

    // Rate-limit spacing between batches: LLM_BATCH_DELAY_MS (default 20s), tripled for 5 min
    // after any 429 (see shared/llm-client.js batchDelayMs).
    if (i + 2 < DOMAIN_CONFIGS.length) {
      await llm.waitBetweenBatches('[ORACLE-AGENTS] Batch');
    }
  }

  const succeeded = results.filter(r => r.thesis !== null);
  const failed    = results.filter(r => r.thesis === null);
  console.log(`[ORACLE-AGENTS] ${succeeded.length} theses generated, ${failed.length} failed`);

  return results;
}

module.exports = { runDomainAgents, buildEvidenceContext, formatEvidenceLine };
