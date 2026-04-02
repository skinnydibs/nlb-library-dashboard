require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const fetch     = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app  = express();
const PORT = process.env.PORT || 3000;

const NLB_BASE    = 'https://openweb.nlb.gov.sg/api/v2/Catalogue';
const NLB_APP_ID  = process.env.NLB_APP_ID;
const NLB_API_KEY = process.env.NLB_API_KEY;

if (!NLB_APP_ID || !NLB_API_KEY) {
  console.error('ERROR: NLB_APP_ID and NLB_API_KEY must be set.');
  process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use(rateLimit({ windowMs: 60000, max: 60 }));

/* ── helpers ── */

// Safely extract a string from a value that may be string, object, or array
function str(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return str(val[0]);
  if (typeof val === 'object') return val.name || val.code || val.desc || '';
  return String(val);
}

// NLB API call with 8s timeout and one retry on 429
async function nlbFetch(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        headers: {
          'X-Api-Key':    NLB_API_KEY,
          'X-App-Code':   NLB_APP_ID,
          'Accept':       'application/json',
          'User-Agent':   'NLBDashboard/1.0',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`NLB ${res.status}: ${text.slice(0, 200)}`);
      }
      return res.json();
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error('NLB API timed out.');
      throw err;
    }
  }
  throw new Error('NLB API unavailable. Please try again.');
}

/* ── parse availability items into branch map ── */
function parseBranches(items) {
  const map = {};
  (items || []).forEach(item => {
    const code = str(item.location?.code || item.location);
    const name = str(item.location?.name) || code;
    if (!code) return;

    if (!map[code]) {
      map[code] = {
        branchCode: code,
        branchName: name,
        total:      0,
        available:  0,
        shelf: {
          section: str(item.usageLevel?.name || item.usageLevel) || 'See branch',
          callno:  str(item.formattedCallNumber || item.callNumber) || '',
        },
        items: [],
      };
    }

    const b = map[code];
    b.total++;
    const statusCode = str(item.status?.code || item.status);
    // NLB uses 'In' for available (on shelf), 'Out' for on loan
    if (statusCode === 'In' || statusCode === 'I') b.available++;
    b.items.push({
      itemId:  item.itemId || item.itemNo || '',
      status:  str(item.status?.name || item.status) || '',
      dueDate: item.transactionStatus?.date || item.dueDate || null,
    });
  });

  // Compute status per branch
  Object.values(map).forEach(b => {
    b.status = b.available >= 2 ? 'yes' : b.available === 1 ? 'low' : 'no';
  });

  return map;
}

/* ── determine material type label ── */
function getTypeInfo(t) {
  // Use media code/name from NLB — most reliable signal
  const mediaCode = str(t.media?.code || t.mediaCode || t.format?.code || t.format || '').toUpperCase();
  const mediaName = str(t.media?.name || t.mediaName || t.materialType?.name || t.materialType || '').toLowerCase();

  // Physical book codes from NLB
  if (mediaCode === 'BOOK' || mediaCode === 'BK') {
    return { typeLabel: 'Book', typeFlag: 'book' };
  }
  // Ebook signals
  if (mediaCode === 'EBOOK' || mediaName.includes('ebook') || mediaName.includes('electronic')) {
    return { typeLabel: 'eBook', typeFlag: 'ebook' };
  }
  // AV signals
  if (['cd','dvd','vcd','blu-ray','audio'].some(x => mediaName.includes(x))) {
    return { typeLabel: 'AV / Audio', typeFlag: 'av' };
  }
  // Fallback: if no clear signal, treat as book (physical is more common)
  return { typeLabel: 'Book', typeFlag: 'book' };
}

/* ══════════════════════════
   GET /search?q=...
══════════════════════════ */
app.get('/search', async (req, res) => {
  const q     = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 30, 40);
  if (!q) return res.status(400).json({ error: 'q is required' });

  try {
    const url  = `${NLB_BASE}/GetTitles?Keywords=${encodeURIComponent(q)}&Limit=${limit}&MediaCode=BK`;
    const data = await nlbFetch(url);
    const titles = data.titles || [];

    const results = titles.map(t => ({
      brn:      t.brn,
      title:    str(t.title)     || 'Unknown title',
      author:   str(t.author)    || '',
      isbn:     str(t.isbn)      || '',
      year:     str(t.publishDate) || '',
      language: str(t.language)  || '',
      cover:    t.coverUrl       || null,
      ...getTypeInfo(t),
    }));

    res.json({ results });
  } catch (err) {
    console.error('/search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════
   GET /availability?brn=...
══════════════════════════ */
app.get('/availability', async (req, res) => {
  const brn = (req.query.brn || '').trim();
  if (!brn) return res.status(400).json({ error: 'brn is required' });

  try {
    const url  = `${NLB_BASE}/GetAvailabilityInfo?BRN=${encodeURIComponent(brn)}`;
    const data = await nlbFetch(url);
    const branches = parseBranches(data.items);
    res.json({ brn, branches });
  } catch (err) {
    console.error('/availability error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════
   GET /debug/availability?brn=...
   Returns raw sample for debugging
══════════════════════════ */
app.get('/debug/availability', async (req, res) => {
  const brn = (req.query.brn || '').trim();
  if (!brn) return res.status(400).json({ error: 'brn required' });
  try {
    const url  = `${NLB_BASE}/GetAvailabilityInfo?BRN=${encodeURIComponent(brn)}`;
    const data = await nlbFetch(url);
    const items = data.items || [];
    res.json({
      totalItems:   items.length,
      sampleFields: items[0] ? Object.keys(items[0]) : [],
      sample:       items.slice(0, 3),
      parsed:       parseBranches(items),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── health ── */
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`NLB Proxy running on port ${PORT}`));
