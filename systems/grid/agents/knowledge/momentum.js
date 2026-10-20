const BaseAgent = require('../base-agent');
const { MODELS } = require('../../../../shared/models');

class MomentumAgent extends BaseAgent {
  constructor() {
    super({ name: 'momentum', layer: 'knowledge', model: MODELS.grid_knowledge, costTier: 'grid_knowledge' });
  }
}

module.exports = MomentumAgent;
