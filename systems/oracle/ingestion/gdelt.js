'use strict';

const https = require('https');
const { query } = require('../../../db/connection');
const crypto = require('crypto');

// GDELT V2 API — free, no key required
// Event codes we care about for trading context
const GDELT_EVENT_CATEGORIES = {
  '14': 'protest_unrest',    // Protest, strikes, riots
  '15': 'economic_action',   // Trade agreements, sanctions
  '16': 'conflict_violence', // Military, armed conflict
  '17': 'coerce',            // Sanctions, threats
  '18': 'assault',           // Violent conflict
  '19': 'fight',             // Armed conflict
  '20': 'use_conventional_military', // Military deployment
};

const DOMAIN_TAGS_BY_CATEGORY = {
  '14': ['geopolitical', 'macro'],
  '15': ['geopolitical', 'macro', 'commodity'],
  '16': ['geopolitical', 'macro'],
  '17': ['geopolitical', 'macro'],
  '18': ['geopolitical'],
  '19': ['geopolitical'],
  '20': ['geopolitical', 'macro'],
};

// High-importance countries for trading context
const IMPORTANT_ACTORS = [
  'USA', 'CHN', 'RUS', 'UKR', 'DEU', 'GBR', 'JPN', 'SAU',
  'OPEC', 'NATO', 'EU', 'IMF', 'FED', 'ECB', 'BIS',
];

async function fetchGDELTLastHour() {
  return new Promise((resolve, reject) => {
    // GDELT GKG (Global Knowledge Graph) last update
    const url = 'https://api.gdeltproject.org/api/v2/doc/doc?' +
      'query=sourcelang:english%20(conflict%20OR%20sanctions%20OR%20trade%20OR%20economy)' +
      '&mode=artlist&maxrecords=25&format=json&timespan=1h';

    https.get(url, { headers: { 'User-Agent': 'GRID-ORACLE/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.articles || []);
        } catch {
          resolve([]); // GDELT can return malformed JSON — treat as empty
        }
      });
    }).on('error', () => resolve([])); // Never fail on GDELT issues
  });
}

async function ingestGDELT() {
  console.log('[GDELT] Fetching global events...');
  let ingested = 0;

  try {
    const articles = await fetchGDELTLastHour();

    for (const article of articles) {
      const headline = article.title || '';
      const url      = article.url || '';
      const domain   = article.domain || '';

      if (!headline) continue;

      const contentHash = crypto
        .createHash('sha256')
        .update(`gdelt_${url || headline}`)
        .digest('hex');

      try {
        const result = await query(
          `INSERT INTO oracle_raw_feed
             (source_type, source_name, raw_content, headline, published_at, content_hash)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (content_hash) DO NOTHING
           RETURNING id`,
          [
            'gdelt_event', `GDELT/${domain}`,
            JSON.stringify(article),
            headline.slice(0, 500),
            article.seendate ? new Date(article.seendate.replace(
              /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
              '$1-$2-$3T$4:$5:$6Z'
            )) : new Date(),
            contentHash,
          ]
        );

        if (result.rowCount > 0) ingested++;
      } catch { /* skip individual failures */ }
    }
  } catch (err) {
    console.error('[GDELT] Fetch failed (non-critical):', err.message);
  }

  console.log(`[GDELT] ${ingested} new geopolitical events ingested`);
  return { ingested };
}

module.exports = { ingestGDELT };
