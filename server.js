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

// ─── eBay keyword search (used by /pricehistory, /search) ───────────────────

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
      totalSold: data.total || prices.length,
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

// Common color words also get stripped — they vary listing to listing for
// the "same" cluster intent (e.g. different colorways of the same model
// often still represent the same flip opportunity at the product level)
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
      isNaN(Number(w)) // drop pure numbers (sizes, years as standalone tokens)
    );

  // Keep only the first 4 significant words (brand + model usually lands
  // here), then sort alphabetically so word order differences between
  // listings of the same product still produce the same key
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

// ─── RapidAPI sold history ────────────────────────────────────────────────────

async function getSoldPriceHistory(query) {
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  if (!rapidApiKey) {
    console.log('[rapidapi] No RAPIDAPI_KEY set');
    return null;
  }
  try {
    const response = await fetch(
      'https://ebay-average-selling-price.p.rapidapi.com/findCompletedItems',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-host': 'ebay-average-selling-price.p.rapidapi.com',
          'x-rapidapi-key': rapidApiKey,
        },
        body: JSON.stringify({
          keywords: query,
          max_search_results: '60',
          remove_outliers: 'true',
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.log(`[rapidapi] HTTP ${response.status} for "${query}": ${errText.slice(0, 300)}`);
      return null;
    }

    const data = await response.json();
    if (!data || !data.products || data.products.length === 0) {
      console.log(`[rapidapi] No products for "${query}". Response:`, JSON.stringify(data).slice(0, 200));
      return null;
    }

    const byMonth = {};
    data.products.forEach(item => {
      if (!item.sold_date || !item.sold_price) return;
      const date = new Date(item.sold_date);
      if (isNaN(date.getTime())) return;
      const key = `${date.getFullYear()}-${String(date.getMonth()).padStart(2, '0')}`;
      if (!byMonth[key]) byMonth[key] = { prices: [], date };
      byMonth[key].prices.push(parseFloat(item.sold_price));
    });

    if (Object.keys(byMonth).length === 0) return null;

    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const sortedMonths = Object.entries(byMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val], i, arr) => ({
        date: i === arr.length - 1 ? 'Now' : monthNames[val.date.getMonth()],
        price: Math.round(val.prices.reduce((a, b) => a + b, 0) / val.prices.length),
      }));

    const oldest = sortedMonths[0]?.price || 0;
    const newest = sortedMonths[sortedMonths.length - 1]?.price || 0;
    const priceChangePct = oldest > 0 ? ((newest - oldest) / oldest) * 100 : 0;

    return {
      history6M: sortedMonths.slice(-6),
      history1Y: sortedMonths.slice(-12),
      avgPrice: Math.round(data.average_price) || null,
      minPrice: Math.round(data.min_price) || null,
      maxPrice: Math.round(data.max_price) || null,
      totalSold: data.total_results || null,
      priceChangePct: parseFloat(priceChangePct.toFixed(2)),
      monthsOfData: sortedMonths.length,
      source: 'rapidapi',
    };
  } catch (err) {
    console.error(`[rapidapi] Exception for "${query}":`, err.message);
    return null;
  }
}

// ─── Discovery scanner ─────────────────────────────────────────────────────────
// Sweeps real eBay categories, clusters similar listings into product groups,
// and scores each cluster by flip potential. No hardcoded product names.

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

// Only deep-score this many categories per day, rotating through the full
// list. Keeps RapidAPI usage flat (~5 categories x 8 items = ~40 calls/day)
// no matter how many categories we sweep for clustering.
const CATEGORIES_PER_DAY = 5;
const CLUSTERS_PER_CATEGORY = 8;

function getTodaysCategoryRotation() {
  const dayIndex = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const totalSlots = Math.ceil(CATEGORY_SWEEPS.length / CATEGORIES_PER_DAY);
  const slot = dayIndex % totalSlots;
  const start = slot * CATEGORIES_PER_DAY;
  return CATEGORY_SWEEPS.slice(start, start + CATEGORIES_PER_DAY);
}

