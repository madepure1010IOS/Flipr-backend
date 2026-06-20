const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const app = express();

app.set('trust proxy', 1);

// Rate limiters
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { error: "Search rate limit exceeded, please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(cors());
app.use(express.json());
app.use(generalLimiter);

// eBay OAuth token cache
let ebayToken = null;
let ebayTokenExpiry = null;

const EBAY_CLIENT_ID = 'JakeHalv-Flipr-PRD-5dcdac77d-aa21a80f';
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

// ─── Supabase helpers ────────────────────────────────────────────────────────

async function supabaseQuery(path, method = 'GET', body = null, extraHeaders = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_SECRET_KEY,
      'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(method === 'POST' || method === 'PATCH' ? { 'Prefer': 'return=minimal' } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error (${res.status}): ${err}`);
  }
  if (method === 'GET') return res.json();
  return null;
}

// Upsert into daily_snapshots using Postgres ON CONFLICT via Prefer header
async function upsertDailySnapshots(rows) {
  await supabaseQuery('/daily_snapshots?on_conflict=name,snapshot_date', 'POST', rows, {
    'Prefer': 'resolution=merge-duplicates,return=minimal',
  });
}

// ─── eBay auth ───────────────────────────────────────────────────────────────

async function getEbayToken() {
  if (ebayToken && ebayTokenExpiry && Date.now() < ebayTokenExpiry) {
    return ebayToken;
  }
  if (!EBAY_CLIENT_SECRET) {
    console.log('No eBay secret, using mock data');
    return null;
  }
  try {
    const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
    const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
    });
    const data = await response.json();
    if (data.access_token) {
      ebayToken = data.access_token;
      ebayTokenExpiry = Date.now() + (data.expires_in * 1000) - 60000;
      return ebayToken;
    }
  } catch (err) {
    console.error('eBay token error:', err);
  }
  return null;
}

// ─── eBay keyword search (used by /pricehistory fallback, /trending, /item) ──

async function searchEbay(query) {
  const token = await getEbayToken();
  if (!token) return null;
  try {
    const encoded = encodeURIComponent(query);
    const response = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encoded}&limit=20&filter=buyingOptions:{FIXED_PRICE}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      }
    );
    const data = await response.json();
    if (!data.itemSummaries || data.itemSummaries.length === 0) return null;
    const prices = data.itemSummaries
      .filter(item => item.price)
      .map(item => parseFloat(item.price.value));
    if (prices.length === 0) return null;
    const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const imageItem = data.itemSummaries.find(item => item.image?.imageUrl);
    return {
      avgPrice,
      minPrice: Math.round(Math.min(...prices)),
      maxPrice: Math.round(Math.max(...prices)),
      // eBay's total count of matching ACTIVE listings -- not sold items.
      // The free Browse API only sees what's currently for sale.
      totalListings: data.total || prices.length,
      image: imageItem?.image?.imageUrl || null,
    };
  } catch (err) {
    console.error('eBay search error:', err);
    return null;
  }
}

// ─── eBay category sweep (used by discovery scanner) ─────────────────────────
// Pulls real live listings from a whole category, sorted by newly listed,
// so we discover actual item clusters instead of guessing product names.

async function sweepEbayCategory(categoryId, keyword, limit = 100) {
  const token = await getEbayToken();
  if (!token) {
    console.log(`[sweep] No eBay token available for category ${categoryId}`);
    return [];
  }
  try {
    const encodedKeyword = encodeURIComponent(keyword);
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodedKeyword}&category_ids=${categoryId}&limit=${limit}&sort=newlyListed&filter=buyingOptions:{FIXED_PRICE}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });
    const data = await response.json();
    if (!response.ok) {
      console.log(`[sweep] eBay error for category ${categoryId} (status ${response.status}):`, JSON.stringify(data).slice(0, 500));
      return [];
    }
    if (!data.itemSummaries) {
      console.log(`[sweep] No itemSummaries for category ${categoryId}. Response keys:`, Object.keys(data));
      return [];
    }
    console.log(`[sweep] Category ${categoryId} (${keyword}): ${data.itemSummaries.length} items returned`);
    return data.itemSummaries
      .filter(item => item.price && item.title)
      .map(item => ({
        title: item.title,
        price: parseFloat(item.price.value),
        image: item.image?.imageUrl || null,
        condition: item.condition || null,
      }));
  } catch (err) {
    console.error(`[sweep] Exception for category ${categoryId}:`, err.message);
    return [];
  }
}

