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
const DEFAULTS = S.DEFAULT_FILTERS.map((f) => f.pattern);
const byId = (s, id) => s.filters.find((f) => f.id === id);

test('defaults: noise filters (tests, snapshots, lockfiles, generated), all enabled, master on', () => {
  const d = S.defaultSettings();
  assert.equal(d.version, 1);
  assert.equal(d.enabled, true);
  assert.ok(d.filters.length > 20);
  assert.ok(d.filters.every((f) => f.enabled));
  for (const p of ['*.spec.ts', '*.snap', '*.test.tsx', '__snapshots__/', 'package-lock.json', 'yarn.lock', '*.min.js']) {
    assert.ok(DEFAULTS.includes(p), p);
  }
  assert.equal(new Set(d.filters.map((f) => f.id)).size, d.filters.length, 'ids are unique');
  assert.equal(new Set(DEFAULTS).size, DEFAULTS.length, 'patterns are unique');
  const matcher = require('../src/matcher.js');
  for (const p of DEFAULTS) assert.equal(matcher.validatePattern(p).ok, true, p);
  d.filters.push({ id: 'x', pattern: 'y', enabled: true }); // mutating a copy...
  assert.equal(S.defaultSettings().filters.length, DEFAULTS.length); // ...never affects the next one
});

test('normalize: missing / corrupt storage falls back to defaults', () => {
  for (const bad of [undefined, null, 'oops', 42, [], true]) {
    assert.deepEqual(patterns(S.normalize(bad)), DEFAULTS);
  }
  assert.deepEqual(patterns(S.normalize({ enabled: true })), DEFAULTS); // no filters key
  assert.deepEqual(patterns(S.normalize({ filters: 'nope' })), DEFAULTS);
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
  assert.deepEqual(patterns(await S.load(fakeArea())), DEFAULTS);
  assert.deepEqual(patterns(await S.load(fakeArea({ settings: 'garbage' }))), DEFAULTS);
  const throwing = { get: async () => { throw new Error('boom'); } };
  assert.deepEqual(patterns(await S.load(throwing)), DEFAULTS);
  assert.deepEqual(patterns(await S.load({})), DEFAULTS); // no get() at all
});

test('ensureSeeded: seeds when empty, never overwrites existing settings', async () => {
  const empty = fakeArea();
  assert.equal(await S.ensureSeeded(empty), true);
  assert.deepEqual(patterns(empty.data.settings), DEFAULTS);

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
  assert.equal(ok.settings.filters.length, DEFAULTS.length + 1);
  assert.equal(s.filters.length, DEFAULTS.length, 'input is not mutated');

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
  assert.deepEqual(patterns(S.removeFilter(s, 'default-snap').settings), DEFAULTS.filter((p) => p !== '*.snap'));
  assert.equal(S.removeFilter(s, 'missing').ok, false);

  const toggled = S.updateFilter(s, 'default-snap', { enabled: false }).settings;
  assert.equal(byId(toggled, 'default-snap').enabled, false);
  assert.equal(byId(s, 'default-snap').enabled, true, 'input is not mutated');

  const edited = S.updateFilter(s, 'default-snap', { pattern: '  *.snapshot ' });
  assert.equal(byId(edited.settings, 'default-snap').pattern, '*.snapshot');
  assert.equal(S.updateFilter(s, 'default-snap', { pattern: '*.snap' }).ok, true, 'keeping own pattern is fine');
  assert.match(S.updateFilter(s, 'default-snap', { pattern: '*.spec.ts' }).error, /already in the list/);
  assert.match(S.updateFilter(s, 'default-snap', { pattern: '   ' }).error, /Enter a pattern/);
  assert.equal(S.updateFilter(s, 'nope', { enabled: false }).ok, false);

  assert.equal(S.setMasterEnabled(s, false).settings.enabled, false);
  assert.equal(S.setMasterEnabled(s, false).settings.filters.length, DEFAULTS.length, 'master off keeps the list');

  const mess = { enabled: false, version: 1, filters: [{ id: 'x', pattern: 'x', enabled: true }] };
  const reset = S.resetFilters(mess).settings;
  assert.deepEqual(patterns(reset), DEFAULTS);
  assert.equal(reset.enabled, false, 'reset only restores filters; master switch stays as set');
});

