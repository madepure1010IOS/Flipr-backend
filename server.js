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
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);

    return {
      avgPrice,
      minPrice: Math.round(minPrice),
      maxPrice: Math.round(maxPrice),
      totalSold: data.total || prices.length,
      items: data.itemSummaries.slice(0, 3),
    };
  } catch (err) {
    console.error('eBay search error:', err);
    return null;
  }
}

// Mock data fallback
const getMockListings = (query) => {
  const base = Math.floor(Math.random() * 200) + 100;
  return {
    query,
    avgPrice: base,
    priceHistory: [
      { date: "Jan", price: Math.floor(base * 0.78) },
      { date: "Feb", price: Math.floor(base * 0.82) },
      { date: "Mar", price: Math.floor(base * 0.85) },
      { date: "Apr", price: Math.floor(base * 0.9) },
      { date: "May", price: Math.floor(base * 0.95) },
      { date: "Jun", price: base },
    ],
    totalSold: Math.floor(Math.random() * 400) + 50,
    avgDaysToSell: (Math.random() * 8 + 1).toFixed(1),
    sellThroughRate: Math.floor(Math.random() * 40) + 50,
    trend: base > 150 ? "up" : "down",
    changePercent: (Math.random() * 20 + 1).toFixed(1),
  };
};

// Trending items endpoint
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
    const trend = mock.trend;
    const changePercent = mock.changePercent;

    return {
      name,
      price: `$${avgPrice}`,
      change: `${trend === "up" ? "+" : "-"}${changePercent}%`,
      trend,
      volume: `${totalSold} listed`,
      category: getCategoryForItem(name),
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
      },
      {
        name: `${q} (Used)`,
        ...getMockListings(q),
        avgPrice: Math.floor(avgPrice * 0.75),
        category: getCategoryForItem(q),
        price: `$${Math.floor(avgPrice * 0.75)}`,
      },
      {
        name: `${q} (New/Sealed)`,
        ...getMockListings(q),
        avgPrice: Math.floor(avgPrice * 1.15),
        category: getCategoryForItem(q),
        price: `$${Math.floor(avgPrice * 1.15)}`,
      },
    ],
  });
});

// Item detail endpoint
app.get("/item", (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Name required" });
  const data = getMockListings(name);
  res.json(data);
});

// eBay Marketplace Account Deletion endpoint (required for compliance)
app.get('/ebay/account-deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  const verificationToken = 'flipr-verify-token-2026-marketplace-deletion';
  const endpoint = 'https://flipr-backend-production-ac14.up.railway.app/ebay/account-deletion';

  const hash = crypto
    .createHash('sha256')
    .update(challengeCode + verificationToken + endpoint)
    .digest('hex');

  res.json({ challengeResponse: hash });
});

app.post('/ebay/account-deletion', (req, res) => {
  console.log('eBay account deletion notification received');
  res.sendStatus(200);
});

function getCategoryForItem(name) {
  if (name.includes("Nike") || name.includes("Jordan") || name.includes("Kobe")) return "Sneakers";
  if (name.includes("Pokemon") || name.includes("Pokémon") || name.includes("Funko")) return "Collectibles";
  if (name.includes("LEGO")) return "LEGO";
  if (name.includes("Supreme")) return "Streetwear";
  if (name.includes("PS5")) return "Electronics";
  if (name.includes("Rolex")) return "Watches";
  return "General";
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FlipTracker backend running on http://localhost:${PORT}`);
});