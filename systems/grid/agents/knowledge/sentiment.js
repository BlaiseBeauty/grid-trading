const BaseAgent = require('../base-agent');
const { MODELS } = require('../../../../shared/models');

class SentimentAgent extends BaseAgent {
  constructor() {
    super({ name: 'sentiment', layer: 'knowledge', model: MODELS.grid_knowledge, costTier: 'grid_knowledge' });
  }
}

module.exports = SentimentAgent;