function calcFlipScore(soldVolume, priceChangePct, monthsOfData) {
  // Volume score: more granular curve, caps out at higher volume so
  // moderate-volume items don't all hit the ceiling identically
  const volumeScore = Math.min(soldVolume / 60, 1) * 55;

  let priceScore = 0;
  if (priceChangePct >= -15 && priceChangePct < -1) {
    // Real sweet spot — dipping but not crashing
    priceScore = 40;
  } else if (priceChangePct >= -1 && priceChangePct <= 1) {
    // Effectively flat. If we only have one month of sold data, this isn't
    // a real "stable price" signal -- it just means we can't measure trend
    // yet. Score it low/neutral rather than rewarding it like a real dip.
    priceScore = monthsOfData && monthsOfData <= 1 ? 12 : 22;
  } else if (priceChangePct > 1 && priceChangePct <= 20) {
    priceScore = 32 - priceChangePct; // rising — momentum, but less than a dip
  } else if (priceChangePct < -15) {
    priceScore = 5; // crashing — risky
  } else {
    priceScore = 8; // rising fast (>20%) — likely already peaked, lower signal
  }

  // Small deterministic variation based on volume so near-identical inputs
  // don't all round to the exact same integer
  const microVariance = (soldVolume % 7);

  return Math.min(99, Math.round(volumeScore + priceScore + microVariance * 0.3));
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
  console.log('Starting category discovery scan...');
  const todaysScoring = getTodaysCategoryRotation();
  const todaysScoringNames = new Set(todaysScoring.map(c => c.name));
  console.log(`Today's deep-scoring rotation: ${todaysScoring.map(c => c.name).join(', ')}`);

  const discovered = [];

  for (const cat of CATEGORY_SWEEPS) {
    try {
      const listings = await sweepEbayCategory(cat.id, cat.keyword, 100);
      if (listings.length === 0) continue;

      const clusters = clusterListings(listings);
      const clusterSizes = Object.values(clusters).map(c => c.items.length).sort((a, b) => b - a);
      console.log(`[cluster] ${cat.name}: ${listings.length} listings -> ${Object.keys(clusters).length} raw clusters, top sizes: ${clusterSizes.slice(0, 10).join(',')}`);

      for (const [key, cluster] of Object.entries(clusters)) {
        // Only consider clusters with enough listings to mean something
        if (cluster.items.length < 2) continue;

        const prices = cluster.items.map(i => i.price);
        const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
        const image = cluster.items.find(i => i.image)?.image || null;

        // Use the cleanest/shortest title in the cluster as display name
        const displayName = cluster.items
          .map(i => i.title)
          .sort((a, b) => a.length - b.length)[0];

        // Build a clean search query for RapidAPI from the cluster key itself
        // (brand + model words, no seller fluff) -- much more likely to match
        // real sold listings than the messy original eBay title
        const searchQuery = key
          .split(' ')
          .filter(w => w.length > 2)
          .slice(0, 4)
          .join(' ');

        discovered.push({
          name: displayName,
          searchQuery: searchQuery || displayName,
          clusterKey: key,
          category: cat.name,
          avgPrice,
          clusterSize: cluster.items.length,
          image,
          eligibleForScoring: todaysScoringNames.has(cat.name),
        });
      }

      await new Promise(r => setTimeout(r, 400));
    } catch (err) {
      console.error(`Sweep error for ${cat.name}:`, err.message);
    }
  }

  console.log(`Found ${discovered.length} candidate clusters across ${CATEGORY_SWEEPS.length} categories. Deep-scoring only today's rotation: ${todaysScoring.map(c => c.name).join(', ')}.`);

  // Only deep-score clusters from today's rotating category subset,
  // taking the largest clusters per category up to CLUSTERS_PER_CATEGORY
  const eligibleCandidates = discovered.filter(d => d.eligibleForScoring);
  const byCategory = {};
  for (const item of eligibleCandidates) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }

  const topCandidates = [];
  for (const catName of Object.keys(byCategory)) {
    const sorted = byCategory[catName].sort((a, b) => b.clusterSize - a.clusterSize);
    topCandidates.push(...sorted.slice(0, CLUSTERS_PER_CATEGORY));
  }

  const results = [];
  for (const item of topCandidates) {
    try {
      let soldData = await getSoldPriceHistory(item.searchQuery);

      // If the specific cluster query found nothing, retry with a broader
      // 2-word query (likely brand + general category) before giving up.
      // Niche items often need a wider net to find any sold comps at all.
      if (!soldData || !soldData.totalSold) {
        const broaderQuery = item.searchQuery.split(' ').slice(0, 2).join(' ');
        if (broaderQuery && broaderQuery !== item.searchQuery) {
          await new Promise(r => setTimeout(r, 300));
          soldData = await getSoldPriceHistory(broaderQuery);
        }
      }

      if (!soldData || !soldData.totalSold) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      const soldVolume = soldData.totalSold;
      const priceChangePct = soldData.priceChangePct ?? 0;
      const flipScore = calcFlipScore(soldVolume, priceChangePct, soldData.monthsOfData);
      const trend = priceChangePct >= -5 ? 'up' : 'down';
      const avgPrice = soldData.avgPrice || item.avgPrice;

      results.push({
        name: item.name,
        category: item.category,
        avg_price: avgPrice,
        sold_volume: soldVolume,
        price_change_pct: priceChangePct,
        flip_score: flipScore,
        image: item.image,
        trend,
        scanned_at: new Date().toISOString(),
      });

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`Scoring error for ${item.name}:`, err.message);
    }
  }

  console.log(`Scored ${results.length} of ${topCandidates.length} candidates with real sold data (rest skipped — no RapidAPI match).`);

  if (results.length === 0) {
    console.log('No results to save.');
    scanInProgress = false;
    return;
  }

  try {
    // Write raw scan to scan_history (append, never overwrite)
    await supabaseQuery('/scan_history', 'POST', results);

    // Upsert today's best score per item into daily_snapshots.
    // De-dupe by name first -- Postgres upsert errors if the same
    // conflict key appears twice in one batch.
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
        sold_volume: r.sold_volume,
        price_change_pct: r.price_change_pct,
        flip_score: r.flip_score,
        image: r.image,
        trend: r.trend,
        snapshot_date: today,
      });
    }
    await upsertDailySnapshots(snapshotRows);

    // Prune scan_history older than 30 days
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabaseQuery(`/scan_history?scanned_at=lt.${cutoff}`, 'DELETE');

    lastScanTime = new Date();
    console.log(`Trend scan complete. ${results.length} items saved (scan_history + daily_snapshots).`);
  } catch (err) {
    console.error('Failed to save trends to Supabase:', err.message);
  }

  scanInProgress = false;
}

