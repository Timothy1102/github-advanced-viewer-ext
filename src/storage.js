/*
 * GitHub Advanced Viewer - settings schema, defaults and storage helpers.
 *
 * Schema (chrome.storage.sync, under STORAGE_KEY):
 *   { version: 1, enabled: boolean, hideNoise: boolean,
 *     filters: [{ id, pattern, enabled }] }
 * `enabled` is the master switch for the file filters; `hideNoise` independently
 * controls hiding of resolved threads / bot comments / timeline events on a PR's
 * Conversation tab (see noise.js). Both default to on.
 *
 * Loaded the same three ways as matcher.js (classic script / importScripts /
 * Node require). Everything that touches `chrome.storage` takes an optional
 * `area` argument so tests can pass an in-memory fake.
 *
 * Pure helpers (addFilter, removeFilter, ...) take a settings object and
 * return { ok: true, settings } or { ok: false, error } - they never mutate
 * their input and never throw.
 */
(function (root, factory) {
  const matcher =
    typeof module === 'object' && module && module.exports
      ? require('./matcher.js')
      : root.PRFilesFilter && root.PRFilesFilter.matcher;
  const api = factory(matcher);
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    const ns = (root.PRFilesFilter = root.PRFilesFilter || {});
    ns.storage = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function (matcher) {
  'use strict';

  if (!matcher) throw new Error('[GitHub Advanced Viewer] matcher.js must be loaded before storage.js');

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'settings';

  // Default noise filters, grouped by category. Ids are stable (users' stored
  // filters keep their own ids; these only matter for fresh installs/reset).
  const DEFAULT_PATTERNS = [
    // Tests
    '*.spec.ts', '*.spec.tsx', '*.spec.js', '*.spec.jsx',
    '*.test.ts', '*.test.tsx', '*.test.js', '*.test.jsx',
    '__tests__/', '__mocks__/',
    '*_test.go', '*_test.py', 'test_*.py', '*Test.java', '*Tests.cs',
    // End-to-end tests
    'e2e/', 'cypress/', 'playwright-report/',
    // Snapshots
    '*.snap', '__snapshots__/',
    // Storybook
    '*.stories.*',
    // Lockfiles
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
    'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock',
    'composer.lock', 'go.sum',
    // Generated / build output / vendored
    '*.min.js', '*.min.css', '*.map', '*.generated.*', '*.pb.go', '*_pb2.py', '*.g.dart',
    'dist/', 'build/', 'coverage/', 'node_modules/',
    // Assets, type declarations, changelogs
    '*.svg', '*.d.ts', 'CHANGELOG.md',
    // OS junk
    '.DS_Store',
  ];

  const DEFAULT_FILTERS = Object.freeze(
    DEFAULT_PATTERNS.map((pattern) =>
      Object.freeze({
        id:
          pattern === '*.spec.ts' ? 'default-spec-ts' : pattern === '*.snap' ? 'default-snap' : 'default-' + pattern,
        pattern,
        enabled: true,
      })
    )
  );

  /** A fresh, mutable copy of the default settings. */
  function defaultSettings() {
    return {
      version: SCHEMA_VERSION,
      enabled: true,
      hideNoise: true,
      filters: DEFAULT_FILTERS.map((f) => ({ ...f })),
    };
  }

  function makeId(taken) {
    for (;;) {
      const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID().slice(0, 8)
          : Math.random().toString(36).slice(2, 10);
      if (!taken || !taken.has(id)) return id;
    }
  }

  /**
   * Turn anything (undefined, corrupt data, an older shape) into valid
   * settings. Rules:
   *   - not an object                      -> defaults
   *   - `enabled` / `hideNoise` not a boolean -> true
   *   - `filters` missing / not an array   -> default filters
   *   - `filters` is an array (even empty) -> kept; a deleted default stays deleted
   *   - bad entries (no string pattern) and duplicate patterns are dropped
   *   - patterns with invalid syntax are KEPT so the popup can show the error
   */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultSettings();
    const out = { version: SCHEMA_VERSION, enabled: raw.enabled !== false, hideNoise: raw.hideNoise !== false, filters: [] };
    if (!Array.isArray(raw.filters)) {
      out.filters = defaultSettings().filters;
      return out;
    }
    const patterns = new Set();
    const ids = new Set();
    for (const item of raw.filters) {
      const entry = typeof item === 'string' ? { pattern: item } : item;
      if (!entry || typeof entry !== 'object' || typeof entry.pattern !== 'string') continue;
      const pattern = entry.pattern.trim();
      if (!pattern || patterns.has(pattern)) continue;
      let id = typeof entry.id === 'string' && entry.id ? entry.id : '';
      if (!id || ids.has(id)) id = makeId(ids);
      patterns.add(pattern);
      ids.add(id);
      out.filters.push({ id, pattern, enabled: entry.enabled !== false });
    }
    return out;
  }

  // --- chrome.storage wrappers -------------------------------------------

  function defaultArea() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
      throw new Error('chrome.storage.sync is unavailable');
    }
    return chrome.storage.sync;
  }

  /** Load settings. Never rejects: any failure falls back to defaults. */
  async function load(area) {
    try {
      const store = area || defaultArea();
      const data = await store.get(STORAGE_KEY);
      return normalize(data && data[STORAGE_KEY]);
    } catch (_) {
      return defaultSettings();
    }
  }

  /** Persist settings. Rejects with a readable Error (e.g. sync quota). */
  async function save(settings, area) {
    const store = area || defaultArea();
    await store.set({ [STORAGE_KEY]: normalize(settings) });
  }

  /**
   * Seed defaults unless valid settings already exist (e.g. synced from
   * another device, or the extension was reinstalled). Returns true if it wrote.
   */
  async function ensureSeeded(area) {
    const store = area || defaultArea();
    const data = await store.get(STORAGE_KEY);
    const existing = data && data[STORAGE_KEY];
    if (existing && typeof existing === 'object' && Array.isArray(existing.filters)) return false;
    await store.set({ [STORAGE_KEY]: defaultSettings() });
    return true;
  }

  /**
   * Read-modify-write against the latest stored value, so two popups (or a
   * synced device) don't clobber each other with stale state.
   * `mutator(settings)` returns { ok, settings, ... } or { ok: false, error }.
   */
  async function update(mutator, area) {
    const current = await load(area);
    let result;
    try {
      result = mutator(current);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    if (!result || !result.ok) return result || { ok: false, error: 'Nothing to do.' };
    try {
      await save(result.settings, area);
    } catch (e) {
      return { ok: false, error: `Could not save: ${(e && e.message) || e}` };
    }
    return result;
  }

  // --- pure helpers -------------------------------------------------------

  /**
   * Trim + validate a pattern for use in `settings`. `ignoreId` lets an edit
   * keep its own pattern. -> { ok: true, pattern } | { ok: false, error }
   */
  function checkPattern(settings, rawPattern, ignoreId) {
    const pattern = typeof rawPattern === 'string' ? rawPattern.trim() : '';
    if (!pattern) return { ok: false, error: 'Enter a pattern first.' };
    const syntax = matcher.validatePattern(pattern);
    if (!syntax.ok) return { ok: false, error: syntax.error };
    if (settings.filters.some((f) => f.pattern === pattern && f.id !== ignoreId)) {
      return { ok: false, error: `"${pattern}" is already in the list.` };
    }
    return { ok: true, pattern };
  }

  function addFilter(settings, rawPattern) {
    const checked = checkPattern(settings, rawPattern);
    if (!checked.ok) return checked;
    const ids = new Set(settings.filters.map((f) => f.id));
    const filter = { id: makeId(ids), pattern: checked.pattern, enabled: true };
    return { ok: true, filter, settings: { ...settings, filters: [...settings.filters, filter] } };
  }

  function removeFilter(settings, id) {
    if (!settings.filters.some((f) => f.id === id)) return { ok: false, error: 'Filter no longer exists.' };
    return { ok: true, settings: { ...settings, filters: settings.filters.filter((f) => f.id !== id) } };
  }

  /** Edit a filter's pattern and/or enabled flag: patch = { pattern?, enabled? }. */
  function updateFilter(settings, id, patch) {
    const current = settings.filters.find((f) => f.id === id);
    if (!current) return { ok: false, error: 'Filter no longer exists.' };
    const next = { ...current };
    if (patch && patch.pattern !== undefined) {
      const checked = checkPattern(settings, patch.pattern, id);
      if (!checked.ok) return checked;
      next.pattern = checked.pattern;
    }
    if (patch && typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    return {
      ok: true,
      settings: { ...settings, filters: settings.filters.map((f) => (f.id === id ? next : f)) },
    };
  }

  const setMasterEnabled = (settings, enabled) => ({ ok: true, settings: { ...settings, enabled: !!enabled } });

  /** Hide (true) or show (false) conversation noise. Independent of the file-filter master switch. */
  const setHideNoise = (settings, hide) => ({ ok: true, settings: { ...settings, hideNoise: !!hide } });

  /** Restore the default filters. The master switch is left as the user set it. */
  const resetFilters = (settings) => ({ ok: true, settings: { ...settings, filters: defaultSettings().filters } });

  /** Serialise filters for export. Ids are omitted; import generates new ones. */
  function exportJson(settings) {
    return JSON.stringify(
      {
        version: SCHEMA_VERSION,
        enabled: settings.enabled,
        filters: settings.filters.map(({ pattern, enabled }) => ({ pattern, enabled })),
      },
      null,
      2
    );
  }

  /**
   * Merge filters from exported JSON (or a bare array of patterns/objects).
   * Non-destructive: existing filters are kept; duplicates and invalid
   * patterns are skipped. -> { ok, settings, added, skipped } | { ok: false, error }
   */
  function mergeImport(settings, text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: 'That is not valid JSON.' };
    }
    const list = Array.isArray(data) ? data : data && Array.isArray(data.filters) ? data.filters : null;
    if (!list) return { ok: false, error: 'Expected {"filters": [...]} or an array of patterns.' };
    let next = settings;
    let added = 0;
    let skipped = 0;
    for (const item of list) {
      const entry = typeof item === 'string' ? { pattern: item } : item;
      if (!entry || typeof entry !== 'object') {
        skipped++;
        continue;
      }
      const res = addFilter(next, entry.pattern);
      if (!res.ok) {
        skipped++;
        continue;
      }
      next = res.settings;
      if (entry.enabled === false) next = updateFilter(next, res.filter.id, { enabled: false }).settings;
      added++;
    }
    return { ok: true, settings: next, added, skipped };
  }

  return {
    SCHEMA_VERSION,
    STORAGE_KEY,
    DEFAULT_FILTERS,
    defaultSettings,
    normalize,
    load,
    save,
    ensureSeeded,
    update,
    checkPattern,
    addFilter,
    removeFilter,
    updateFilter,
    setMasterEnabled,
    setHideNoise,
    resetFilters,
    exportJson,
    mergeImport,
  };
});
