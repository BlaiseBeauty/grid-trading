const BaseAgent = require('../base-agent');

class TrendAgent extends BaseAgent {
  constructor() {
    super({ name: 'trend', layer: 'knowledge', model: 'claude-sonnet-4-6' });
  }
}

module.exports = TrendAgent;