// ─── Mock fallbacks ───────────────────────────────────────────────────────────

const getMockListings = (query) => {
  const base = Math.floor(Math.random() * 200) + 100;
  return {
    query,
    avgPrice: base,
    totalSold: Math.floor(Math.random() * 400) + 50,
    avgDaysToSell: (Math.random() * 8 + 1).toFixed(1),
    sellThroughRate: Math.floor(Math.random() * 40) + 50,
    trend: base > 150 ? "up" : "down",
    changePercent: (Math.random() * 20 + 1).toFixed(1),
  };
};

function getMockHistory(base) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Now'];
  return {
    history6M: months.map((date, i) => ({
      date,
      price: Math.floor(base * (0.78 + i * 0.04)),
    })),
    history1Y: months.map((date, i) => ({
      date,
      price: Math.floor(base * (0.65 + i * 0.07)),
    })),
    avgPrice: base,
    source: 'mock',
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Discover endpoint — returns ranked flip opportunities from the most
// recent snapshot per item across the rotation (so categories not scored
// today still show their last known score, not disappear)
app.get("/discover", async (req, res) => {
  try {
    const data = await supabaseQuery(
      '/daily_snapshots?order=snapshot_date.desc,flip_score.desc&limit=500'
    );

    if (data && data.length > 0) {
      // De-dupe by name, keeping only the most recent snapshot per item
      const seen = new Set();
      const deduped = [];
      for (const item of data) {
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
        change: `${item.price_change_pct >= 0 ? '+' : ''}${item.price_change_pct}%`,
        trend: item.trend,
        volume: `${item.sold_volume} sold`,
        category: item.category,
        image: item.image,
        flipScore: item.flip_score,
        source: 'discovered',
      }));
      return res.json({ results: formatted, lastScanned: data[0]?.snapshot_date });
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

// Manually trigger a rescan -- ADMIN ONLY. Requires a secret key so this
// can never be triggered by a regular user or anyone who finds the URL.
// This is the only other path (besides the internal daily timer) that can
// call RapidAPI, so it must not be publicly reachable.
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

// Trending items endpoint (legacy — keeping for backwards compat)
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
    const totalSold = ebayData ? ebayData.totalSold : mock.totalSold;
    return {
      name,
      price: `$${avgPrice}`,
      change: `${mock.trend === "up" ? "+" : "-"}${mock.changePercent}%`,
      trend: mock.trend,
      volume: `${totalSold} listed`,
      category: getCategoryForItem(name),
      image: ebayData?.image || null,
      source: ebayData ? 'ebay' : 'mock',
    };
  }));

  res.json(trending);
});

// Search endpoint
// Maps eBay's condition strings to a simple good/poor bucket for filtering.
// "Good condition" = anything genuinely usable/sellable. Excludes parts,
// damaged, and non-working items that would skew prices down artificially.
function isGoodCondition(conditionStr) {
  if (!conditionStr) return true; // unknown condition -- don't exclude, just can't verify
  const c = conditionStr.toLowerCase();
  const poorSignals = ['for parts', 'not working', 'damaged', 'as-is', 'as is', 'salvage'];
  return !poorSignals.some(signal => c.includes(signal));
}

