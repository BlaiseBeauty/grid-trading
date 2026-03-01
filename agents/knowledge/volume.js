const BaseAgent = require('../base-agent');

class VolumeAgent extends BaseAgent {
  constructor() {
    super({ name: 'volume', layer: 'knowledge', model: 'claude-sonnet-4-6' });
  }
}

module.exports = VolumeAgent;
