const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();

// Rate limiters
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const searchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20,
  message: { error: "Search rate limit exceeded, please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(cors());
app.use(express.json());
app.use(generalLimiter);

// Mock data structured exactly like real eBay data will be
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
app.get("/trending", (req, res) => {
  const trending = [
    "Nike Kobe 6 Protro",
    "Pokémon Charizard PSA 10",
    "LEGO Star Wars UCS",
    "Supreme Box Logo Hoodie",
    "PS5 Slim",
    "Jordan 1 Retro High OG",
    "Rolex Submariner",
    "Funko Pop Grail",
  ].map((name) => {
    const data = getMockListings(name);
    return {
      name,
      price: `$${data.avgPrice}`,
      change: `${data.trend === "up" ? "+" : "-"}${data.changePercent}%`,
      trend: data.trend,
      volume: `${data.totalSold} sold`,
      category: getCategoryForItem(name),
    };
  });

  res.json(trending);
});

// Search endpoint
app.get("/search", searchLimiter, (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "Query required" });

  const data = getMockListings(q);
  res.json({
    results: [
      { name: q, ...data, category: "General", price: `$${data.avgPrice}` },
      {
        name: `${q} (Used)`,
        ...getMockListings(q),
        category: "General",
        price: `$${Math.floor(data.avgPrice * 0.75)}`,
      },
      {
        name: `${q} (DS)`,
        ...getMockListings(q),
        category: "General",
        price: `$${Math.floor(data.avgPrice * 1.15)}`,
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

function getCategoryForItem(name) {
  if (name.includes("Nike") || name.includes("Jordan") || name.includes("Kobe"))
    return "Sneakers";
  if (name.includes("Pokémon") || name.includes("Funko")) return "Collectibles";
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
