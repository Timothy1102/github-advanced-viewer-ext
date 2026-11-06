'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFileStats, parseTotalStats, summarize } = require('../src/diffstat.js');

test('parseFileStats: GitHub screen-reader text', () => {
  assert.deepEqual(parseFileStats(' 342 changes: 173 additions & 169 deletions '), { additions: 173, deletions: 169 });
  assert.deepEqual(parseFileStats('8 changes: 8 additions & 0 deletions'), { additions: 8, deletions: 0 });
  assert.deepEqual(parseFileStats('2 changes: 1 addition & 1 deletion'), { additions: 1, deletions: 1 });
  assert.deepEqual(parseFileStats('2,000 changes: 1,500 additions & 500 deletions'), { additions: 1500, deletions: 500 });
});

test('parseFileStats: unrelated or bad input returns null', () => {
  for (const bad of ['', 'Copy file name', 'BIN', null, undefined, 42, {}]) assert.equal(parseFileStats(bad), null);
});

test('parseTotalStats: toolbar text with U+2212 minus, ASCII hyphen, en dash', () => {
  assert.deepEqual(parseTotalStats('\n +183\n −173\n '), { additions: 183, deletions: 173 });
  assert.deepEqual(parseTotalStats('+782 -4'), { additions: 782, deletions: 4 });
  assert.deepEqual(parseTotalStats('+1,200 – 30'), { additions: 1200, deletions: 30 });
});

test('parseTotalStats: missing half or bad input returns null', () => {
  for (const bad of ['', '+5', '-5', 'no numbers', null, undefined, 7]) assert.equal(parseTotalStats(bad), null);
});

test('summarize: total minus hidden = shown (the +782 -4 -> +300 -1 example)', () => {
  const hiddenFiles = [
    { stats: { additions: 400, deletions: 3 } },
    { stats: { additions: 82, deletions: 0 } },
  ];
  const s = summarize({ additions: 782, deletions: 4 }, hiddenFiles);
  assert.deepEqual(s.total, { additions: 782, deletions: 4 });
  assert.deepEqual(s.hidden, { additions: 482, deletions: 3 });
  assert.deepEqual(s.shown, { additions: 300, deletions: 1 });
  assert.equal(s.unknownHidden, 0);
});

test('summarize: hidden files without counts are reported, not guessed', () => {
  const s = summarize({ additions: 10, deletions: 10 }, [{ stats: { additions: 4, deletions: 1 } }, { stats: null }, null]);
  assert.deepEqual(s.hidden, { additions: 4, deletions: 1 });
  assert.equal(s.unknownHidden, 2);
});

test('summarize: no total -> shown is null; shown never goes negative', () => {
  const none = summarize(null, [{ stats: { additions: 1, deletions: 1 } }]);
  assert.equal(none.total, null);
  assert.equal(none.shown, null);
  const over = summarize({ additions: 1, deletions: 0 }, [{ stats: { additions: 5, deletions: 2 } }]);
  assert.deepEqual(over.shown, { additions: 0, deletions: 0 });
});