// Live eBay search for the /search bar. Pulls up to 100 real active
// listings for the query, clusters them into sub-items (reusing the same
// clustering logic as the discovery scanner), and returns each cluster's
// listing count + a condition-filtered price range. No RapidAPI, ever --
// this is a fully live, user-triggered eBay-only endpoint.
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

      const allPrices = cluster.items.map(i => i.price);
      const goodConditionItems = cluster.items.filter(i => isGoodCondition(i.condition));
      // If filtering leaves nothing (e.g. every listing is "for parts"),
      // fall back to all items rather than showing an empty range
      const pricePool = goodConditionItems.length > 0 ? goodConditionItems : cluster.items;
      const pricePoolValues = pricePool.map(i => i.price);

      const avgPrice = Math.round(
        pricePoolValues.reduce((a, b) => a + b, 0) / pricePoolValues.length
      );
      const minPrice = Math.round(Math.min(...pricePoolValues));
      const maxPrice = Math.round(Math.max(...pricePoolValues));

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
        category: getCategoryForItem(displayName),
      });
    }

    // Largest clusters (most listings = most relevant sub-item) first
    return subItems.sort((a, b) => b.activeListings - a.activeListings);
  } catch (err) {
    console.error('searchEbaySubItems error:', err.message);
    return [];
  }
}

// Search endpoint -- real eBay sub-items, no score, no fake variants.
// Shows market depth (active listing count) and a condition-filtered
// price range per sub-item. RapidAPI is never called here.
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
      price: `$${item.avgPrice}`,
      category: item.category,
    })),
    source: 'ebay_live',
  });
});

// Item detail endpoint
app.get("/item", (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Name required" });
  res.json(getMockListings(name));
});

// Price history endpoint
// RULE: RapidAPI is NEVER called here or from any user-triggered request.
// RapidAPI only runs inside the backend's own daily scan job.
//
// - If this item was found by the discovery scanner, serve its cached
//   RapidAPI-sourced history + flip score straight from Supabase.
// - If it's any other item (from general /search), build a price snapshot
//   from live eBay Browse API data only -- current listings, no historical
//   chart, no flip score, since that requires RapidAPI which we don't call here.
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
        totalSold: item.sold_volume,
        priceChangePct: item.price_change_pct,
        flipScore: item.flip_score,
        trend: item.trend,
        scored: true,
        source: 'cached',
        lastUpdated: item.snapshot_date,
      });
    }
  } catch (err) {
    console.error('Cache lookup error:', err.message);
  }

  // 2. Not a discovered item -- build a live snapshot from eBay only.
  // No RapidAPI call, no flip score, no historical chart.
  const ebayData = await searchEbay(name);
  if (ebayData) {
    return res.json({
      avgPrice: ebayData.avgPrice,
      minPrice: ebayData.minPrice,
      maxPrice: ebayData.maxPrice,
      totalSold: ebayData.totalSold,
      scored: false,
      source: 'ebay_live',
    });
  }

  // 3. eBay also found nothing -- return an honest empty state, never mock data
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
  if (name.includes("LEGO")) return "LEGO";
  if (name.includes("Supreme") || name.includes("Bape") || name.includes("Palace") || name.includes("Corteiz") || name.includes("Vintage")) return "Streetwear";
  if (name.includes("PS5") || name.includes("Nintendo") || name.includes("AirPods") || name.includes("iPad") || name.includes("GoPro") || name.includes("DJI")) return "Electronics";
  if (name.includes("Rolex") || name.includes("Casio") || name.includes("Seiko") || name.includes("Tissot")) return "Watches";
  if (name.includes("Card") || name.includes("Panini") || name.includes("Topps") || name.includes("Rookie")) return "Cards";
  return "General";
}

// Checks Supabase for the most recent real scan timestamp. Used on every
// boot so redeploys never burn RapidAPI calls unless a scan is genuinely
// overdue -- this decouples "server restarted" from "time to scan again".
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
    console.log(`Last real scan was only ${(msSinceLastScan / 3600000).toFixed(1)}h ago -- skipping (next scan in ~${hoursLeft}h). Redeploys are free.`);
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Flipr backend running on http://localhost:${PORT}`);

  // Check Supabase before scanning -- redeploys during development no
  // longer cost RapidAPI calls unless a scan is genuinely overdue.
  setTimeout(() => scanIfOverdue(), 5000);

  // Still check every 24h while the process stays alive, in case it runs
  // continuously without a redeploy for multiple days.
  setInterval(() => scanIfOverdue(), 24 * 60 * 60 * 1000);
});