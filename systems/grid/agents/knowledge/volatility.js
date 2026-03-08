const BaseAgent = require('../base-agent');

class VolatilityAgent extends BaseAgent {
  constructor() {
    super({ name: 'volatility', layer: 'knowledge', model: 'claude-sonnet-4-6', costTier: 'grid_knowledge' });
  }
}

module.exports = VolatilityAgent;
