const BaseAgent = require('../base-agent');

class MacroAgent extends BaseAgent {
  constructor() {
    super({ name: 'macro', layer: 'knowledge', model: 'claude-sonnet-4-6', costTier: 'grid_knowledge' });
  }
}

module.exports = MacroAgent;
