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

/* ── Retry helper for NLB 429s — with 8s timeout per attempt ── */
async function nlbFetch(url, retries = 2) {
  for (let i = 0; i < retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000); // 8s timeout

    try {
      const res = await fetch(url, { headers: nlbHeaders(), signal: controller.signal });
      clearTimeout(timer);

      if (res.status === 429) {
        const wait = 1000; // flat 1s wait, not exponential
        console.warn(`NLB rate limit hit. Retrying in ${wait}ms...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`NLB API error ${res.status}: ${text}`);
      }

      return res.json();
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        console.warn(`NLB request timed out (attempt ${i+1})`);
        if (i === retries - 1) throw new Error('NLB API timed out. Please try refreshing.');
        continue;
      }
      throw err;
    }
  }
  throw new Error('NLB API unavailable after retries. Please try again shortly.');
}

/* ══════════════════════════════════════════════
   ROUTE 1: GET /search
   Query params:
     q       — keyword / title / author (required)
     limit   — max results (default 10, max 30)
   Returns: physical books only, with live availability pre-fetched
══════════════════════════════════════════════ */
app.get('/search', async (req, res) => {
  const q     = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 20, 40);

  if (!q) return res.status(400).json({ error: 'Query parameter q is required.' });

  try {
    // Fetch more titles than needed since we'll filter out digital-only
    const url  = `${NLB_BASE}/GetTitles?Keywords=${encodeURIComponent(q)}&Limit=${limit}&MediaCode=BK`;
    const data = await nlbFetch(url);

    if (!data.titles || data.titles.length === 0) {
      return res.json({ results: [] });
    }

    // Check availability for each title in parallel (with concurrency limit)
    const titles = data.titles;
    const CONCURRENCY = 5;
    const resultsWithAvail = [];

    for (let i = 0; i < titles.length; i += CONCURRENCY) {
      const batch = titles.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async t => {
        try {
          const availUrl  = `${NLB_BASE}/GetAvailabilityInfo?BRN=${t.brn}`;
          const availData = await nlbFetch(availUrl);
          const items     = availData.items || [];

          // Only include if it has physical copies somewhere
          if (items.length === 0) return null;

          // Build branch availability map
          const branches = {};
          items.forEach(item => {
            const code = item.location?.code;
            const name = item.location?.name || code;
            if (!code) return;
            if (!branches[code]) {
              branches[code] = {
                branchCode: code,
                branchName: name,
                total: 0, available: 0,
                shelf: {
                  section: item.usageLevel?.name || '',
                  level:   '',
                  callno:  item.formattedCallNumber || item.callNumber || '',
                },
                items: [],
              };
            }
            branches[code].total++;
            if (item.status?.code === 'I') branches[code].available++;
            branches[code].items.push({
              itemNo:  item.itemId,
              status:  item.status?.name || '',
              dueDate: item.transactionStatus?.date || null,
            });
          });

          // Compute status per branch
          Object.values(branches).forEach(b => {
            b.status = b.available === 0 ? 'no' : b.available === 1 ? 'low' : 'yes';
          });

          return {
            brn:       t.brn,
            title:     t.title    || 'Unknown title',
            author:    t.author   || '',
            isbn:      t.isbn     || '',
            publisher: t.publisher || '',
            year:      t.publishDate || '',
            language:  (Array.isArray(t.language) ? t.language[0] : t.language) || '',
            cover:     t.coverUrl || null,
            branches,  // pre-fetched availability
          };
        } catch (err) {
          console.warn(`Availability check failed for BRN ${t.brn}:`, err.message);
          return null;
        }
      }));
      resultsWithAvail.push(...batchResults.filter(Boolean));
      // Stop once we have 10 valid physical results
      if (resultsWithAvail.length >= 10) break;
    }

    res.json({ results: resultsWithAvail.slice(0, 10) });
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
      const code = item.location?.code || '';
      const name = item.location?.name || code;
      if (!code) return;

      if (!branchMap[code]) {
        branchMap[code] = {
          branchCode: code,
          branchName: name,
          total:      0,
          available:  0,
          shelf: {
            section:  item.usageLevel?.name || '',
            level:    '',
            callno:   item.formattedCallNumber || item.callNumber || '',
          },
          items: [],
        };
      }

      const b = branchMap[code];
      b.total++;

      const isAvail = item.status?.code === 'I'; // 'I' = In — on shelf
      if (isAvail) b.available++;

      b.items.push({
        itemNo:  item.itemId,
        status:  item.status?.name || '',
        dueDate: item.transactionStatus?.date || null,
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

/* ── Debug: raw NLB availability response ── */
app.get('/debug/availability', async (req, res) => {
  const brn = (req.query.brn || '').trim();
  if (!brn) return res.status(400).json({ error: 'brn required' });
  try {
    const url  = `${NLB_BASE}/GetAvailabilityInfo?BRN=${encodeURIComponent(brn)}`;
    const data = await nlbFetch(url);
    // Return first 3 items raw so we can see actual field names
    res.json({ 
      totalItems: (data.items || []).length,
      sampleFields: data.items ? Object.keys(data.items[0] || {}) : [],
      sample: (data.items || []).slice(0, 3)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`NLB Proxy running on port ${PORT}`);
});
