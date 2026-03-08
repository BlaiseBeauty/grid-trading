'use strict';

const https = require('https');
const http  = require('http');
const { query } = require('../../../db/connection');
const crypto = require('crypto');

const RSS_FEEDS = [
  // Finance & macro
  { name: 'Reuters Business',  url: 'https://feeds.reuters.com/reuters/businessNews',       tags: ['macro', 'equity', 'geopolitical'] },
  { name: 'BBC Business',      url: 'https://feeds.bbci.co.uk/news/business/rss.xml',       tags: ['macro', 'geopolitical'] },
  { name: 'FT Markets',        url: 'https://www.ft.com/rss/home/uk',                       tags: ['macro', 'equity', 'rates'] },
  // Commodities
  { name: 'Reuters Commodities',url: 'https://feeds.reuters.com/reuters/companyNews',       tags: ['commodity', 'energy'] },
  // Technology
  { name: 'TechCrunch',        url: 'https://techcrunch.com/feed/',                         tags: ['technology', 'ai'] },
  { name: 'Ars Technica',      url: 'https://feeds.arstechnica.com/arstechnica/index',      tags: ['technology', 'ai'] },
  // Crypto
  { name: 'CoinDesk',          url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',      tags: ['crypto'] },
  { name: 'The Block',         url: 'https://www.theblock.co/rss.xml',                     tags: ['crypto', 'defi'] },
];

// Keywords that lift relevance score
const HIGH_RELEVANCE_KEYWORDS = [
  'federal reserve', 'fed rate', 'inflation', 'gdp', 'recession', 'yield curve',
  'ai artificial intelligence', 'nvidia', 'openai', 'automation', 'chatgpt',
  'cocoa', 'wheat', 'corn', 'natural gas', 'oil', 'copper', 'gold', 'silver',
  'ukraine', 'russia', 'china', 'nato', 'sanctions', 'tariff', 'war',
  'bitcoin', 'ethereum', 'crypto', 'blockchain', 'sec', 'regulation',
  'earnings', 'guidance', 'layoffs', 'acquisition', 'ipo', 'bankruptcy',
];

function scoreRelevance(headline, content) {
  const text = `${headline} ${content}`.toLowerCase();
  let score = 5.0; // baseline
  for (const kw of HIGH_RELEVANCE_KEYWORDS) {
    if (text.includes(kw)) score = Math.min(10, score + 0.5);
  }
  return parseFloat(score.toFixed(1));
}

function detectSentiment(text) {
  const t = text.toLowerCase();
  const bullish = ['surge', 'rally', 'gain', 'rise', 'growth', 'strong',
                   'record high', 'beat expectations', 'upgrade', 'buy'].filter(w => t.includes(w));
  const bearish = ['fall', 'drop', 'decline', 'crash', 'recession', 'weak',
                   'miss', 'downgrade', 'sell', 'concern', 'risk', 'threat'].filter(w => t.includes(w));
  if (bullish.length > bearish.length) return 'bullish';
  if (bearish.length > bullish.length) return 'bearish';
  return 'neutral';
}

function fetchRSS(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'GRID-ORACLE/1.0' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRSS(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('RSS fetch timeout')); });
  });
}

function parseRSSItems(xmlText) {
  const items = [];
  // Simple regex-based XML parsing (no dependencies)
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null) {
    const item = match[1];
    const title   = (item.match(/<title[^>]*><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                     item.match(/<title[^>]*>(.*?)<\/title>/) || [])[1] || '';
    const link    = (item.match(/<link>(.*?)<\/link>/) || [])[1] || '';
    const pubDate = (item.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
    const desc    = (item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                     item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '';

    if (title.trim()) {
      items.push({
        title:   title.replace(/<[^>]+>/g, '').trim(),
        link:    link.trim(),
        pubDate: pubDate.trim(),
        description: desc.replace(/<[^>]+>/g, '').slice(0, 500).trim(),
      });
    }
  }
  return items.slice(0, 20); // max 20 items per feed
}

async function ingestRSS() {
  console.log('[RSS] Starting news feed ingestion...');
  let totalIngested = 0;
  let totalDupes = 0;

  for (const feed of RSS_FEEDS) {
    try {
      await new Promise(r => setTimeout(r, 500)); // 500ms between feeds
      const xml   = await fetchRSS(feed.url);
      const items = parseRSSItems(xml);

      for (const item of items) {
        const contentHash = crypto
          .createHash('sha256')
          .update(`${feed.name}_${item.title}`)
          .digest('hex');

        const relevance = scoreRelevance(item.title, item.description);
        const sentiment = detectSentiment(`${item.title} ${item.description}`);
        let publishedAt = null;
        try { publishedAt = item.pubDate ? new Date(item.pubDate) : null; } catch {}

        try {
          const result = await query(
            `INSERT INTO oracle_raw_feed
               (source_type, source_name, raw_content, headline,
                published_at, content_hash)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (content_hash) DO NOTHING
             RETURNING id`,
            [
              'rss_news', feed.name,
              JSON.stringify({ url: item.link, description: item.description, tags: feed.tags }),
              item.title, publishedAt, contentHash,
            ]
          );

          if (result.rowCount > 0) {
            // Also insert into oracle_evidence for immediately useful items
            if (relevance >= 7.0) {
              await query(
                `INSERT INTO oracle_evidence
                   (source_type, source_name, source_url, headline, content,
                    published_at, domain_tags, content_hash, relevance_score, sentiment)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 ON CONFLICT (content_hash) DO NOTHING`,
                [
                  'rss_news', feed.name, item.link, item.title,
                  item.description, publishedAt, feed.tags,
                  contentHash, relevance, sentiment,
                ]
              );
            }
            totalIngested++;
          } else {
            totalDupes++;
          }
        } catch (err) {
          // Skip individual item failures — don't abort the feed
        }
      }

      console.log(`[RSS] ${feed.name}: ${items.length} items processed`);
    } catch (err) {
      console.error(`[RSS] ${feed.name} failed:`, err.message);
    }
  }

  console.log(`[RSS] Complete: ${totalIngested} new, ${totalDupes} duplicates`);
  return { ingested: totalIngested, duplicates: totalDupes };
}

module.exports = { ingestRSS, RSS_FEEDS };
