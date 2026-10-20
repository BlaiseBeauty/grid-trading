'use strict';

const { query } = require('../../../db/connection');
const crypto = require('crypto');
const { fetchText, recordSource } = require('./http-fetch');
const { sanitizeExternal } = require('../agents/validation');

const HEADLINE_MAX = 300;
const DESCRIPTION_MAX = 800;

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

// https-only, 10s timeout, 3 redirects max, 2MB max body (see ./http-fetch.js)
function fetchRSS(url) {
  return fetchText(url);
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
      // External text: strip tags/control chars and cap lengths at ingestion time (prompt-injection hygiene)
      const cleanTitle = sanitizeExternal(title, HEADLINE_MAX);
      if (!cleanTitle) continue;
      items.push({
        title:   cleanTitle,
        link:    /^https?:\/\//i.test(link.trim()) ? link.trim().slice(0, 500) : '',
        pubDate: pubDate.trim().slice(0, 60),
        description: sanitizeExternal(desc, DESCRIPTION_MAX),
      });
    }
  }
  return items.slice(0, 20); // max 20 items per feed
}

async function ingestRSS() {
  console.log('[RSS] Starting news feed ingestion...');
  let totalIngested = 0;
  let totalDupes = 0;
  let itemErrors = 0;
  let feedsFailed = 0;

  for (const feed of RSS_FEEDS) {
    try {
      await new Promise(r => setTimeout(r, 500)); // 500ms between feeds
      const xml   = await fetchRSS(feed.url);
      const items = parseRSSItems(xml);
      recordSource(`rss:${feed.name}`, true);

      for (const item of items) {
        const contentHash = crypto
          .createHash('sha256')
          .update(`${feed.name}_${item.title}`)
          .digest('hex');

        const relevance = scoreRelevance(item.title, item.description);
        const sentiment = detectSentiment(`${item.title} ${item.description}`);
        let publishedAt = null;
        publishedAt = item.pubDate ? new Date(item.pubDate) : null;
        if (publishedAt && Number.isNaN(publishedAt.getTime())) publishedAt = null; // invalid date -> null, not a crash

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
          // Skip individual item failures — don't abort the feed, but count and log them
          itemErrors++;
          console.warn(`[RSS] ${feed.name}: item insert failed: ${err.message}`);
        }
      }

      console.log(`[RSS] ${feed.name}: ${items.length} items processed`);
    } catch (err) {
      feedsFailed++;
      recordSource(`rss:${feed.name}`, false, err);
    }
  }

  console.log(`[RSS] Complete: ${totalIngested} new, ${totalDupes} duplicates, ${feedsFailed}/${RSS_FEEDS.length} feeds failed, ${itemErrors} item errors`);
  return { ingested: totalIngested, duplicates: totalDupes, feeds_failed: feedsFailed, feeds_total: RSS_FEEDS.length, item_errors: itemErrors };
}

module.exports = { ingestRSS, RSS_FEEDS };
