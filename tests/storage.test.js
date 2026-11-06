'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/storage.js');

/** Minimal in-memory stand-in for chrome.storage.sync (promise API). */
function fakeArea(initial = {}, { failSet } = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(obj) {
      if (failSet) throw new Error(failSet);
      Object.assign(data, structuredClone(obj));
    },
  };
}

const patterns = (s) => s.filters.map((f) => f.pattern);

test('defaults: *.spec.ts and *.snap, both enabled, master on', () => {
  const d = S.defaultSettings();
  assert.equal(d.version, 1);
  assert.equal(d.enabled, true);
  assert.deepEqual(d.filters.map((f) => [f.pattern, f.enabled]), [['*.spec.ts', true], ['*.snap', true]]);
  d.filters.push({ id: 'x', pattern: 'y', enabled: true }); // mutating a copy...
  assert.equal(S.defaultSettings().filters.length, 2); // ...never affects the next one
});

test('normalize: missing / corrupt storage falls back to defaults', () => {
  for (const bad of [undefined, null, 'oops', 42, [], true]) {
    assert.deepEqual(patterns(S.normalize(bad)), ['*.spec.ts', '*.snap']);
  }
  assert.deepEqual(patterns(S.normalize({ enabled: true })), ['*.spec.ts', '*.snap']); // no filters key
  assert.deepEqual(patterns(S.normalize({ filters: 'nope' })), ['*.spec.ts', '*.snap']);
});

test('normalize: an empty filter list is respected (deleted defaults stay deleted)', () => {
  assert.deepEqual(S.normalize({ version: 1, enabled: true, filters: [] }).filters, []);
});

test('normalize: repairs bad entries, drops duplicates, keeps invalid-syntax patterns', () => {
  const s = S.normalize({
    version: 99,
    enabled: 'yes', // not a boolean -> treated as on
    filters: [
      { id: 'a', pattern: ' *.snap ', enabled: false },
      { id: 'a', pattern: 'dup-id.ts' }, // duplicate id -> regenerated
      { id: 'c', pattern: '*.snap' }, // duplicate pattern -> dropped
      { pattern: '' },
      { pattern: 5 },
      null,
      'plain-string.ts',
      { id: 'z', pattern: '!negated' }, // kept; the popup shows the error
    ],
  });
  assert.equal(s.version, 1);
  assert.equal(s.enabled, true);
  assert.deepEqual(patterns(s), ['*.snap', 'dup-id.ts', 'plain-string.ts', '!negated']);
  assert.equal(s.filters[0].enabled, false);
  assert.equal(new Set(s.filters.map((f) => f.id)).size, s.filters.length);
  assert.ok(s.filters.every((f) => typeof f.id === 'string' && f.id && typeof f.enabled === 'boolean'));
  assert.equal(S.normalize({ enabled: false, filters: [] }).enabled, false);
});

test('load: missing, corrupt, or failing storage gives defaults and never rejects', async () => {
  assert.deepEqual(patterns(await S.load(fakeArea())), ['*.spec.ts', '*.snap']);
  assert.deepEqual(patterns(await S.load(fakeArea({ settings: 'garbage' }))), ['*.spec.ts', '*.snap']);
  const throwing = { get: async () => { throw new Error('boom'); } };
  assert.deepEqual(patterns(await S.load(throwing)), ['*.spec.ts', '*.snap']);
  assert.deepEqual(patterns(await S.load({})), ['*.spec.ts', '*.snap']); // no get() at all
});

test('ensureSeeded: seeds when empty, never overwrites existing settings', async () => {
  const empty = fakeArea();
  assert.equal(await S.ensureSeeded(empty), true);
  assert.deepEqual(patterns(empty.data.settings), ['*.spec.ts', '*.snap']);

  const custom = { version: 1, enabled: false, filters: [{ id: 'k', pattern: 'only-mine', enabled: true }] };
  const existing = fakeArea({ settings: custom });
  assert.equal(await S.ensureSeeded(existing), false);
  assert.deepEqual(existing.data.settings, custom);

  const deleted = fakeArea({ settings: { version: 1, enabled: true, filters: [] } });
  assert.equal(await S.ensureSeeded(deleted), false); // user deleted everything: leave it
  assert.deepEqual(deleted.data.settings.filters, []);
});

test('addFilter: trims, rejects empty / duplicate / invalid, appends enabled', () => {
  const s = S.defaultSettings();
  const ok = S.addFilter(s, '   **/__snapshots__/**  ');
  assert.equal(ok.ok, true);
  assert.equal(ok.filter.pattern, '**/__snapshots__/**');
  assert.equal(ok.filter.enabled, true);
  assert.equal(ok.settings.filters.length, 3);
  assert.equal(s.filters.length, 2, 'input is not mutated');

  assert.match(S.addFilter(s, '').error, /Enter a pattern/);
  assert.match(S.addFilter(s, '    ').error, /Enter a pattern/);
  assert.match(S.addFilter(s, '*.snap').error, /already in the list/);
  assert.match(S.addFilter(s, ' *.snap ').error, /already in the list/); // dup after trim
  assert.match(S.addFilter(s, '!nope').error, /Negation/);
  assert.equal(S.addFilter(s, '*.SNAP').ok, true, 'patterns are case-sensitive, so this is not a duplicate');
  assert.equal(S.addFilter(s, undefined).ok, false);
});

