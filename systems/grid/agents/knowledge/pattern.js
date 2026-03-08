const BaseAgent = require('../base-agent');

class PatternAgent extends BaseAgent {
  constructor() {
    super({ name: 'pattern', layer: 'knowledge', model: 'claude-sonnet-4-6', costTier: 'grid_knowledge' });
  }
}

module.exports = PatternAgent;