// Normalize a listing title down to a comparable "product key" so similar
// listings cluster together (strips sizes, colors, condition words, etc.)
const NOISE_WORDS = new Set([
  'new', 'used', 'nwt', 'nib', 'mint', 'sealed', 'authentic', 'genuine',
  'size', 'sz', 'us', 'mens', 'womens', 'unisex', 'fast', 'shipping',
  'free', 'rare', 'vintage', 'lot', 'bundle', 'set', 'with', 'box',
  'tags', 'brand', 'in', 'hand', 'fits', 'fit', 'wide', 'narrow',
  'and', 'the', 'for', 'a', 'an', 'of', 'to', 'pair', 'pairs',
  'condition', 'great', 'good', 'excellent', 'never', 'worn', 'deadstock',
  'ds', 'og', 'pair', 'edition', 'color', 'colorway',
]);

// Common color words also get stripped -- they vary listing to listing
// for the "same" cluster intent.
const COLOR_WORDS = new Set([
  'black', 'white', 'red', 'blue', 'green', 'yellow', 'grey', 'gray',
  'pink', 'purple', 'orange', 'brown', 'tan', 'beige', 'navy', 'gold',
  'silver', 'multicolor', 'multi',
]);

function clusterKey(title) {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w =>
      w.length > 1 &&
      !NOISE_WORDS.has(w) &&
      !COLOR_WORDS.has(w) &&
      isNaN(Number(w))
    );

  return words.slice(0, 4).sort().join(' ').trim();
}

function clusterListings(listings) {
  const clusters = {};
  for (const item of listings) {
    const key = clusterKey(item.title);
    if (!key || key.length < 4) continue;
    if (!clusters[key]) clusters[key] = { items: [], displayName: item.title };
    clusters[key].items.push(item);
  }
  return clusters;
}

// A handful of condition strings signal the listing is basically junk
// (broken, parts-only, etc). Those get excluded from price-bound math --
// a $20 "for parts" listing isn't a real flip opportunity, it's noise
// that would fake a wide spread.
function isGoodCondition(conditionStr) {
  if (!conditionStr) return true;
  const c = conditionStr.toLowerCase();
  const poorSignals = ['for parts', 'not working', 'damaged', 'as-is', 'as is', 'salvage'];
  return !poorSignals.some(signal => c.includes(signal));
}

// ─── Discovery scanner ─────────────────────────────────────────────────────────
// eBay-only -- no RapidAPI, no paid sold-history data. Sweeps real eBay
// categories, clusters similar active listings into product groups, and
// scores each cluster off two free signals:
//   1. volume -- how many active listings exist for the same product
//      (market depth / proven demand)
//   2. spread -- how far apart the cheapest and priciest listing of that
//      same product are, relative to the average (the flip itself: some
//      seller is pricing well under what the item is actually going for
//      elsewhere on the same results page)

