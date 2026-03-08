const BaseAgent = require('../base-agent');

class MomentumAgent extends BaseAgent {
  constructor() {
    super({ name: 'momentum', layer: 'knowledge', model: 'claude-sonnet-4-6', costTier: 'grid_knowledge' });
  }
}

module.exports = MomentumAgent;
