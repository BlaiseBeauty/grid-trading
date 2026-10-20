const BaseAgent = require('../base-agent');
const { MODELS } = require('../../../../shared/models');

class OrderflowAgent extends BaseAgent {
  constructor() {
    super({ name: 'orderflow', layer: 'knowledge', model: MODELS.grid_knowledge, costTier: 'grid_knowledge' });
  }
}

module.exports = OrderflowAgent;
