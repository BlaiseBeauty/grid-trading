const BaseAgent = require('../base-agent');
const { MODELS } = require('../../../../shared/models');

class VolatilityAgent extends BaseAgent {
  constructor() {
    super({ name: 'volatility', layer: 'knowledge', model: MODELS.grid_knowledge, costTier: 'grid_knowledge' });
  }
}

module.exports = VolatilityAgent;
