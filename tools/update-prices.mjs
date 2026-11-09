#!/usr/bin/env node
// HalalVest price refresh.
//
//   node tools/update-prices.mjs --dry-run     # fetch + validate, write nothing
//   node tools/update-prices.mjs               # fetch + rewrite index.html
//   node tools/update-prices.mjs --only TCS,INFY
//
// Reads the ticker universe straight out of index.html, fetches daily
// split/dividend-adjusted closes, and derives BOTH datasets from that one
// source:
//   PRICES          annual, last session on or before 31 March
//   MONTHLY_PRICES  monthly, last session of each calendar month
//
// The committed data was originally built from two independent fetches, so
// its annual and monthly series disagree in 377 places and 18 annual points
// predate the monthly series. Deriving both from one daily pull removes that
// inconsistency, which means a first run will shift some historical values.
// Run with --dry-run first and read the report.
//
// Requires network access to query1/query2.finance.yahoo.com.

import fs from 'node:fs';
import path from 'node:path';
import {
  lastOfEachMonth, annualAtMarchEnd, toMonthlyBlock, validateSeries,
  serializeAnnual, serializeMonthly, serializeNifty,
} from './lib.mjs';

const HTML = path.join(import.meta.dirname, '..', 'index.html');
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const onlyArg = args.indexOf('--only');
const ONLY = onlyArg >= 0 ? args[onlyArg + 1].split(',').map(s => s.trim().toUpperCase()) : null;
const NIFTY_SYMBOL = '^NSEI';
const CONCURRENCY = 4;

// ── read the existing file ────────────────────────────────────────────────
function grab(html, name) {
  const i = html.indexOf('const ' + name + ' = {');
  if (i < 0) throw new Error('block not found in index.html: ' + name);
  const start = html.indexOf('{', i);
  let d = 0, j = start;
  for (; j < html.length; j++) {
    if (html[j] === '{') d++;
    else if (html[j] === '}') { d--; if (!d) break; }
  }
  const end = html.indexOf(';', j) + 1;
  return { obj: eval('(' + html.slice(start, j + 1) + ')'), from: i, to: end };
}

const html0 = fs.readFileSync(HTML, 'utf8');
const prevPrices = grab(html0, 'PRICES');
const prevMonthly = grab(html0, 'MONTHLY_PRICES');
const prevNifty = grab(html0, 'NIFTY50_MONTHLY');
const display = grab(html0, 'DISPLAY_TICKER').obj;

let tickers = Object.keys(prevPrices.obj);
if (ONLY) tickers = tickers.filter(t => ONLY.includes(t.toUpperCase()));
// The NSE code Yahoo knows is the DISPLAY ticker, not the internal key
// (e.g. internal YASHIND is listed as NETWEB).
const yahooSymbol = t => (display[t] || t) + '.NS';