test('removeFilter / updateFilter / setMasterEnabled / resetFilters', () => {
  const s = S.defaultSettings();
  assert.deepEqual(patterns(S.removeFilter(s, 'default-snap').settings), ['*.spec.ts']);
  assert.equal(S.removeFilter(s, 'missing').ok, false);

  const toggled = S.updateFilter(s, 'default-snap', { enabled: false }).settings;
  assert.equal(toggled.filters[1].enabled, false);
  assert.equal(s.filters[1].enabled, true, 'input is not mutated');

  const edited = S.updateFilter(s, 'default-snap', { pattern: '  *.snapshot ' });
  assert.equal(edited.settings.filters[1].pattern, '*.snapshot');
  assert.equal(S.updateFilter(s, 'default-snap', { pattern: '*.snap' }).ok, true, 'keeping own pattern is fine');
  assert.match(S.updateFilter(s, 'default-snap', { pattern: '*.spec.ts' }).error, /already in the list/);
  assert.match(S.updateFilter(s, 'default-snap', { pattern: '   ' }).error, /Enter a pattern/);
  assert.equal(S.updateFilter(s, 'nope', { enabled: false }).ok, false);

  assert.equal(S.setMasterEnabled(s, false).settings.enabled, false);
  assert.equal(S.setMasterEnabled(s, false).settings.filters.length, 2, 'master off keeps the list');

  const mess = { enabled: false, version: 1, filters: [{ id: 'x', pattern: 'x', enabled: true }] };
  const reset = S.resetFilters(mess).settings;
  assert.deepEqual(patterns(reset), ['*.spec.ts', '*.snap']);
  assert.equal(reset.enabled, false, 'reset only restores filters; master switch stays as set');
});

test('update(): read-modify-write against the latest stored value; surfaces save errors', async () => {
  const area = fakeArea();
  let res = await S.update((s) => S.addFilter(s, 'a.ts'), area);
  assert.equal(res.ok, true);
  assert.deepEqual(patterns(area.data.settings), ['*.spec.ts', '*.snap', 'a.ts']);

  // Another context changed storage between the popup's render and its click.
  area.data.settings.filters.push({ id: 'other', pattern: 'b.ts', enabled: true });
  res = await S.update((s) => S.addFilter(s, 'c.ts'), area);
  assert.deepEqual(patterns(area.data.settings), ['*.spec.ts', '*.snap', 'a.ts', 'b.ts', 'c.ts']);

  res = await S.update((s) => S.addFilter(s, 'a.ts'), area); // validation error: nothing written
  assert.equal(res.ok, false);

  const full = fakeArea({}, { failSet: 'QUOTA_BYTES_PER_ITEM quota exceeded' });
  res = await S.update((s) => S.addFilter(s, 'z.ts'), full);
  assert.equal(res.ok, false);
  assert.match(res.error, /quota exceeded/);

  res = await S.update(() => { throw new Error('bug'); }, area);
  assert.deepEqual(res, { ok: false, error: 'bug' });
});

test('exportJson / mergeImport round trip; import is additive and skips bad entries', () => {
  const s = S.updateFilter(S.defaultSettings(), 'default-snap', { enabled: false }).settings;
  const json = S.exportJson(s);
  const parsed = JSON.parse(json);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.filters, [
    { pattern: '*.spec.ts', enabled: true },
    { pattern: '*.snap', enabled: false },
  ]);

  const target = S.removeFilter(S.defaultSettings(), 'default-snap').settings; // only *.spec.ts
  const merged = S.mergeImport(target, json);
  assert.equal(merged.ok, true);
  assert.equal(merged.added, 1); // *.snap
  assert.equal(merged.skipped, 1); // *.spec.ts already present
  assert.deepEqual(merged.settings.filters.map((f) => [f.pattern, f.enabled]), [['*.spec.ts', true], ['*.snap', false]]);

  const arr = S.mergeImport(S.defaultSettings(), JSON.stringify(['x.ts', '', '!bad', 5, { pattern: 'y.ts', enabled: false }]));
  assert.equal(arr.added, 2);
  assert.equal(arr.skipped, 3);
  assert.deepEqual(patterns(arr.settings).slice(2), ['x.ts', 'y.ts']);

  assert.match(S.mergeImport(s, '{nope').error, /not valid JSON/);
  assert.match(S.mergeImport(s, '{"a":1}').error, /Expected/);
  assert.match(S.mergeImport(s, 'null').error, /Expected/);
});
