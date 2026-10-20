const BaseAgent = require('../base-agent');
const { MODELS } = require('../../../../shared/models');

class MacroAgent extends BaseAgent {
  constructor() {
    super({ name: 'macro', layer: 'knowledge', model: MODELS.grid_knowledge, costTier: 'grid_knowledge' });
  }
}

module.exports = MacroAgent;