// ── fetch ─────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchDaily(symbol, attempt = 0) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const host = hosts[attempt % hosts.length];
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`
    + `?period1=0&period2=${Math.floor(Date.now() / 1000)}`
    + `&interval=1d&events=div%2Csplits`;
  try {
    const res = await fetch(url, {
      headers: {
        // Yahoo rejects requests with no UA. Generic client name on purpose:
        // do not put the user's email or any identity in here.
        'User-Agent': 'Mozilla/5.0 (compatible; halalvest-data/1.0)',
        'Accept': 'application/json',
      },
    });
    if (res.status === 429 || res.status >= 500) throw new Error('HTTP ' + res.status);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' (non-retryable)');
    const j = await res.json();
    if (j?.chart?.error) throw new Error('API: ' + JSON.stringify(j.chart.error));
    const r = j?.chart?.result?.[0];
    if (!r?.timestamp?.length) throw new Error('empty result');
    const adj = r.indicators?.adjclose?.[0]?.adjclose
             ?? r.indicators?.quote?.[0]?.close;
    if (!adj) throw new Error('no adjclose/close in response');
    const bars = r.timestamp
      .map((ts, i) => ({ ts, adj: adj[i] }))
      .filter(b => b.adj != null && isFinite(b.adj) && b.adj > 0)
      .sort((a, b) => a.ts - b.ts);
    if (!bars.length) throw new Error('all bars null');
    return bars;
  } catch (e) {
    if (attempt >= 5 || /non-retryable/.test(e.message)) throw e;
    await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s, 4s, 8s, 16s
    return fetchDaily(symbol, attempt + 1);
  }
}

/** Run jobs with bounded concurrency so we don't get rate-limited. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────
console.log(`Fetching ${tickers.length} tickers + ${NIFTY_SYMBOL}${DRY ? ' (dry run)' : ''}…\n`);

const warnings = [];
const failures = [];
const newPrices = {};
const newMonthly = {};

await pool(tickers, CONCURRENCY, async (t) => {
  const sym = yahooSymbol(t);
  try {
    const bars = await fetchDaily(sym);
    const annual = annualAtMarchEnd(bars);
    const block = toMonthlyBlock(lastOfEachMonth(bars));
    const w = validateSeries(t, block);
    if (!block || !Object.keys(annual).length) throw new Error('derived empty series');
    newPrices[t] = annual;
    newMonthly[t] = block;
    if (w.length) warnings.push(...w);
    process.stdout.write('.');
  } catch (e) {
    failures.push(`${t} (${sym}): ${e.message}`);
    process.stdout.write('x');
  }
});

let niftyBlock = null;
try {
  niftyBlock = toMonthlyBlock(lastOfEachMonth(await fetchDaily(NIFTY_SYMBOL)));
} catch (e) {
  failures.push(`${NIFTY_SYMBOL}: ${e.message}`);
}
console.log('\n');

// ── report ────────────────────────────────────────────────────────────────
const endOf = b => {
  const [y, m] = b.start.split('-').map(Number);
  const t = y * 12 + (m - 1) + b.values.length - 1;
  return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
};

if (failures.length) {
  console.log(`FAILED (${failures.length}) — these keep their existing committed data:`);
  failures.forEach(f => console.log('  ' + f));
  console.log('');
}
if (warnings.length) {
  console.log(`WARNINGS (${warnings.length}):`);
  warnings.slice(0, 40).forEach(w => console.log('  ' + w));
  if (warnings.length > 40) console.log(`  …and ${warnings.length - 40} more`);
  console.log('');
}

// Keep committed data for anything that failed, so a partial outage cannot
// silently delete a ticker's history.
let kept = 0;
for (const t of Object.keys(prevPrices.obj)) {
  if (!newPrices[t]) { newPrices[t] = prevPrices.obj[t]; newMonthly[t] = prevMonthly.obj[t]; kept++; }
}
if (!niftyBlock) niftyBlock = prevNifty.obj;

// Changed-value summary, so a refresh is reviewable rather than a 287KB blob.
let changedCells = 0, changedTickers = 0, extended = 0;
for (const t of Object.keys(newMonthly)) {
  const a = prevMonthly.obj[t], b = newMonthly[t];
  if (!a) continue;
  let diff = 0;
  if (a.start !== b.start) diff++;
  const n = Math.min(a.values.length, b.values.length);
  for (let i = 0; i < n; i++) if (a.values[i] !== b.values[i]) diff++;
  if (b.values.length > a.values.length) extended++;
  if (diff) { changedTickers++; changedCells += diff; }
}

const oldEnd = endOf(prevMonthly.obj[Object.keys(prevMonthly.obj)[0]]);
const newEnd = endOf(newMonthly[Object.keys(newMonthly)[0]]);
console.log('SUMMARY');
console.log(`  fetched ok        ${tickers.length - failures.filter(f => !f.startsWith('^')).length}/${tickers.length}`);
console.log(`  kept committed    ${kept}`);
console.log(`  monthly window    ${oldEnd} -> ${newEnd}`);
console.log(`  series extended   ${extended}`);
console.log(`  revised history   ${changedCells} value(s) across ${changedTickers} ticker(s)`);
console.log(`  NIFTY50 end       ${endOf(niftyBlock)}`);

if (DRY) {
  console.log('\nDry run — index.html untouched.');
  process.exit(failures.length ? 1 : 0);
}
if (failures.length > tickers.length / 2) {
  console.error('\nAborting: more than half the universe failed to fetch. Nothing written.');
  process.exit(1);
}

// ── write ─────────────────────────────────────────────────────────────────
// Splice the three blocks back in, last offset first so earlier offsets stay valid.
let out = html0;
for (const [blk, text] of [
  [prevNifty, serializeNifty(niftyBlock)],
  [prevMonthly, serializeMonthly(newMonthly)],
  [prevPrices, serializeAnnual(newPrices)],
].sort((a, b) => b[0].from - a[0].from)) {
  out = out.slice(0, blk.from) + text + out.slice(blk.to);
}
fs.writeFileSync(HTML, out);
console.log(`\nWrote index.html (${(out.length / 1024).toFixed(0)} KB).`);
console.log('Next: node tools/lib.test.mjs && git diff --stat');
