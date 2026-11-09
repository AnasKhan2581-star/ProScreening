// Offline tests for the data pipeline's pure logic.
// Run: node tools/lib.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ymToIndex, indexToYm, tsToYm, roundPrice, lastOfEachMonth,
  annualAtMarchEnd, toMonthlyBlock, validateSeries,
  serializeMonthly, serializeAnnual,
} from './lib.mjs';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const day = (ymd) => Math.floor(Date.parse(ymd + 'T00:00:00Z') / 1000);
const bar = (ymd, adj) => ({ ts: day(ymd), adj });

console.log('month index helpers');
test('ymToIndex/indexToYm round-trip', () => {
  for (const ym of ['2001-01', '2007-09', '2026-04', '2026-12']) {
    assert.equal(indexToYm(ymToIndex(ym)), ym);
  }
});
test('month arithmetic crosses year boundary', () => {
  assert.equal(indexToYm(ymToIndex('2025-12') + 1), '2026-01');
});
test('tsToYm uses UTC', () => {
  assert.equal(tsToYm(day('2026-03-31')), '2026-03');
});

console.log('rounding');
test('sub-rupee prices keep 4dp', () => assert.equal(roundPrice(0.48123), 0.4812));
test('normal prices keep 2dp', () => assert.equal(roundPrice(1234.5678), 1234.57));
test('non-finite becomes null', () => assert.equal(roundPrice(Infinity), null));

console.log('monthly collapse');
test('takes the last trading day of each month', () => {
  const m = lastOfEachMonth([
    bar('2026-01-02', 10), bar('2026-01-30', 12),
    bar('2026-02-02', 13), bar('2026-02-27', 15),
  ]);
  assert.equal(m.get('2026-01'), 12);
  assert.equal(m.get('2026-02'), 15);
});
test('skips null, zero and negative prices', () => {
  const m = lastOfEachMonth([bar('2026-01-02', 10), bar('2026-01-30', null), bar('2026-01-31', 0)]);
  assert.equal(m.get('2026-01'), 10);
});

console.log('annual March-end derivation');
test('picks last trading day on or before Mar 31', () => {
  const a = annualAtMarchEnd([
    bar('2025-03-28', 100), bar('2025-03-31', 105), bar('2025-04-01', 999),
    bar('2026-03-30', 200), bar('2026-06-01', 888),
  ]);
  assert.deepEqual(a, { 2025: 105, 2026: 200 });
});
test('falls back to the prior session when Mar 31 is a holiday', () => {
  // Mar 31 2024 was a Sunday; last session Mar 28.
  const a = annualAtMarchEnd([bar('2024-03-28', 77), bar('2024-04-02', 88)]);
  assert.deepEqual(a, { 2024: 77 });
});
test('ignores April-onward bars entirely', () => {
  const a = annualAtMarchEnd([bar('2026-04-30', 50), bar('2026-12-31', 60)]);
  assert.deepEqual(a, {});
});

console.log('monthly block assembly');
test('builds a dense contiguous array', () => {
  const b = toMonthlyBlock(new Map([['2026-01', 10], ['2026-02', 11], ['2026-03', 12]]));
  assert.equal(b.start, '2026-01');
  assert.deepEqual(b.values, [10, 11, 12]);
  assert.deepEqual(b.filled, []);
});
test('forward-fills interior gaps and reports them', () => {
  const b = toMonthlyBlock(new Map([['2026-01', 10], ['2026-03', 12]]));
  assert.deepEqual(b.values, [10, 10, 12]);
  assert.deepEqual(b.filled, ['2026-02']);
});

console.log('validation');
test('flags a suspicious split-shaped jump', () => {
  const b = toMonthlyBlock(new Map([['2026-01', 100], ['2026-02', 20]]));
  const w = validateSeries('TEST', b);
  assert.ok(w.some(x => /jump/.test(x)), 'expected a jump warning, got: ' + JSON.stringify(w));
});
test('clean series produces no warnings', () => {
  const m = new Map();
  for (let i = 0; i < 24; i++) m.set(indexToYm(ymToIndex('2024-01') + i), 100 + i);
  assert.deepEqual(validateSeries('TEST', m && toMonthlyBlock(m)), []);
});
test('reports unusable data', () => {
  assert.deepEqual(validateSeries('TEST', null), ['TEST: no usable data']);
});

// ── Regression against the real file: the serializers must reproduce the
// existing data blocks exactly, or rewriting index.html would corrupt them.
console.log('serializer round-trip vs index.html');
const htmlPath = path.join(import.meta.dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
function grabBlock(name) {
  const i = html.indexOf('const ' + name + ' = {');
  if (i < 0) throw new Error('block not found: ' + name);
  const start = html.indexOf('{', i);
  let d = 0, j = start;
  for (; j < html.length; j++) {
    if (html[j] === '{') d++;
    else if (html[j] === '}') { d--; if (!d) break; }
  }
  return { text: html.slice(i, j + 2), obj: eval('(' + html.slice(start, j + 1) + ')') };
}

function assertSameText(label, got, want) {
  if (got === want) return;
  let k = 0;
  while (k < got.length && k < want.length && got[k] === want[k]) k++;
  throw new Error(
    `${label}: differs at offset ${k} (len got=${got.length} want=${want.length})\n` +
    `       got : …${JSON.stringify(got.slice(Math.max(0, k - 40), k + 40))}\n` +
    `       want: …${JSON.stringify(want.slice(Math.max(0, k - 40), k + 40))}`
  );
}

test('serializeMonthly reproduces MONTHLY_PRICES byte-for-byte', () => {
  const { text, obj } = grabBlock('MONTHLY_PRICES');
  assertSameText('MONTHLY_PRICES', serializeMonthly(obj), text.trim());
});

test('serializeAnnual round-trips PRICES semantically', () => {
  // The committed PRICES block has 4 values written without a decimal point
  // (1307, 436, 101, 263) while the other 1,703 use Python float repr. The
  // serializer normalises all of them, so compare parsed values, not bytes.
  const { text, obj } = grabBlock('PRICES');
  const rebuilt = serializeAnnual(obj);
  const reparse = eval('(' + rebuilt.slice(rebuilt.indexOf('{'), rebuilt.lastIndexOf('}') + 1) + ')');
  assert.deepEqual(reparse, obj);
  const deviations = [...text.matchAll(/":(-?\d+)(?=[,}])/g)].map(m => m[1]);
  assert.deepEqual(deviations, ['1307', '436', '101', '263'],
    'unexpected integer-formatted values; update this test if the data changed');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
