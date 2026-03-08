'use strict';

const OracleBaseAgent   = require('./base-agent');
const { getActiveTheses } = require('../db/theses');
const { query, queryOne } = require('../../../db/connection');
const bus               = require('../../../shared/intelligence-bus');

const SYNTHESIS_SYSTEM_PROMPT = `You are the ORACLE Synthesis Agent.
You receive all active investment theses from 6 domain specialists and your job is to:

1. FIND CONFLUENCES: identify assets where 2+ theses point in the same direction
2. FIND CONFLICTS: identify theses that directly contradict each other on same time horizon
3. BUILD OPPORTUNITY MAP: rank assets by (conviction × dislocation opportunity)
4. FLAG CASCADE CHAINS: where thesis A causes thesis B (e.g. AI energy demand → grid infra)

OUTPUT: Return ONLY a valid JSON object with this exact schema:
{
  "confluences": [
    {
      "assets": ["TICKER1"],
      "direction": "bull|bear",
      "thesis_ids": ["oracle-thesis-001", "oracle-thesis-002"],
      "combined_conviction": 8.5,
      "narrative": "One sentence explaining why these theses agree"
    }
  ],
  "conflicts": [
    {
      "thesis_id_a": "...",
      "thesis_id_b": "...",
      "conflict_description": "Why these theses contradict",
      "resolution_suggestion": "How to think about the conflict"
    }
  ],
  "opportunity_map": [
    {
      "rank": 1,
      "asset": "TICKER",
      "sector": "Sector name",
      "direction": "bull|bear",
      "dislocation_score": 75,
      "confirming_thesis_count": 3,
      "thesis_ids": ["..."],
      "action": "LONG|SHORT|WATCH",
      "one_line": "Why this is the top opportunity right now"
    }
  ],
  "cascade_chains": [
    {
      "chain": ["oracle-thesis-001", "oracle-thesis-003"],
      "description": "How first thesis causes second"
    }
  ],
  "macro_regime_summary": {
    "overall": "risk-on|risk-off|mixed",
    "dominant_narrative": "One sentence macro backdrop",
    "tail_risk": "The biggest thing that could go wrong"
  }
}`;

async function runSynthesis() {
  console.log('[ORACLE-SYNTHESIS] Running cross-thesis synthesis...');

  const activeTheses = await getActiveTheses();
  if (activeTheses.length < 2) {
    console.log('[ORACLE-SYNTHESIS] Not enough theses to synthesise — need 2+');
    return null;
  }

  const agent = new OracleBaseAgent({
    name:     'oracle-synthesis',
    domain:   'synthesis',
    model:    'claude-opus-4-5',
    costTier: 'oracle_synthesis',
  });

  const thesisContext = activeTheses.map(t => `
THESIS: ${t.thesis_id}
Name: ${t.name}
Domain: ${t.domain}
Direction: ${t.direction} | Conviction: ${t.conviction}/10 | Horizon: ${t.time_horizon}
Long: ${(t.long_assets || []).join(', ') || 'none'}
Short: ${(t.short_assets || []).join(', ') || 'none'}
Summary: ${t.summary}
Catalyst: ${t.catalyst || 'not specified'}
`).join('\n---\n');

  const userPrompt = `
ACTIVE THESES (${activeTheses.length} total):
${thesisContext}

Analyse these theses for confluences, conflicts, cascade chains, and build
the opportunity map. Return ONLY valid JSON matching the schema.`;

  try {
    const rawText = await agent.callClaude(SYNTHESIS_SYSTEM_PROMPT, userPrompt);

    // Parse synthesis output
    const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const start = clean.indexOf('{');
    const end   = clean.lastIndexOf('}');
    if (start === -1) throw new Error('No JSON in synthesis output');

    const synthesis = JSON.parse(clean.slice(start, end + 1));

    // Save opportunity map to DB
    if (synthesis.opportunity_map?.length > 0) {
      await query(
        `INSERT INTO oracle_opportunity_map (opportunities, thesis_count)
         VALUES ($1, $2) RETURNING id`,
        [JSON.stringify(synthesis.opportunity_map), activeTheses.length]
      );

      // Publish to bus
      await bus.publish({
        source_system: 'oracle',
        event_type:    'opportunity_map_update',
        payload:       synthesis,
        expires_at:    new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      });

      console.log(
        `[ORACLE-SYNTHESIS] Opportunity map saved: ` +
        `${synthesis.opportunity_map.length} opportunities, ` +
        `${(synthesis.confluences || []).length} confluences`
      );
    }

    // Publish macro regime update
    if (synthesis.macro_regime_summary) {
      await bus.publish({
        source_system: 'oracle',
        event_type:    'macro_regime_update',
        payload:       synthesis.macro_regime_summary,
        expires_at:    new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      });
    }

    return synthesis;

  } catch (err) {
    console.error('[ORACLE-SYNTHESIS] Failed:', err.message);
    return null;
  }
}

module.exports = { runSynthesis };
