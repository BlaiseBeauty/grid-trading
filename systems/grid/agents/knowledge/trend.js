const BaseAgent = require('../base-agent');
const { MODELS } = require('../../../../shared/models');

class TrendAgent extends BaseAgent {
  constructor() {
    super({ name: 'trend', layer: 'knowledge', model: MODELS.grid_knowledge, costTier: 'grid_knowledge' });
  }
}

module.exports = TrendAgent;