const CATEGORY_SWEEPS = [
  { id: '15709', name: 'Sneakers', keyword: 'shoes' },
  { id: '2536', name: 'Cards', keyword: 'trading cards' },
  { id: '1249', name: 'Video Games', keyword: 'video games' },
  { id: '1', name: 'Collectibles', keyword: 'collectible' },
  { id: '220', name: 'Toys & Hobbies', keyword: 'toy' },
  { id: '281', name: 'Watches', keyword: 'watch' },
  { id: '11450', name: 'Streetwear', keyword: 'streetwear' },
  { id: '293', name: 'Electronics', keyword: 'electronics' },
  { id: '267', name: 'Books', keyword: 'book' },
  { id: '619', name: 'Musical Instruments', keyword: 'guitar' },
  { id: '11700', name: 'Home & Garden', keyword: 'home decor' },
  { id: '888', name: 'Sporting Goods', keyword: 'sports equipment' },
  { id: '64482', name: 'Sports Cards', keyword: 'sports memorabilia' },
  { id: '870', name: 'Pottery & Glass', keyword: 'vintage glass' },
  { id: '237', name: 'Dolls & Bears', keyword: 'collectible doll' },
  { id: '11116', name: 'Coins', keyword: 'coin' },
  { id: '260', name: 'Stamps', keyword: 'stamp' },
  { id: '14339', name: 'Crafts', keyword: 'craft supplies' },
  { id: '26395', name: 'Health & Beauty', keyword: 'skincare' },
  { id: '1281', name: 'Pet Supplies', keyword: 'pet gear' },
  { id: '625', name: 'Cameras', keyword: 'camera' },
  { id: '15032', name: 'Cell Phones', keyword: 'smartphone' },
  { id: '45100', name: 'Entertainment Memorabilia', keyword: 'movie memorabilia' },
  { id: '12576', name: 'Business & Industrial', keyword: 'tools' },
  { id: '11233', name: 'Music', keyword: 'vinyl record' },
  { id: '11232', name: 'Movies & TV', keyword: 'dvd' },
  { id: '11116', name: 'Paper Money', keyword: 'currency note' },
  { id: '550', name: 'Art', keyword: 'art print' },
  { id: '20081', name: 'Antiques', keyword: 'antique' },
  { id: '11700', name: 'Garden', keyword: 'garden tool' },
];

// Need at least this many listings in a cluster before the price spread
// means anything -- two listings could just be a fluke price difference.
const MIN_CLUSTER_SIZE = 3;
// Keep only the best clusters per category so the table doesn't balloon.
const CLUSTERS_PER_CATEGORY = 10;

function calcFlipScore(volume, spreadPct) {
  // Volume score -- more active listings of the same product means a
  // deeper, more liquid market to flip into. Caps around 40 listings.
  const volumeScore = Math.min(volume / 40, 1) * 55;

  // Spread score -- how far apart the cheapest and priciest listing of
  // the same product are, relative to the average price. Capped at 80%
  // so one wild outlier listing doesn't dominate the score.
  const cappedSpread = Math.min(spreadPct, 80);
  const spreadScore = (cappedSpread / 80) * 45;

  // Small deterministic variation so near-identical inputs don't all
  // round to the exact same integer
  const microVariance = volume % 7;

  return Math.min(99, Math.max(1, Math.round(volumeScore + spreadScore + microVariance * 0.3)));
}

let scanInProgress = false;
let lastScanTime = null;

