const BaseAgent = require('../base-agent');
const { MODELS } = require('../../../../shared/models');

class VolumeAgent extends BaseAgent {
  constructor() {
    super({ name: 'volume', layer: 'knowledge', model: MODELS.grid_knowledge, costTier: 'grid_knowledge' });
  }
}

module.exports = VolumeAgent;
