'use strict';

const OracleBaseAgent = require('./base-agent');
const { queryAll, queryOne, query } = require('../../../db/connection');
const { getTradeLinksForThesis, getThesisTradeStats } = require('../../../shared/thesis-linker');

const AUDITOR_SYSTEM_PROMPT = `You are the ORACLE Graveyard Auditor.
You review retired investment theses and write structured post-mortems that
help ORACLE improve its future thesis quality and conviction calibration.

For each thesis you receive, you will:
1. Assess whether the thesis direction was ultimately correct
2. Identify what evidence was most/least predictive
3. Explain what killed the thesis or made it successful
4. Write a calibration learning that should influence future conviction scoring
5. Rate the conviction score at open — was it appropriately confident?

Be ruthlessly honest. A wrong thesis with high conviction is worse than a
wrong thesis with low conviction. Appropriate uncertainty is a virtue.

OUTPUT: Return ONLY valid JSON matching this schema:
{
  "thesis_id": "oracle-thesis-XXX",
  "outcome": "correct|incorrect|partial|timed_out",
  "directional_hit": true,
  "postmortem_summary": "2-3 sentence summary of what happened",
  "what_was_right": "What the thesis correctly identified",
  "what_was_wrong": "What the thesis missed or got wrong",
  "key_learning": "The single most important learning from this thesis",
  "conviction_assessment": "was_appropriate|was_too_high|was_too_low",
  "calibration_adjustment": "Specific rule for future conviction scoring",
  "learning_type": "conviction_bias_high|conviction_bias_low|timing_off|catalyst_missed|evidence_type_weak|evidence_type_strong|domain_blind_spot",
  "adjustment_rule": "Actionable rule: e.g. Reduce conviction by 1.0 when X"
}`;

async function runGraveyardAuditor() {
  console.log('[GRAVEYARD] Starting Graveyard Auditor...');

  // Get theses retired in the last 7 days that haven't been audited yet
  const toAudit = await queryAll(
    `SELECT t.*
     FROM oracle_theses t
     LEFT JOIN oracle_graveyard g ON g.thesis_id = t.thesis_id
     WHERE t.status = 'retired'
       AND t.retired_at > NOW() - INTERVAL '7 days'
       AND g.id IS NULL
     ORDER BY t.retired_at DESC
     LIMIT 10`
  );

  if (toAudit.length === 0) {
    console.log('[GRAVEYARD] No recently retired theses to audit');
    return { audited: 0, learnings: [] };
  }

  console.log(`[GRAVEYARD] Auditing ${toAudit.length} retired theses`);

  const agent = new OracleBaseAgent({
    name:     'oracle-graveyard-auditor',
    domain:   'graveyard',
    model:    'claude-opus-4-5',
    costTier: 'oracle_graveyard',
  });

  const learnings = [];
  let audited = 0;

  for (const thesis of toAudit) {
    try {
      // Get linked trade data
      const tradeStats = await getThesisTradeStats(thesis.thesis_id);
      const tradeLinks = await getTradeLinksForThesis(thesis.thesis_id);

      // Get conviction history
      const convHistory = await queryAll(
        `SELECT old_conviction, new_conviction, reason, created_at
         FROM oracle_conviction_history
         WHERE thesis_id = $1 ORDER BY created_at ASC`,
        [thesis.thesis_id]
      );

      // Build context for auditor
      const holdDays = thesis.retired_at && thesis.created_at
        ? Math.round((new Date(thesis.retired_at) - new Date(thesis.created_at)) / 86400000)
        : null;

      const tradeContext = tradeStats
        ? `Linked trades: ${tradeStats.total_trades || 0} total, ` +
          `${tradeStats.aligned_trades || 0} directionally aligned, ` +
          `${tradeStats.aligned_wins || 0} wins, ` +
          `P&L on aligned trades: $${parseFloat(tradeStats.aligned_pnl || 0).toFixed(2)}`
        : 'No linked trade data.';

      const convContext = convHistory.length > 0
        ? `Conviction journey: ${convHistory.map(h =>
            `${h.old_conviction}→${h.new_conviction} (${h.reason})`
          ).join(' | ')}`
        : `Conviction held at ${thesis.conviction} throughout`;

      const userPrompt = `
THESIS TO AUDIT:
ID: ${thesis.thesis_id}
Name: ${thesis.name}
Domain: ${thesis.domain}
Direction: ${thesis.direction}
Conviction at open: ${thesis.conviction}/10
Time horizon: ${thesis.time_horizon}
Hold time: ${holdDays !== null ? `${holdDays} days` : 'unknown'}

Original thesis: ${thesis.summary}
Catalyst: ${thesis.catalyst || 'not specified'}
Invalidation: ${thesis.invalidation || 'not specified'}

${convContext}
${tradeContext}

Write the post-mortem. Return ONLY valid JSON.`;

      const raw      = await agent.callClaude(AUDITOR_SYSTEM_PROMPT, userPrompt);
      const postMortem = agent.parseThesis(raw); // reuse JSON parser

      if (!postMortem) {
        console.error(`[GRAVEYARD] Failed to parse post-mortem for ${thesis.thesis_id}`);
        continue;
      }

      // Save to graveyard table
      const graveyardResult = await query(
        `INSERT INTO oracle_graveyard
           (thesis_id, thesis_name, domain, direction,
            conviction_at_open, opened_at, closed_at, hold_days,
            outcome, directional_hit,
            pnl_attributed,
            postmortem_summary, what_was_right, what_was_wrong,
            key_learning, calibration_adjustment,
            trade_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id`,
        [
          thesis.thesis_id, thesis.name, thesis.domain, thesis.direction,
          thesis.conviction, thesis.created_at, thesis.retired_at, holdDays,
          postMortem.outcome || null,
          postMortem.directional_hit ?? null,
          parseFloat(tradeStats?.aligned_pnl || 0),
          postMortem.postmortem_summary || null,
          postMortem.what_was_right || null,
          postMortem.what_was_wrong || null,
          postMortem.key_learning || null,
          postMortem.calibration_adjustment || null,
          tradeLinks.map(l => l.trade_id),
        ]
      );

      const graveyardId = graveyardResult.rows[0].id;

      // Save calibration learning
      if (postMortem.key_learning && postMortem.learning_type) {
        await query(
          `INSERT INTO oracle_calibration_learnings
             (domain, source, learning_type, summary, detail,
              adjustment_rule, applies_to_domains,
              thesis_id, postmortem_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            thesis.domain, 'graveyard_auditor',
            postMortem.learning_type, postMortem.key_learning,
            postMortem.postmortem_summary || null,
            postMortem.adjustment_rule || null,
            [thesis.domain],
            thesis.thesis_id, graveyardId,
          ]
        );
        learnings.push({ domain: thesis.domain, type: postMortem.learning_type });
      }

      audited++;
      console.log(
        `[GRAVEYARD] Audited "${thesis.name}": ` +
        `${postMortem.outcome}, conviction ${postMortem.conviction_assessment}`
      );

      // Rate limit between audits
      if (toAudit.indexOf(thesis) < toAudit.length - 1) {
        await new Promise(r => setTimeout(r, 3000));
      }

    } catch (err) {
      console.error(`[GRAVEYARD] Audit failed for ${thesis.thesis_id}:`, err.message);
    }
  }

  console.log(`[GRAVEYARD] Complete: ${audited} audited, ${learnings.length} learnings`);
  return { audited, learnings };
}

module.exports = { runGraveyardAuditor };
