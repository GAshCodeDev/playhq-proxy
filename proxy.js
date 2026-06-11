const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(express.json({ limit: '10mb' }));

// Allow Flutter web app to call this proxy
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, tenant, x-phq-tenant');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── AI ENDPOINT ─────────────────────────────────────────────────────────────
app.post('/ai', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('AI proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PLAYHQ ENDPOINTS ─────────────────────────────────────────────────────────
const endpoints = {
  '/search': 'https://search.playhq.com/graphql',
  '/api': 'https://api.playhq.com/graphql',
  '/spectator': 'https://spectator.playhq.com/graphql',
};

app.post('/:endpoint', async (req, res) => {
  const target = endpoints[`/${req.params.endpoint}`];
  if (!target) return res.status(404).json({ error: 'Unknown endpoint' });

  try {
    const headers = {
      'content-type': 'application/json',
      'accept': '*/*',
      'origin': 'https://www.playhq.com',
      'referer': 'https://www.playhq.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    };

    if (req.headers['tenant']) headers['tenant'] = req.headers['tenant'];
    if (req.headers['x-phq-tenant']) headers['x-phq-tenant'] = req.headers['x-phq-tenant'];

    const response = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PlayHQ proxy running at http://localhost:${PORT}`);
});
