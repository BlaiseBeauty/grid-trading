'use strict';

const bus = require('./intelligence-bus');

/**
 * Apply ORACLE thesis context to a GRID trade proposal.
 * Modifies size_multiplier and adds conflict metadata.
 * Never blocks a trade — only adjusts sizing.
 *
 * @param {object} proposal - GRID trade proposal
 * @param {string} proposal.symbol
 * @param {string} proposal.direction - 'long' | 'short'
 * @param {string} proposal.time_horizon - 'tactical' | 'strategic' (GRID default: tactical)
 * @returns {object} modified proposal
 */
async function resolveProposal(proposal) {
  try {
    const theses = await bus.getActiveThesesForSymbol(proposal.symbol);
    if (!theses.length) return proposal; // no oracle context — pass through

    const proposalDir = proposal.direction === 'long' ? 'bull' : 'bear';

    // Split theses by whether they match or conflict with the proposal
    const confluences = theses.filter(t =>
      t.direction === proposalDir && parseFloat(t.conviction) >= 6.0
    );

    const conflicts = theses.filter(t => {
      // Only flag as conflict if: opposing direction AND same time horizon
      const opposingDir = t.direction !== proposalDir && t.direction !== 'neutral';
      const sameHorizon = t.time_horizon === 'strategic' && proposal.time_horizon === 'strategic';
      // Tactical GRID signals (4h) only conflict with structural theses (months-years) at very high conviction
      const structuralConflict = t.time_horizon === 'structural' && parseFloat(t.conviction) >= 8.5;
      return opposingDir && (sameHorizon || structuralConflict) && parseFloat(t.conviction) >= 7.0;
    });

    // Determine multiplier
    let multiplier = 1.0;
    let conflictFlag = null;
    let confluenceFlag = null;

    if (conflicts.length > 0) {
      const topConflict = conflicts.sort((a, b) =>
        parseFloat(b.conviction) - parseFloat(a.conviction)
      )[0];

      if (topConflict.time_horizon === 'structural' && parseFloat(topConflict.conviction) >= 9.0) {
        // Structural, very high conviction conflict — halve the position
        multiplier = 0.5;
        conflictFlag = {
          thesis_id:   topConflict.payload?.thesis_id,
          thesis_name: topConflict.payload?.name,
          conviction:  topConflict.conviction,
          reason:      `ORACLE structural thesis opposes this direction at conviction ${topConflict.conviction}`,
        };
      } else if (topConflict.time_horizon === 'strategic') {
        // Strategic conflict — reduce by 40%
        multiplier = 0.6;
        conflictFlag = {
          thesis_id:   topConflict.payload?.thesis_id,
          thesis_name: topConflict.payload?.name,
          conviction:  topConflict.conviction,
          reason:      `ORACLE strategic thesis opposes this direction`,
        };
      }
    }

    if (confluences.length >= 2) {
      // Multi-thesis confluence — boost by 30% (capped, doesn't override conflict)
      if (multiplier >= 1.0) {
        multiplier = 1.3;
        confluenceFlag = {
          count: confluences.length,
          theses: confluences.map(t => t.payload?.name || t.payload?.thesis_id),
        };
      }
    } else if (confluences.length === 1 && parseFloat(confluences[0].conviction) >= 8.0) {
      // Single high-conviction confluence — boost by 15%
      if (multiplier >= 1.0) {
        multiplier = 1.15;
        confluenceFlag = {
          count: 1,
          theses: [confluences[0].payload?.name],
        };
      }
    }

    // Apply to proposal
    proposal.size_multiplier    = multiplier;
    proposal.oracle_conflict    = conflictFlag;
    proposal.oracle_confluence  = confluenceFlag;
    proposal.oracle_theses_checked = theses.length;

    if (conflictFlag) {
      console.log(`[CONFLICT-RESOLVER] ${proposal.symbol} ${proposal.direction}: ` +
        `conflict with "${conflictFlag.thesis_name}" → size ×${multiplier}`);
    }
    if (confluenceFlag) {
      console.log(`[CONFLICT-RESOLVER] ${proposal.symbol} ${proposal.direction}: ` +
        `${confluenceFlag.count} confluent theses → size ×${multiplier}`);
    }

  } catch (err) {
    console.warn('[CONFLICT-RESOLVER] Failed (non-critical):', err.message);
    // Return proposal unmodified — never block on resolver failure
  }

  return proposal;
}

module.exports = { resolveProposal };