async function runTrendScan() {
  if (scanInProgress) return;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.log('Supabase not configured, skipping scan');
    return;
  }

  scanInProgress = true;
  console.log('Starting eBay-only discovery scan (no RapidAPI calls)...');

  const results = [];

  for (const cat of CATEGORY_SWEEPS) {
    try {
      const listings = await sweepEbayCategory(cat.id, cat.keyword, 100);
      if (listings.length === 0) continue;

      const clusters = clusterListings(listings);
      const scoredInCategory = [];

      for (const [key, cluster] of Object.entries(clusters)) {
        if (cluster.items.length < MIN_CLUSTER_SIZE) continue;

        const goodConditionItems = cluster.items.filter(i => isGoodCondition(i.condition));
        const pricePool = goodConditionItems.length > 0 ? goodConditionItems : cluster.items;
        const prices = pricePool.map(i => i.price);
        const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
        const minPrice = Math.round(Math.min(...prices));
        const maxPrice = Math.round(Math.max(...prices));
        const spreadPct = avgPrice > 0 ? ((maxPrice - minPrice) / avgPrice) * 100 : 0;
        // Volume stays the full listing count (market depth), even though
        // price bounds are restricted to good-condition listings.
        const volume = cluster.items.length;
        const flipScore = calcFlipScore(volume, spreadPct);
        const image = cluster.items.find(i => i.image)?.image || null;
        const displayName = cluster.items
          .map(i => i.title)
          .sort((a, b) => a.length - b.length)[0];

        scoredInCategory.push({
          name: displayName,
          category: cat.name,
          avg_price: avgPrice,
          min_price: minPrice,
          max_price: maxPrice,
          // legacy column names, repurposed: sold_volume now means "active
          // listing count", price_change_pct now means "price spread %"
          sold_volume: volume,
          price_change_pct: parseFloat(spreadPct.toFixed(2)),
          flip_score: flipScore,
          image,
          scanned_at: new Date().toISOString(),
        });
      }

      scoredInCategory.sort((a, b) => b.flip_score - a.flip_score);
      results.push(...scoredInCategory.slice(0, CLUSTERS_PER_CATEGORY));

      console.log(`[scan] ${cat.name}: ${listings.length} listings -> ${Object.keys(clusters).length} clusters, kept ${Math.min(scoredInCategory.length, CLUSTERS_PER_CATEGORY)}`);

      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      console.error(`Sweep error for ${cat.name}:`, err.message);
    }
  }

  console.log(`Scan complete: ${results.length} clusters scored across ${CATEGORY_SWEEPS.length} categories.`);

  if (results.length === 0) {
    console.log('No results to save.');
    scanInProgress = false;
    return;
  }

  try {
    // Write raw scan to scan_history (append, never overwrite)
    await supabaseQuery('/scan_history', 'POST', results);

    // Upsert today's best score per item into daily_snapshots.
    const today = new Date().toISOString().split('T')[0];
    const seenNames = new Set();
    const snapshotRows = [];
    for (const r of results) {
      if (seenNames.has(r.name)) continue;
      seenNames.add(r.name);
      snapshotRows.push({
        name: r.name,
        category: r.category,
        avg_price: r.avg_price,
        min_price: r.min_price,
        max_price: r.max_price,
        sold_volume: r.sold_volume,
        price_change_pct: r.price_change_pct,
        flip_score: r.flip_score,
        image: r.image,
        snapshot_date: today,
      });
    }
    await upsertDailySnapshots(snapshotRows);

    // Prune scan_history older than 30 days
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabaseQuery(`/scan_history?scanned_at=lt.${cutoff}`, 'DELETE');

    // Also prune old daily_snapshots rows. /discover only ever reads the
    // most recent date anyway, so older rows are just storage bloat at
    // this point -- keep a couple weeks around in case /history is used
    // later for an item's own price-over-time chart.
    const snapshotCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    await supabaseQuery(`/daily_snapshots?snapshot_date=lt.${snapshotCutoff}`, 'DELETE');

    lastScanTime = new Date();
    console.log(`Trend scan complete. Saved ${snapshotRows.length} unique items.`);
  } catch (err) {
    console.error('Failed to save trends to Supabase:', err.message);
  }

  scanInProgress = false;
}

// ─── Mock fallback (only hit if eBay itself returns nothing, e.g. no creds) ──

const getMockListings = (query) => {
  const base = Math.floor(Math.random() * 200) + 100;
  return {
    query,
    avgPrice: base,
    totalListings: Math.floor(Math.random() * 400) + 50,
  };
};

// ─── Routes ───────────────────────────────────────────────────────────────────

