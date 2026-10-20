const BaseAgent = require('../base-agent');
const { MODELS } = require('../../../../shared/models');

class PatternAgent extends BaseAgent {
  constructor() {
    super({ name: 'pattern', layer: 'knowledge', model: MODELS.grid_knowledge, costTier: 'grid_knowledge' });
  }
}

module.exports = PatternAgent;
