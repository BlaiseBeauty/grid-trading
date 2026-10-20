/**
 * Hard-coded risk limits — code enforces, AI decides within bounds.
 * These are the absolute maximums; bootstrap mode applies stricter limits.
 */

const LIVE_LIMITS = {
  // Position sizing
  MAX_SINGLE_POSITION_PCT: 5,       // Max 5% of portfolio in one position
  MIN_POSITION_PCT: 1,              // Min 1% of portfolio per position
  MAX_ASSET_CLASS_EXPOSURE_PCT: 40, // Max 40% in one asset class
  MAX_CORRELATED_EXPOSURE_PCT: 30,  // Max 30% in correlated positions (r > 0.7)
  MAX_OPEN_POSITIONS: 8,

  // Loss limits
  MAX_DAILY_LOSS_PCT: 3,            // Stop trading for the day
  MAX_DRAWDOWN_PCT: 10,             // Stop trading + alert
  MAX_SINGLE_TRADE_LOSS_PCT: 2,     // Hard stop on any single trade

  // Quality gates
  MIN_RISK_REWARD_RATIO: 1.5,
  MIN_CONFIDENCE_TO_TRADE: 70,      // Calibrated confidence threshold
  MIN_SIGNAL_COMPLEXITY: 2,         // Minimum signals from different domains

  // Event blackout
  EVENT_BLACKOUT_HOURS: 2,          // No new positions 2h before high-impact events
};

// Paper trading overrides — more aggressive limits for testing
const PAPER_OVERRIDES = {
  MIN_POSITION_PCT: 3,              // 3% minimum (take meaningful positions)
  MAX_SINGLE_POSITION_PCT: 8,       // 8% maximum per position
  MAX_OPEN_POSITIONS: 8,
  MIN_CONFIDENCE_TO_TRADE: 70,      // 70% confidence threshold
  MAX_SINGLE_TRADE_LOSS_PCT: 5,     // 5% risk per trade
};

/**
 * Returns risk limits based on trading mode.
 * Paper mode (LIVE_TRADING_ENABLED !== 'true') uses more aggressive limits.
 */
function getRiskLimits() {
  const isLive = process.env.LIVE_TRADING_ENABLED === 'true';
  if (isLive) return { ...LIVE_LIMITS };
  return { ...LIVE_LIMITS, ...PAPER_OVERRIDES };
}

module.exports = {
  ...LIVE_LIMITS,

  // Bootstrap phase overrides (stricter limits for new system)
  BOOTSTRAP: {
    infant: {
      MAX_SINGLE_POSITION_PCT: 2,
      MAX_OPEN_POSITIONS: 3,
      MAX_DAILY_LOSS_PCT: 3,
      MIN_CONFIDENCE_TO_TRADE: 70,
      PAPER_ONLY: true,
    },
    learning: {
      MAX_SINGLE_POSITION_PCT: 3,
      MAX_OPEN_POSITIONS: 5,
      MAX_DAILY_LOSS_PCT: 2,
      MIN_CONFIDENCE_TO_TRADE: 70,
      PAPER_ONLY: true,
    },
    maturing: {
      MAX_SINGLE_POSITION_PCT: 4,
      MAX_OPEN_POSITIONS: 6,
      MAX_DAILY_LOSS_PCT: 2.5,
      MIN_CONFIDENCE_TO_TRADE: 70,
      PAPER_ONLY: false,
    },
    graduated: null, // Use standard limits
  },

  // SCRAM overrides
  SCRAM: {
    elevated: {
      MAX_SINGLE_POSITION_PCT: 3,
      MAX_OPEN_POSITIONS: 5,
      NO_NEW_POSITIONS: false,
    },
    crisis: {
      MAX_SINGLE_POSITION_PCT: 0,
      MAX_OPEN_POSITIONS: 0,
      NO_NEW_POSITIONS: true,
      CLOSE_LOSING_POSITIONS: true,
    },
    emergency: {
      MAX_SINGLE_POSITION_PCT: 0,
      MAX_OPEN_POSITIONS: 0,
      NO_NEW_POSITIONS: true,
      CLOSE_ALL_POSITIONS: true,
    },
  },

  getRiskLimits,
};

// ---------------------------------------------------------------------------
// SCRAM helpers (pure)
// ---------------------------------------------------------------------------

const SCRAM_RANK = { elevated: 1, crisis: 2, emergency: 3 };

/** A SCRAM raised by hand (POST /system/scram/activate) — never auto-cleared. */
function isManualScram(row) {
  return !!row && (row.is_manual === true || row.trigger_name === 'manual');
}

/**
 * Which close action (if any) a SCRAM row requests: 'all' | 'losing' | null.
 *  - An explicit row.close_mode always wins.
 *  - Manual SCRAMs default to "block new entries only" (no closing) unless close_mode is set.
 *  - Automatic SCRAMs follow the level config (CLOSE_ALL_POSITIONS / CLOSE_LOSING_POSITIONS).
 */
function scramCloseMode(row) {
  if (!row) return null;
  if (row.close_mode === 'all' || row.close_mode === 'losing') return row.close_mode;
  if (isManualScram(row)) return null;
  const cfg = module.exports.SCRAM[row.level];
  if (cfg?.CLOSE_ALL_POSITIONS) return 'all';
  if (cfg?.CLOSE_LOSING_POSITIONS) return 'losing';
  return null;
}

module.exports.SCRAM_RANK = SCRAM_RANK;
module.exports.isManualScram = isManualScram;
module.exports.scramCloseMode = scramCloseMode;