// Discover endpoint -- ranked flip opportunities, scored purely from live
// eBay active-listing data (volume + price spread). No RapidAPI involved.
app.get("/discover", async (req, res) => {
  try {
    const data = await supabaseQuery(
      '/daily_snapshots?order=snapshot_date.desc,flip_score.desc&limit=500'
    );

    if (data && data.length > 0) {
      // Only ever show results from the single most recent scan date.
      // Cluster display names can shift slightly day to day (whichever
      // listing has the shortest title that day "wins" the name), so an
      // older row for what's logically the same product can sit under a
      // different exact name and never get overwritten. Restricting to
      // today's date keeps stale, pre-fix rows from polluting rankings.
      const latestDate = data[0].snapshot_date;
      const freshData = data.filter(item => item.snapshot_date === latestDate);

      const seen = new Set();
      const deduped = [];
      for (const item of freshData) {
        if (seen.has(item.name)) continue;
        seen.add(item.name);
        deduped.push(item);
      }
      const ranked = deduped
        .sort((a, b) => b.flip_score - a.flip_score)
        .slice(0, 50);

      const formatted = ranked.map(item => ({
        name: item.name,
        price: `$${item.avg_price}`,
        minPrice: item.min_price,
        maxPrice: item.max_price,
        spreadPct: item.price_change_pct,
        volume: `${item.sold_volume} listed`,
        category: item.category,
        image: item.image,
        flipScore: item.flip_score,
        source: 'discovered',
      }));
      return res.json({ results: formatted, lastScanned: latestDate });
    }

    if (!scanInProgress && !lastScanTime) runTrendScan();
    return res.json({ results: [], lastScanned: null, scanning: scanInProgress });
  } catch (err) {
    console.error('Discover error:', err.message);
    return res.json({ results: [], lastScanned: null, error: true });
  }
});

// Long-term history for a specific item, pulled from daily_snapshots
app.get("/history", async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Name required" });
  try {
    const encoded = encodeURIComponent(name);
    const data = await supabaseQuery(
      `/daily_snapshots?name=eq.${encoded}&order=snapshot_date.asc&limit=365`
    );
    res.json({ history: data || [] });
  } catch (err) {
    console.error('History error:', err.message);
    res.json({ history: [] });
  }
});

// Manually trigger a rescan -- ADMIN ONLY. No longer protecting against
// per-call cost (eBay's Browse API is free), but still gated so it can't
// be hammered by randoms who find the URL.
const ADMIN_SCAN_KEY = process.env.ADMIN_SCAN_KEY;

