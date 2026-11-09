/**
 * HalalVest price proxy — Cloudflare Worker.
 *
 * Why this exists: Yahoo's chart endpoint sends no Access-Control-Allow-Origin,
 * so a static page on GitHub Pages cannot call it directly. This fetches
 * server-side (CORS is a browser-only restriction), adds the header, and
 * caches the result so Yahoo sees a trickle of traffic instead of one request
 * per visitor.
 *
 * Deploy (free tier is plenty):
 *   npm i -g wrangler
 *   wrangler login
 *   wrangler deploy tools/worker.js --name halalvest-prices --compatibility-date 2026-01-01
 * Then put the resulting https://halalvest-prices.<you>.workers.dev URL into
 * LIVE_ENDPOINT in index.html.
 *
 * Request:  GET /?symbols=TCS.NS,INFY.NS&range=2y&interval=1mo
 * Response: { "TCS.NS": { "2026-05": 3410.2, ... }, ... }
 *
 * Only month-end closes are returned — the page merges them into its embedded
 * series, so there is no need to ship daily bars over the wire.
 */

const ALLOWED_RANGE = new Set(['1y', '2y', '5y', '10y', 'max']);
const ALLOWED_INTERVAL = new Set(['1d', '1wk', '1mo']);
const MAX_SYMBOLS = 40;        // keep under the free tier's 50 subrequests/request
const CACHE_SECONDS = 6 * 3600;
const UPSTREAM_CONCURRENCY = 8;

// Restrict to the exchanges this app uses, so the Worker can't be repurposed
// as a general-purpose open proxy.
const SYMBOL_RE = /^[A-Z0-9&_-]{1,20}\.NS$|^\^NSEI$/;

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, origin, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      ...cors(origin),
      ...extra,
    },
  });
}

/** Month-end closes from one Yahoo chart response. */
function monthEnds(result) {
  const ts = result?.timestamp;
  const adj = result?.indicators?.adjclose?.[0]?.adjclose
           ?? result?.indicators?.quote?.[0]?.close;
  if (!ts || !adj) return null;
  const out = {};
  for (let i = 0; i < ts.length; i++) {
    const v = adj[i];
    if (v == null || !isFinite(v) || v <= 0) continue;
    const d = new Date(ts[i] * 1000);
    const ym = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    out[ym] = Math.round(v * 10000) / 10000; // ascending input => last wins
  }
  return Object.keys(out).length ? out : null;
}

async function fetchSymbol(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?range=${range}&interval=${interval}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; halalvest-proxy/1.0)',
      'Accept': 'application/json',
    },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });
  if (!res.ok) throw new Error('upstream ' + res.status);
  const j = await res.json();
  if (j?.chart?.error) throw new Error('upstream error');
  return monthEnds(j?.chart?.result?.[0]);
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '*';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, origin);

    const url = new URL(request.url);
    const range = url.searchParams.get('range') || '2y';
    const interval = url.searchParams.get('interval') || '1mo';
    if (!ALLOWED_RANGE.has(range)) return json({ error: 'bad range' }, 400, origin);
    if (!ALLOWED_INTERVAL.has(interval)) return json({ error: 'bad interval' }, 400, origin);

    const symbols = [...new Set((url.searchParams.get('symbols') || '')
      .split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length) return json({ error: 'no symbols' }, 400, origin);
    if (symbols.length > MAX_SYMBOLS) return json({ error: `max ${MAX_SYMBOLS} symbols per request` }, 400, origin);
    const bad = symbols.filter(s => !SYMBOL_RE.test(s));
    if (bad.length) return json({ error: 'unsupported symbols: ' + bad.join(',') }, 400, origin);

    // Serve an identical earlier response if we still have one.
    const cache = caches.default;
    const key = new Request(url.toString(), { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) {
      const h = new Headers(hit.headers);
      Object.entries(cors(origin)).forEach(([k, v]) => h.set(k, v));
      h.set('X-Cache', 'HIT');
      return new Response(hit.body, { status: hit.status, headers: h });
    }

    const data = {};
    const failed = [];
    await pool(symbols, UPSTREAM_CONCURRENCY, async (sym) => {
      try {
        const m = await fetchSymbol(sym, range, interval);
        if (m) data[sym] = m; else failed.push(sym);
      } catch { failed.push(sym); }
    });

    // Don't cache a mostly-failed response — it would pin an outage for hours.
    const healthy = Object.keys(data).length >= Math.ceil(symbols.length / 2);
    const res = json(
      { data, failed, asOf: new Date().toISOString() },
      healthy ? 200 : 502,
      origin,
      healthy ? { 'X-Cache': 'MISS' } : { 'Cache-Control': 'no-store', 'X-Cache': 'BYPASS' },
    );
    if (healthy) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
  },
};
