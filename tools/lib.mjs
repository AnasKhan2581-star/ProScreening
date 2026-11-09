// HalalVest data pipeline — pure helpers (no network, no fs).
// Unit-tested by tools/lib.test.mjs so the derivation logic can be verified
// without hitting a price API.

/** Parse "YYYY-MM" into an absolute month index. */
export function ymToIndex(ym) {
  const [y, m] = ym.split('-').map(Number);
  return y * 12 + (m - 1);
}

/** Inverse of ymToIndex. */
export function indexToYm(i) {
  return Math.floor(i / 12) + '-' + String((i % 12) + 1).padStart(2, '0');
}

/** "YYYY-MM" for a UTC epoch-seconds timestamp. */
export function tsToYm(ts) {
  const d = new Date(ts * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/** "YYYY-MM-DD" for a UTC epoch-seconds timestamp. */
export function tsToYmd(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Round to the file's convention: 2 decimals, but keep 4 for sub-rupee prices
 * so early-history penny values don't collapse to the same number.
 */
export function roundPrice(v) {
  if (!isFinite(v)) return null;
  const dp = Math.abs(v) < 1 ? 4 : 2;
  return +v.toFixed(dp);
}

/**
 * Collapse a daily series into the last observation of each calendar month.
 * bars: [{ ts, adj }] ascending. Returns Map "YYYY-MM" -> adj.
 */
export function lastOfEachMonth(bars) {
  const out = new Map();
  for (const b of bars) {
    if (b.adj == null || !isFinite(b.adj) || b.adj <= 0) continue;
    out.set(tsToYm(b.ts), b.adj); // ascending input => last write wins
  }
  return out;
}

/**
 * Annual series on the file's convention: the last trading day's adjusted
 * close on or before March 31 of each year.
 * Returns { "2003": 0.48, ... }
 */
export function annualAtMarchEnd(bars) {
  const byYear = new Map();
  for (const b of bars) {
    if (b.adj == null || !isFinite(b.adj) || b.adj <= 0) continue;
    const d = new Date(b.ts * 1000);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth(); // 0 = Jan
    if (mo > 2) continue; // after March
    const prev = byYear.get(y);
    if (!prev || b.ts > prev.ts) byYear.set(y, b);
  }
  const out = {};
  for (const y of [...byYear.keys()].sort((a, b) => a - b)) {
    const v = roundPrice(byYear.get(y).adj);
    if (v != null) out[String(y)] = v;
  }
  return out;
}

/**
 * Build the { start, values } contiguous monthly block the page expects.
 * Gaps inside the range are forward-filled from the previous month and
 * reported, since the renderer assumes a dense array.
 */
export function toMonthlyBlock(monthMap) {
  const keys = [...monthMap.keys()].sort();
  if (!keys.length) return null;
  const first = ymToIndex(keys[0]);
  const last = ymToIndex(keys[keys.length - 1]);
  const values = [];
  const filled = [];
  let prev = null;
  for (let i = first; i <= last; i++) {
    const ym = indexToYm(i);
    let v = monthMap.get(ym);
    if (v == null) {
      if (prev == null) return null;
      v = prev;
      filled.push(ym);
    }
    prev = v;
    values.push(roundPrice(v));
  }
  return { start: keys[0], values, filled };
}

/**
 * Sanity checks on a derived monthly block. Returns an array of warnings;
 * empty means it looks plausible. jumpPct flags month-on-month moves that
 * are more likely an unadjusted split than a real price move.
 */
export function validateSeries(ticker, block, { jumpPct = 60, minMonths = 6 } = {}) {
  const w = [];
  if (!block) return [`${ticker}: no usable data`];
  if (block.values.length < minMonths) {
    w.push(`${ticker}: only ${block.values.length} months of data`);
  }
  if (block.filled && block.filled.length) {
    w.push(`${ticker}: forward-filled ${block.filled.length} gap month(s): ${block.filled.slice(0, 6).join(',')}${block.filled.length > 6 ? '…' : ''}`);
  }
  for (let i = 1; i < block.values.length; i++) {
    const a = block.values[i - 1], b = block.values[i];
    if (!a || !b) { w.push(`${ticker}: non-positive price at ${indexToYm(ymToIndex(block.start) + i)}`); continue; }
    const chg = ((b / a) - 1) * 100;
    if (Math.abs(chg) >= jumpPct) {
      w.push(`${ticker}: ${chg > 0 ? '+' : ''}${chg.toFixed(0)}% jump at ${indexToYm(ymToIndex(block.start) + i)} (${a} -> ${b}) — check split adjustment`);
    }
  }
  return w;
}

/**
 * Format a number the way the existing datasets are written: Python float
 * repr, i.e. always with a decimal point ("375.0", not "375"). The original
 * generator was Python, and matching it keeps regenerated diffs to the values
 * that genuinely changed instead of reformatting ~19,900 untouched numbers.
 */
export function fmtNum(v) {
  const s = String(v);
  return /[.e]/.test(s) ? s : s + '.0';
}

/** Serialize PRICES the way index.html stores it (one line). */
export function serializeAnnual(priceMap) {
  const parts = Object.keys(priceMap).map(t => {
    const inner = Object.entries(priceMap[t]).map(([y, v]) => `"${y}":${fmtNum(v)}`).join(',');
    return `"${t}":{${inner}}`;
  });
  return `const PRICES = {${parts.join(',')}};`;
}

/** Serialize MONTHLY_PRICES the way index.html stores it (one ticker per line). */
export function serializeMonthly(blockMap) {
  const lines = Object.keys(blockMap).map(t => {
    const b = blockMap[t];
    return `  "${t}":{start:"${b.start}",values:[${b.values.map(fmtNum).join(', ')}]}`;
  });
  // Note the trailing comma after the final entry — the committed block has
  // one, and matching it keeps the regenerated diff clean.
  return `const MONTHLY_PRICES = {\n${lines.join(',\n')},\n};`;
}

/** Serialize the NIFTY benchmark block. */
export function serializeNifty(block) {
  return `const NIFTY50_MONTHLY = {start:"${block.start}",values:[${block.values.map(fmtNum).join(', ')}]};`;
}
