const BaseAgent = require('../base-agent');

class SentimentAgent extends BaseAgent {
  constructor() {
    super({ name: 'sentiment', layer: 'knowledge', model: 'claude-sonnet-4-6', costTier: 'grid_knowledge' });
  }
}

module.exports = SentimentAgent;