app.post("/scan", async (req, res) => {
  const providedKey = req.headers['x-admin-key'];
  if (!ADMIN_SCAN_KEY || providedKey !== ADMIN_SCAN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (scanInProgress) {
    return res.json({ message: 'Scan already in progress' });
  }
  runTrendScan();
  res.json({ message: 'Scan started' });
});

// Scan status
app.get("/scan/status", (req, res) => {
  res.json({ scanInProgress, lastScanTime });
});

// Trending items endpoint (legacy -- keeping for backwards compat)
app.get("/trending", async (req, res) => {
  const trendingNames = [
    "Nike Kobe 6 Protro",
    "Pokemon Charizard PSA 10",
    "LEGO Star Wars UCS",
    "Supreme Box Logo Hoodie",
    "PS5 Slim",
    "Jordan 1 Retro High OG",
    "Rolex Submariner",
    "Funko Pop Grail",
  ];

  const trending = await Promise.all(trendingNames.map(async (name) => {
    const ebayData = await searchEbay(name);
    const mock = getMockListings(name);
    const avgPrice = ebayData ? ebayData.avgPrice : mock.avgPrice;
    const totalListings = ebayData ? ebayData.totalListings : mock.totalListings;
    return {
      name,
      price: `$${avgPrice}`,
      volume: `${totalListings} listed`,
      category: getCategoryForItem(name),
      image: ebayData?.image || null,
      source: ebayData ? 'ebay' : 'mock',
    };
  }));

  res.json(trending);
});

// ─── Search endpoint ────────────────────────────────────────────────────────

// Live eBay search for the /search bar. Pulls up to 100 real active
// listings for the query, clusters them into sub-items, and returns each
// cluster's listing count + a condition-filtered price range and spread.
async function searchEbaySubItems(query, limit = 100) {
  const token = await getEbayToken();
  if (!token) return [];
  try {
    const encoded = encodeURIComponent(query);
    const response = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encoded}&limit=${limit}&filter=buyingOptions:{FIXED_PRICE}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      }
    );
    const data = await response.json();
    if (!data.itemSummaries) return [];

    const listings = data.itemSummaries
      .filter(item => item.price && item.title)
      .map(item => ({
        title: item.title,
        price: parseFloat(item.price.value),
        image: item.image?.imageUrl || null,
        condition: item.condition || null,
      }));

    const clusters = clusterListings(listings);
    const subItems = [];

    for (const [key, cluster] of Object.entries(clusters)) {
      if (cluster.items.length < 1) continue;

      const goodConditionItems = cluster.items.filter(i => isGoodCondition(i.condition));
      const pricePool = goodConditionItems.length > 0 ? goodConditionItems : cluster.items;
      const pricePoolValues = pricePool.map(i => i.price);

      const avgPrice = Math.round(
        pricePoolValues.reduce((a, b) => a + b, 0) / pricePoolValues.length
      );
      const minPrice = Math.round(Math.min(...pricePoolValues));
      const maxPrice = Math.round(Math.max(...pricePoolValues));
      const spreadPct = avgPrice > 0 ? ((maxPrice - minPrice) / avgPrice) * 100 : 0;

      const displayName = cluster.items
        .map(i => i.title)
        .sort((a, b) => a.length - b.length)[0];
      const image = cluster.items.find(i => i.image)?.image || null;

      subItems.push({
        name: displayName,
        image,
        activeListings: cluster.items.length,
        avgPrice,
        minPrice,
        maxPrice,
        spreadPct: parseFloat(spreadPct.toFixed(2)),
        category: getCategoryForItem(displayName),
      });
    }

    return subItems.sort((a, b) => b.activeListings - a.activeListings);
  } catch (err) {
    console.error('searchEbaySubItems error:', err.message);
    return [];
  }
}

app.get("/search", searchLimiter, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "Query required" });

  const subItems = await searchEbaySubItems(q, 100);

  if (subItems.length === 0) {
    return res.json({ query: q, results: [], source: 'ebay_live' });
  }

  res.json({
    query: q,
    results: subItems.map(item => ({
      name: item.name,
      image: item.image,
      activeListings: item.activeListings,
      avgPrice: item.avgPrice,
      minPrice: item.minPrice,
      maxPrice: item.maxPrice,
      spreadPct: item.spreadPct,
      price: `$${item.avgPrice}`,
      category: item.category,
    })),
    source: 'ebay_live',
  });
});

// Item detail endpoint (legacy, mock-based -- kept for backwards compat)
app.get("/item", (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Name required" });
  res.json(getMockListings(name));
});

// Price history / snapshot endpoint
// RULE: no RapidAPI, ever. Everything here comes from either the cached
// daily scan (Supabase) or a live eBay Browse API call. No historical
// chart, no fake data.
app.get("/pricehistory", async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Name required" });

  // 1. Check Supabase cache first -- this is a discovered/scored item
  try {
    const encoded = encodeURIComponent(name);
    const cached = await supabaseQuery(
      `/daily_snapshots?name=eq.${encoded}&order=snapshot_date.desc&limit=1`
    );
    if (cached && cached.length > 0) {
      const item = cached[0];
      return res.json({
        avgPrice: item.avg_price,
        minPrice: item.min_price,
        maxPrice: item.max_price,
        listingVolume: item.sold_volume,
        spreadPct: item.price_change_pct,
        flipScore: item.flip_score,
        scored: true,
        source: 'cached',
        lastUpdated: item.snapshot_date,
      });
    }
  } catch (err) {
    console.error('Cache lookup error:', err.message);
  }

  // 2. Not a discovered item -- build a live snapshot from eBay only.
  const ebayData = await searchEbay(name);
  if (ebayData) {
    const spreadPct = ebayData.avgPrice > 0
      ? ((ebayData.maxPrice - ebayData.minPrice) / ebayData.avgPrice) * 100
      : 0;
    return res.json({
      avgPrice: ebayData.avgPrice,
      minPrice: ebayData.minPrice,
      maxPrice: ebayData.maxPrice,
      listingVolume: ebayData.totalListings,
      spreadPct: parseFloat(spreadPct.toFixed(2)),
      scored: false,
      source: 'ebay_live',
    });
  }

  // 3. eBay also found nothing -- honest empty state, never mock data
  return res.json({
    avgPrice: null,
    scored: false,
    source: 'none',
    message: 'No pricing data available for this item.',
  });
});