test('update(): read-modify-write against the latest stored value; surfaces save errors', async () => {
  const area = fakeArea();
  let res = await S.update((s) => S.addFilter(s, 'a.ts'), area);
  assert.equal(res.ok, true);
  assert.deepEqual(patterns(area.data.settings), [...DEFAULTS, 'a.ts']);

  // Another context changed storage between the popup's render and its click.
  area.data.settings.filters.push({ id: 'other', pattern: 'b.ts', enabled: true });
  res = await S.update((s) => S.addFilter(s, 'c.ts'), area);
  assert.deepEqual(patterns(area.data.settings), [...DEFAULTS, 'a.ts', 'b.ts', 'c.ts']);

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
  assert.deepEqual(parsed.filters, DEFAULTS.map((pattern) => ({ pattern, enabled: pattern !== '*.snap' })));

  const target = S.removeFilter(S.defaultSettings(), 'default-snap').settings; // all but *.snap
  const merged = S.mergeImport(target, json);
  assert.equal(merged.ok, true);
  assert.equal(merged.added, 1); // *.snap
  assert.equal(merged.skipped, DEFAULTS.length - 1); // everything else already present
  assert.equal(merged.settings.filters.length, DEFAULTS.length);
  assert.equal(merged.settings.filters.find((f) => f.pattern === '*.snap').enabled, false);

  const arr = S.mergeImport(S.defaultSettings(), JSON.stringify(['x.ts', '', '!bad', 5, { pattern: 'y.ts', enabled: false }]));
  assert.equal(arr.added, 2);
  assert.equal(arr.skipped, 3);
  assert.deepEqual(patterns(arr.settings).slice(DEFAULTS.length), ['x.ts', 'y.ts']);

  assert.match(S.mergeImport(s, '{nope').error, /not valid JSON/);
  assert.match(S.mergeImport(s, '{"a":1}').error, /Expected/);
  assert.match(S.mergeImport(s, 'null').error, /Expected/);
});

test('hideNoise: defaults on; settings saved before it existed pick up the default', async () => {
  assert.equal(S.defaultSettings().hideNoise, true);
  const old = { version: 1, enabled: true, filters: [{ id: 'k', pattern: 'only-mine', enabled: true }] }; // no hideNoise key
  assert.equal(S.normalize(old).hideNoise, true);
  const area = fakeArea({ settings: old });
  assert.equal(await S.ensureSeeded(area), false, 'upgrading never rewrites stored settings');
  assert.equal((await S.load(area)).hideNoise, true);
  for (const bad of [undefined, null, 'oops', 42, []]) assert.equal(S.normalize(bad).hideNoise, true);
});

test('hideNoise: only an explicit false turns it off; junk is treated as on', () => {
  assert.equal(S.normalize({ hideNoise: false, filters: [] }).hideNoise, false);
  assert.equal(S.normalize({ hideNoise: true, filters: [] }).hideNoise, true);
  for (const junk of ['no', 0, null, {}]) assert.equal(S.normalize({ hideNoise: junk, filters: [] }).hideNoise, true, String(junk));
  assert.equal(S.normalize({ hideNoise: false }).hideNoise, false, 'kept even when filters is missing (defaults used)');
});

test('setHideNoise: independent of the file-filter master switch; never mutates its input', () => {
  const s = S.defaultSettings();
  const off = S.setHideNoise(s, false);
  assert.equal(off.ok, true);
  assert.equal(off.settings.hideNoise, false);
  assert.equal(off.settings.enabled, true, 'the file filters stay on');
  assert.equal(s.hideNoise, true, 'input is not mutated');
  assert.equal(S.setHideNoise(off.settings, true).settings.hideNoise, true);

  const masterOff = S.setMasterEnabled(s, false).settings;
  assert.equal(masterOff.hideNoise, true, 'turning file filtering off leaves conversation noise alone');
});

test('hideNoise survives other edits, reset, import and a storage round-trip', async () => {
  const area = fakeArea();
  await S.update((s) => S.setHideNoise(s, false), area);
  await S.update((s) => S.addFilter(s, 'a.ts'), area);
  await S.update((s) => S.resetFilters(s), area);
  await S.update((s) => S.mergeImport(s, JSON.stringify(['b.ts'])), area);
  const loaded = await S.load(area);
  assert.equal(loaded.hideNoise, false);
  assert.equal(loaded.filters.some((f) => f.pattern === 'b.ts'), true);
  assert.equal(JSON.parse(S.exportJson(loaded)).hideNoise, undefined, 'export is about filters only');
});
