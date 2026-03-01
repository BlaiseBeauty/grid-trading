/**
 * Hard-coded risk limits — code enforces, AI decides within bounds.
 * These are the absolute maximums; bootstrap mode applies stricter limits.
 */

module.exports = {
  // Position sizing
  MAX_SINGLE_POSITION_PCT: 5,       // Max 5% of portfolio in one position
  MAX_ASSET_CLASS_EXPOSURE_PCT: 40, // Max 40% in one asset class
  MAX_CORRELATED_EXPOSURE_PCT: 30,  // Max 30% in correlated positions (r > 0.7)
  MAX_OPEN_POSITIONS: 8,

  // Loss limits
  MAX_DAILY_LOSS_PCT: 3,            // Stop trading for the day
  MAX_DRAWDOWN_PCT: 10,             // Stop trading + alert
  MAX_SINGLE_TRADE_LOSS_PCT: 2,     // Hard stop on any single trade

  // Quality gates
  MIN_RISK_REWARD_RATIO: 1.5,
  MIN_CONFIDENCE_TO_TRADE: 55,      // Calibrated confidence threshold
  MIN_SIGNAL_COMPLEXITY: 3,         // Minimum signals from different domains

  // Event blackout
  EVENT_BLACKOUT_HOURS: 2,          // No new positions 2h before high-impact events

  // Bootstrap phase overrides (stricter limits for new system)
  BOOTSTRAP: {
    infant: {
      MAX_SINGLE_POSITION_PCT: 2,
      MAX_OPEN_POSITIONS: 3,
      MAX_DAILY_LOSS_PCT: 1,
      MIN_CONFIDENCE_TO_TRADE: 70,
      PAPER_ONLY: true,
    },
    learning: {
      MAX_SINGLE_POSITION_PCT: 3,
      MAX_OPEN_POSITIONS: 5,
      MAX_DAILY_LOSS_PCT: 2,
      MIN_CONFIDENCE_TO_TRADE: 65,
      PAPER_ONLY: true,
    },
    maturing: {
      MAX_SINGLE_POSITION_PCT: 4,
      MAX_OPEN_POSITIONS: 6,
      MAX_DAILY_LOSS_PCT: 2.5,
      MIN_CONFIDENCE_TO_TRADE: 60,
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
};
