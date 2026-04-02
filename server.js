require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const fetch      = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;

const NLB_BASE    = 'https://openweb.nlb.gov.sg/api/v2/Catalogue';
const NLB_APP_ID  = process.env.NLB_APP_ID;
const NLB_API_KEY = process.env.NLB_API_KEY;

if (!NLB_APP_ID || !NLB_API_KEY) {
  console.error('ERROR: NLB_APP_ID and NLB_API_KEY must be set in environment variables.');
  process.exit(1);
}

/* ── CORS ── allow any origin for public tool ── */
app.use(cors());
app.use(express.json());

/* ── RATE LIMIT ── 60 requests per minute per IP ── */
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again in a minute.' }
});
app.use(limiter);

/* ── NLB headers ── */
const nlbHeaders = () => ({
  'X-Api-Key':   NLB_API_KEY,
  'X-App-Code':  NLB_APP_ID,
  'Accept':      'application/json',
  'Content-Type':'application/json',
  'User-Agent':  'Mozilla/5.0 (compatible; NLBDashboard/1.0)',
});

/* ── Retry helper for NLB 429s ── */
async function nlbFetch(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, { headers: nlbHeaders() });

    if (res.status === 429) {
      const wait = Math.pow(2, i) * 1000; // 1s, 2s, 4s
      console.warn(`NLB rate limit hit. Retrying in ${wait}ms...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`NLB API error ${res.status}: ${text}`);
    }

    return res.json();
  }
  throw new Error('NLB API rate limit exceeded after retries. Please try again shortly.');
}

/* ══════════════════════════════════════════════
   ROUTE 1: GET /search
   Query params:
     q       — keyword / title / author (required)
     limit   — max results (default 10, max 30)
   Returns: array of books with BRN, title, author, ISBN, cover
══════════════════════════════════════════════ */
app.get('/search', async (req, res) => {
  const q     = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 10, 30);

  if (!q) return res.status(400).json({ error: 'Query parameter q is required.' });

  try {
    const url  = `${NLB_BASE}/GetTitles?Keywords=${encodeURIComponent(q)}&Limit=${limit}&MediaCode=BK`;
    const data = await nlbFetch(url);

    if (!data.titles || data.titles.length === 0) {
      return res.json({ results: [] });
    }

    const results = data.titles.map(t => ({
      brn:       t.brn,
      bid:       t.brn,          // alias — some NLB docs use BID
      title:     t.title         || 'Unknown title',
      author:    t.author        || '',
      isbn:      t.isbn          || '',
      publisher: t.publisher     || '',
      year:      t.publishDate   || '',
      type:      t.materialType  || 'Book',
      language:  t.language      || '',
      cover:     t.coverUrl      || null,
    }));

    res.json({ results });
  } catch (err) {
    console.error('/search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════
   ROUTE 2: GET /availability
   Query params:
     brn     — NLB book BRN (required)
   Returns: availability per branch + shelf info
══════════════════════════════════════════════ */
app.get('/availability', async (req, res) => {
  const brn = (req.query.brn || '').trim();
  if (!brn) return res.status(400).json({ error: 'Query parameter brn is required.' });

  try {
    const url  = `${NLB_BASE}/GetAvailabilityInfo?BRN=${encodeURIComponent(brn)}`;
    const data = await nlbFetch(url);

    if (!data.items || data.items.length === 0) {
      return res.json({ brn, branches: {} });
    }

    /*
      Group items by branch. Each branch entry aggregates:
        - total copies at branch
        - available copies
        - shelf info (section, level/shelf, callNumber)
        - status of each copy
    */
    const branchMap = {};

    data.items.forEach(item => {
      const key  = item.branchCode || item.branchName;
      const name = item.branchName || key;

      if (!branchMap[key]) {
        branchMap[key] = {
          branchCode: key,
          branchName: name,
          total:      0,
          available:  0,
          shelf: {
            section:  item.locationDesc  || '',
            level:    item.levelDesc     || '',
            callno:   item.callNumber    || '',
          },
          items: [],
        };
      }

      const b = branchMap[key];
      b.total++;

      const isAvail = item.statusCode === 'I'; // 'I' = In — available
      if (isAvail) b.available++;

      b.items.push({
        itemNo:  item.itemNo,
        status:  item.statusDesc || item.statusCode,
        dueDate: item.dueDate    || null,
      });
    });

    /* Compute status per branch: 'yes' | 'low' | 'no' */
    Object.values(branchMap).forEach(b => {
      if (b.available === 0)     b.status = 'no';
      else if (b.available === 1) b.status = 'low';
      else                        b.status = 'yes';
    });

    res.json({ brn, branches: branchMap });
  } catch (err) {
    console.error('/availability error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Health check ── */
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`NLB Proxy running on port ${PORT}`);
});
