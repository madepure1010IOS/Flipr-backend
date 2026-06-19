const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const app = express();

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

async function supabaseQuery(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_SECRET_KEY,
      'Authorization': `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }
  if (method === 'GET') return res.json();
  return null;
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

// ─── eBay search ─────────────────────────────────────────────────────────────

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

// ─── RapidAPI sold history ────────────────────────────────────────────────────

async function getSoldPriceHistory(query) {
  const rapidApiKey = process.env.RAPIDAPI_KEY;
  if (!rapidApiKey) return null;
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
    const data = await response.json();
    if (!data || !data.products || data.products.length === 0) return null;

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

    // Calculate price trend — compare oldest vs newest month
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
      source: 'rapidapi',
    };
  } catch (err) {
    console.error('RapidAPI error:', err);
    return null;
  }
}

// ─── Trend scanner ────────────────────────────────────────────────────────────
// Searches broad category seeds, scores each result by flip potential:
// High sold volume + slight price dip = hidden opportunity

const SCAN_SEEDS = [
  // Sneakers
  "Nike Dunk Low", "Jordan 4 Retro", "New Balance 550", "Adidas Samba",
  "Nike Air Max 90", "Jordan 1 Mid", "Asics Gel Kayano",
  // Collectibles
  "Pokemon Booster Box", "Pokemon Graded Card", "Magic The Gathering Box",
  "Funko Pop Exclusive", "One Piece Card",
  // Electronics
  "Nintendo Switch OLED", "PS5 Controller", "AirPods Pro", "iPad Mini",
  "GoPro Hero", "DJI Mini Drone",
  // LEGO
  "LEGO Technic", "LEGO Icons", "LEGO Creator", "LEGO Botanical",
  // Streetwear
  "Supreme Hoodie", "Bape Hoodie", "Palace Skateboarding", "Corteiz",
  // Watches
  "Casio G-Shock", "Seiko Prospex", "Tissot PRX",
  // Sports Cards
  "Rookie Card PSA", "Panini Prizm Box", "Topps Chrome Box",
  // Vintage
  "Vintage Band Tee", "Vintage Levi Jacket", "Vintage Nike",
];

function calcFlipScore(soldVolume, priceChangePct) {
  // High volume = good liquidity
  // Slight price dip (-15% to 0%) = buy opportunity
  // Rising price = momentum play
  const volumeScore = Math.min(soldVolume / 500, 1) * 60; // max 60 pts
  let priceScore = 0;
  if (priceChangePct >= -15 && priceChangePct < 0) {
    // Sweet spot — dipping but not crashing
    priceScore = 40;
  } else if (priceChangePct >= 0 && priceChangePct <= 20) {
    // Rising — momentum
    priceScore = 30 - priceChangePct;
  } else if (priceChangePct < -15) {
    // Crashing — risky
    priceScore = 5;
  }
  return Math.round(volumeScore + priceScore);
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
  console.log('Starting trend scan...');
  const results = [];

  for (const seed of SCAN_SEEDS) {
    try {
      const [ebayData, soldData] = await Promise.all([
        searchEbay(seed),
        getSoldPriceHistory(seed),
      ]);

      if (!ebayData && !soldData) continue;

      const avgPrice = soldData?.avgPrice || ebayData?.avgPrice || 0;
      const soldVolume = soldData?.totalSold || ebayData?.totalSold || 0;
      const priceChangePct = soldData?.priceChangePct || 0;
      const flipScore = calcFlipScore(soldVolume, priceChangePct);
      const trend = priceChangePct >= -5 ? 'up' : 'down';

      results.push({
        name: seed,
        category: getCategoryForItem(seed),
        avg_price: avgPrice,
        sold_volume: soldVolume,
        price_change_pct: priceChangePct,
        flip_score: flipScore,
        image: ebayData?.image || null,
        trend,
        last_scanned_at: new Date().toISOString(),
      });

      // Small delay to avoid hammering APIs
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`Scan error for ${seed}:`, err.message);
    }
  }

  if (results.length === 0) {
    scanInProgress = false;
    return;
  }

  try {
    // Clear old results and insert fresh ones
    await supabaseQuery('/discovered_trends?id=neq.00000000-0000-0000-0000-000000000000', 'DELETE');
    await supabaseQuery('/discovered_trends', 'POST', results);
    lastScanTime = new Date();
    console.log(`Trend scan complete. ${results.length} items saved.`);
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

// Discover endpoint — returns ranked flip opportunities from Supabase
app.get("/discover", async (req, res) => {
  try {
    const data = await supabaseQuery(
      '/discovered_trends?order=flip_score.desc&limit=20'
    );

    if (data && data.length > 0) {
      const formatted = data.map(item => ({
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
      return res.json({ results: formatted, lastScanned: data[0]?.last_scanned_at });
    }

    // No data yet — trigger a scan and return mock while it runs
    if (!scanInProgress) runTrendScan();
    return res.json({ results: [], lastScanned: null, scanning: true });
  } catch (err) {
    console.error('Discover error:', err.message);
    return res.json({ results: [], lastScanned: null, error: true });
  }
});

// Manually trigger a rescan (call from admin or cron)
app.post("/scan", async (req, res) => {
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
app.get("/search", searchLimiter, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "Query required" });

  const ebayData = await searchEbay(q);
  const mock = getMockListings(q);
  const avgPrice = ebayData ? ebayData.avgPrice : mock.avgPrice;
  const totalSold = ebayData ? ebayData.totalSold : mock.totalSold;

  res.json({
    source: ebayData ? 'ebay' : 'mock',
    results: [
      {
        name: q,
        ...mock,
        avgPrice,
        totalSold,
        category: getCategoryForItem(q),
        price: `$${avgPrice}`,
        image: ebayData?.image || null,
      },
      {
        name: `${q} (Used)`,
        ...getMockListings(q),
        avgPrice: Math.floor(avgPrice * 0.75),
        category: getCategoryForItem(q),
        price: `$${Math.floor(avgPrice * 0.75)}`,
        image: ebayData?.image || null,
      },
      {
        name: `${q} (New/Sealed)`,
        ...getMockListings(q),
        avgPrice: Math.floor(avgPrice * 1.15),
        category: getCategoryForItem(q),
        price: `$${Math.floor(avgPrice * 1.15)}`,
        image: ebayData?.image || null,
      },
    ],
  });
});

// Item detail endpoint
app.get("/item", (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Name required" });
  res.json(getMockListings(name));
});

// Price history endpoint
app.get("/pricehistory", async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Name required" });

  const soldData = await getSoldPriceHistory(name);
  if (soldData && soldData.history6M.length > 0) {
    return res.json(soldData);
  }

  const token = await getEbayToken();
  if (!token) {
    const base = Math.floor(Math.random() * 300) + 100;
    return res.json(getMockHistory(base));
  }

  try {
    const encoded = encodeURIComponent(name);
    const response = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encoded}&limit=50&filter=buyingOptions:{FIXED_PRICE}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        },
      }
    );
    const data = await response.json();
    if (!data.itemSummaries || data.itemSummaries.length === 0) {
      const base = Math.floor(Math.random() * 300) + 100;
      return res.json(getMockHistory(base));
    }

    const prices = data.itemSummaries.filter(i => i.price).map(i => parseFloat(i.price.value));
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const now = new Date();
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const history6M = [];
    for (let i = 5; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const factor = 0.82 + (0.18 * ((5 - i) / 5)) + (Math.random() * 0.06 - 0.03);
      history6M.push({ date: i === 0 ? 'Now' : monthNames[date.getMonth()], price: Math.round(avg * factor) });
    }

    const history1Y = [];
    for (let i = 11; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const factor = 0.65 + (0.35 * ((11 - i) / 11)) + (Math.random() * 0.06 - 0.03);
      history1Y.push({ date: i === 0 ? 'Now' : monthNames[date.getMonth()], price: Math.round(avg * factor) });
    }

    res.json({ history6M, history1Y, avgPrice: avg, source: 'ebay' });
  } catch (err) {
    const base = Math.floor(Math.random() * 300) + 100;
    res.json(getMockHistory(base));
  }
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

// ─── Boot ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Flipr backend running on http://localhost:${PORT}`);

  // Run initial scan on startup, then every 6 hours
  setTimeout(() => runTrendScan(), 5000);
  setInterval(() => runTrendScan(), 6 * 60 * 60 * 1000);
});