// eBay Marketplace Account Deletion endpoint
app.get('/ebay/account-deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  const verificationToken = 'flipr-verify-token-2026-marketplace-deletion';
  const endpoint = 'https://flipr-backend-production-ac14.up.railway.app/ebay/account-deletion';
  const hash = crypto.createHash('sha256').update(challengeCode + verificationToken + endpoint).digest('hex');
  res.json({ challengeResponse: hash });
});

app.post('/ebay/account-deletion', (req, res) => {
  console.log('eBay account deletion notification received');
  res.sendStatus(200);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCategoryForItem(name) {
  if (name.includes("Nike") || name.includes("Jordan") || name.includes("Kobe") || name.includes("Adidas") || name.includes("New Balance") || name.includes("Asics")) return "Sneakers";
  if (name.includes("Pokemon") || name.includes("Pokémon") || name.includes("Funko") || name.includes("Magic") || name.includes("One Piece")) return "Collectibles";
  if (name.includes("LEGO")) return "Toys & Hobbies";
  if (name.includes("Supreme") || name.includes("Bape") || name.includes("Palace") || name.includes("Corteiz") || name.includes("Vintage")) return "Streetwear";
  if (name.includes("PS5") || name.includes("Nintendo") || name.includes("AirPods") || name.includes("iPad") || name.includes("GoPro") || name.includes("DJI")) return "Electronics";
  if (name.includes("Rolex") || name.includes("Casio") || name.includes("Seiko") || name.includes("Tissot")) return "Watches";
  if (name.includes("Card") || name.includes("Panini") || name.includes("Topps") || name.includes("Rookie")) return "Cards";
  return "General";
}

// Checks Supabase for the most recent real scan timestamp. Used on every
// boot so redeploys never trigger a fresh sweep unless one is genuinely
// overdue -- decouples "server restarted" from "time to scan again".
async function getLastRealScanTime() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return null;
  try {
    const data = await supabaseQuery(
      '/scan_history?order=scanned_at.desc&limit=1'
    );
    if (data && data.length > 0) {
      return new Date(data[0].scanned_at);
    }
  } catch (err) {
    console.error('Could not check last scan time:', err.message);
  }
  return null;
}

async function scanIfOverdue() {
  const lastReal = await getLastRealScanTime();
  const SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

  if (!lastReal) {
    console.log('No previous scan found in Supabase -- running first scan.');
    runTrendScan();
    return;
  }

  const msSinceLastScan = Date.now() - lastReal.getTime();
  if (msSinceLastScan >= SCAN_INTERVAL_MS) {
    console.log(`Last real scan was ${Math.round(msSinceLastScan / 3600000)}h ago -- running scan.`);
    runTrendScan();
  } else {
    const hoursLeft = ((SCAN_INTERVAL_MS - msSinceLastScan) / 3600000).toFixed(1);
    console.log(`Last real scan was only ${(msSinceLastScan / 3600000).toFixed(1)}h ago -- skipping (next scan in ~${hoursLeft}h).`);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Flipr backend running on http://localhost:${PORT}`);

  setTimeout(() => scanIfOverdue(), 5000);
  setInterval(() => scanIfOverdue(), 24 * 60 * 60 * 1000);
});