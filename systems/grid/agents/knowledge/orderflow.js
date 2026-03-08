const BaseAgent = require('../base-agent');

class OrderflowAgent extends BaseAgent {
  constructor() {
    super({ name: 'orderflow', layer: 'knowledge', model: 'claude-sonnet-4-6', costTier: 'grid_knowledge' });
  }
}

module.exports = OrderflowAgent;
