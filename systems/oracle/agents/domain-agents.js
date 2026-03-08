'use strict';

const OracleBaseAgent     = require('./base-agent');
const { getEvidenceSummary } = require('../ingestion/orchestrator');
const { queryAll }        = require('../../../db/connection');

// ── SHARED CONTEXT BUILDER ────────────────────────────────────────────────────

async function buildEvidenceContext() {
  const summary = await getEvidenceSummary();

  // Format recent high-relevance evidence for agent consumption
  const evidenceLines = summary.recent
    .slice(0, 20)
    .map(e => `[${e.source_name}] ${e.headline} (relevance: ${e.relevance_score}, sentiment: ${e.sentiment || 'unknown'})`)
    .join('\n');

  // Get FRED macro snapshot
  const fredEvidence = await queryAll(
    `SELECT headline, published_at FROM oracle_evidence
     WHERE source_type = 'fred_macro'
     ORDER BY created_at DESC LIMIT 10`
  );
  const fredLines = fredEvidence.map(e => e.headline).join('\n');

  // Get active theses (for cross-reference)
  const activeTheses = await queryAll(
    `SELECT name, domain, direction, conviction, summary
     FROM oracle_theses WHERE status = 'active'
     ORDER BY conviction DESC LIMIT 10`
  );
  const thesisLines = activeTheses.length > 0
    ? activeTheses.map(t => `- ${t.name} (${t.direction}, ${t.conviction}/10): ${t.summary}`).join('\n')
    : 'No active theses yet.';

  return { evidenceLines, fredLines, thesisLines, activeTheses };
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
Do not invent evidence. Only use what is provided.`;
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

async function runDomainAgents() {
  console.log('[ORACLE-AGENTS] Running 6 domain thesis agents...');
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
          costTier: 'oracle_domain',
        });

        const systemPrompt = makeSystemPrompt(
          config.domain, config.role, config.focusAreas
        );

        const userPrompt = `
CURRENT EVIDENCE (last 24 hours):
${context.evidenceLines || 'No recent evidence available.'}

FRED MACRO DATA:
${context.fredLines || 'No FRED data available.'}

EXISTING ACTIVE THESES (do not duplicate):
${context.thesisLines}

Based on this evidence, generate your single highest-conviction thesis
for the ${config.domain} domain right now. Return ONLY valid JSON.`;

        try {
          console.log(`[ORACLE-AGENTS] Running ${config.name}...`);
          const raw    = await agent.callClaude(systemPrompt, userPrompt);
          const thesis = agent.parseThesis(raw);

          if (!thesis) {
            console.error(`[ORACLE-AGENTS] ${config.name} failed to produce valid thesis`);
            return { agent: config.name, thesis: null, error: 'parse_failed' };
          }

          // Assign a unique thesis_id if not provided
          if (!thesis.thesis_id || thesis.thesis_id.includes('XXX')) {
            const ts = Date.now().toString(36).toUpperCase();
            thesis.thesis_id = `oracle-${config.domain.slice(0, 4)}-${ts}`;
          }

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

    // 60s delay between batches (same as GRID knowledge agents)
    if (i + 2 < DOMAIN_CONFIGS.length) {
      console.log('[ORACLE-AGENTS] Batch complete, waiting 60s...');
      await new Promise(r => setTimeout(r, 60000));
    }
  }

  const succeeded = results.filter(r => r.thesis !== null);
  const failed    = results.filter(r => r.thesis === null);
  console.log(`[ORACLE-AGENTS] ${succeeded.length} theses generated, ${failed.length} failed`);

  return results;
}

module.exports = { runDomainAgents, buildEvidenceContext };
