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

// ── AI ENDPOINT ──────────────────────────────────────────────────────────────
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
    const text = await response.text();
    try {
      res.json(JSON.parse(text));
    } catch (e) {
      console.error('AI returned non-JSON:', text.substring(0, 200));
      res.status(502).json({ error: 'AI API returned invalid response' });
    }
  } catch (err) {
    console.error('AI proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PLAYHQ ENDPOINTS ──────────────────────────────────────────────────────────
const endpoints = {
  '/search': 'https://search.playhq.com/graphql',
  '/api': 'https://api.playhq.com/graphql',
  '/spectator': 'https://spectator.playhq.com/graphql',
};

const PLAYHQ_HEADERS = {
  'content-type': 'application/json',
  'accept': 'application/json, */*',
  'accept-language': 'en-AU,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
  'origin': 'https://www.playhq.com',
  'referer': 'https://www.playhq.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
};

// Retry helper — retries on 5xx or non-JSON responses
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();

      // Try to parse as JSON
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error(`Attempt ${attempt}: Non-JSON response from ${url}:`, text.substring(0, 200));
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }
        throw new Error('PlayHQ returned non-JSON response (CloudFront block)');
      }

      // Check for GraphQL errors that indicate a real error vs retry
      if (data.errors) {
        const msg = data.errors[0]?.message || 'GraphQL error';
        // Don't retry validation errors — they won't change
        if (data.errors[0]?.extensions?.code === 'GRAPHQL_VALIDATION_FAILED') {
          return data;
        }
        // Retry server errors
        if (attempt < maxRetries) {
          console.log(`Attempt ${attempt}: GraphQL error "${msg}", retrying...`);
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }
      }

      return data;
    } catch (err) {
      if (attempt < maxRetries) {
        console.log(`Attempt ${attempt}: Fetch error, retrying in ${attempt * 2}s...`, err.message);
        await new Promise(r => setTimeout(r, attempt * 2000));
      } else {
        throw err;
      }
    }
  }
}

app.post('/:endpoint', async (req, res) => {
  const target = endpoints[`/${req.params.endpoint}`];
  if (!target) return res.status(404).json({ error: 'Unknown endpoint' });

  try {
    const headers = { ...PLAYHQ_HEADERS };
    if (req.headers['tenant']) headers['tenant'] = req.headers['tenant'];
    if (req.headers['x-phq-tenant']) headers['x-phq-tenant'] = req.headers['x-phq-tenant'];

    const data = await fetchWithRetry(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
    });

    res.json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PlayHQ proxy running at http://localhost:${PORT}`);
});
