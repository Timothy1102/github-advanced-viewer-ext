/*
 * PR Files Filter - content script (injected on https://github.com/*).
 *
 * Load order (manifest): matcher.js, storage.js, content.js - they share
 * globalThis.PRFilesFilter.
 *
 * What it does on https://github.com/<owner>/<repo>/pull/<n>/files:
 *   - finds every changed-file block and every file-tree entry
 *   - hides the ones whose path matches an enabled filter by setting
 *     data-pff-hidden (CSS in content.css does `display: none !important`).
 *     GitHub's nodes are never removed.
 *   - shows a banner ("N files hidden by PR Files Filter") so reviewers always
 *     know files are hidden; "Show" reveals them for this page view only.
 *
 * Everywhere else on github.com it is idle: no MutationObserver, no work.
 *
 * DOM facts below were verified against live github.com PR pages (classic
 * server-rendered "Files changed" layout):
 *   - file block:  <div class="file" id="diff-<sha256>" data-tagsearch-path="a/b.ts">
 *       inside a <copilot-diff-entry> wrapper. For a RENAMED file the attribute
 *       holds the NEW path; the header link <a class="Link--primary"
 *       title="old/path → new/path"> carries both (its visible text is
 *       ellipsized, so never read textContent).
 *   - tree entry:  <li role="treeitem" data-tree-entry-type="file"
 *       id="file-tree-item-diff-<sha256>"> - the id is "file-tree-item-" + the
 *       file block's id, and a hidden <span data-filterable-item-text> holds
 *       the (new) path. Tree entries exist for ALL files even before their
 *       diffs lazy-load.
 *   - non-diff blocks: CI annotations on unchanged files render as a plain
 *       div.file with no data-tagsearch-path and no tree entry. We deliberately
 *       ignore these so annotations are never hidden.
 *   - navigation: Turbo swaps <turbo-frame id="repo-content-turbo-frame">
 *       without firing turbo:load/turbo:render/pjax:end. What does fire is the
 *       Navigation API's `currententrychange` (plus turbo:before-frame-render),
 *       so that is the primary signal; the classic events are kept as fallbacks.
 *       (Switching PR tabs can also be a full page load, which just re-runs
 *       this script.)
 */
(() => {
  'use strict';

  const LOG = '[PR Files Filter]';
  const NS = globalThis.PRFilesFilter;
  if (!NS || !NS.matcher || !NS.storage) {
    console.warn(`${LOG} shared scripts did not load; doing nothing.`);
    return;
  }
  const { matcher, storage } = NS;

  // ---------------------------------------------------------------------------
  // All GitHub-specific knowledge lives here. If GitHub changes its markup,
  // this is the only object that should need editing.
  // ---------------------------------------------------------------------------
  const SELECTORS = {
    // /<owner>/<repo>/pull/<n>/files or /changes (also /files/<sha>..<sha>).
    // Group 1 identifies the PR so "Show" state resets when the PR changes.
    filesPagePath: /^\/([^/]+\/[^/]+\/pull\/\d+)\/(?:files|changes)(?:\/|$)/,

    // Changed-file block in the main diff area.
    diffFile: 'div.file[data-tagsearch-path]',
    diffFilePathAttr: 'data-tagsearch-path',
    // Header link whose title is "old → new" for renames.
    diffFileTitleLink: '.file-header a.Link--primary[title]',
    renameArrow: ' → ',

    // Left-hand file tree.
    treeFile: 'li[role="treeitem"][data-tree-entry-type="file"]',
    treeDir: 'li[role="treeitem"][data-tree-entry-type="directory"]',
    treeFilePathText: '[data-filterable-item-text]',
    treeIdPrefix: 'file-tree-item-', // + the file block's id

    // Where the banner goes (first match wins; it is inserted as first child).
    bannerHosts: ['#files', '.js-diff-container', '.Layout-main'],
  };

  const ATTR_HIDDEN = 'data-pff-hidden'; // value = the pattern that matched
  const ATTR_EMPTY = 'data-pff-empty'; // tree folder whose files are all hidden
  const ATTR_REVEALED = 'data-pff-revealed'; // on <html> while "Show" is active
  const BANNER_ID = 'pff-banner';
  const MAX_PENDING_NODES = 300; // beyond this, one full scan is cheaper
  const MAX_LISTED_FILES = 500; // banner list cap (the count is always exact)
  const NO_FILES_WARN_MS = 5000;

  const state = {
    active: false, // are we on a PR files page and doing work?
    prKey: '',
    settings: null, // normalized settings (loaded lazily)
    filters: [], // enabled filters to apply; [] when the master switch is off
    version: 0, // bumped when `filters` change; invalidates cached decisions
    observer: null,
    pending: new Set(), // nodes added since the last flush
    needFullScan: false, // discover elements by querying the whole document (activation only)
    reevaluate: false, // filters changed: re-decide every known element (no DOM queries)
    treeDirty: false,
    summaryDirty: false,
    emptyFolders: new Set(), // tree folders we marked data-pff-empty
    lastLocation: '', // pathname + search; hash-only changes are ignored
    revealed: false, // "Show" override, this page view only, never persisted
    expanded: false, // banner file list open?
    listScroll: 0, // scrollTop of the open list, kept across banner rebuilds
    banner: null,
    hiddenCount: 0,
    warnTimer: 0,
    warned: false,
  };

  /**
   * One record per file block / tree entry we have looked at:
   *   { kind: 'diff'|'tree', key, path, oldPath, pattern|null, version }
   * `key` is the diff block's id, shared by a file's block and its tree entry,
   * so a file is counted once. `version` makes re-processing idempotent.
   */
  const records = new Map();

  // --- small utilities ---------------------------------------------------------

  function contextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false; // "Extension context invalidated" after a reload/update
    }
  }

  function debounce(fn, wait, maxWait) {
    let timer = 0;
    let started = 0;
    const debounced = () => {
      const now = Date.now();
      if (!timer) started = now;
      else clearTimeout(timer);
      // Trailing debounce, but never starve under constant mutation (lazy loading).
      timer = setTimeout(() => {
        timer = 0;
        fn();
      }, Math.max(0, Math.min(wait, started + maxWait - now)));
    };
    debounced.cancel = () => {
      clearTimeout(timer);
      timer = 0;
    };
    return debounced;
  }

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }

  // --- settings ----------------------------------------------------------------------

  function applySettings(settings) {
    state.settings = settings;
    state.filters = settings.enabled ? settings.filters.filter((f) => f.enabled) : [];
    state.version++;
  }

  async function ensureSettings() {
    if (state.settings) return;
    const loaded = await storage.load(); // falls back to defaults on missing/corrupt data
    if (!state.settings) applySettings(loaded); // a storage change may have landed first: keep it
  }

  // --- evaluating files -----------------------------------------------------------------

  function mark(el, pattern) {
    if (pattern === null) {
      if (el.hasAttribute(ATTR_HIDDEN)) el.removeAttribute(ATTR_HIDDEN);
    } else if (el.getAttribute(ATTR_HIDDEN) !== pattern) {
      el.setAttribute(ATTR_HIDDEN, pattern);
    }
  }

  /** For a renamed file, the pre-rename path from the header link's title. */
  function readOldPath(block, newPath) {
    const link = block.querySelector(SELECTORS.diffFileTitleLink);
    const title = link && link.getAttribute('title');
    if (!title || title === newPath) return null;
    const suffix = SELECTORS.renameArrow + newPath;
    return title.endsWith(suffix) ? title.slice(0, title.length - suffix.length) || null : null;
  }

  /** Decide + apply for one file block. Cheap and idempotent per filter version. */
  function evaluateDiffFile(block) {
    let rec = records.get(block);
    if (rec && rec.version === state.version) return rec;
    if (!rec) {
      const path = block.getAttribute(SELECTORS.diffFilePathAttr);
      if (!path) return null;
      rec = {
        kind: 'diff',
        key: block.id || `path:${path}`,
        path,
        oldPath: readOldPath(block, path),
        pattern: null,
        version: -1,
      };
      records.set(block, rec);
    }
    const match = matcher.matchingFilter([rec.oldPath, rec.path], state.filters);
    const pattern = match ? match.pattern : null;
    const changed = pattern !== rec.pattern;
    rec.pattern = pattern;
    rec.version = state.version; // set BEFORE touching the tree entry to avoid ping-pong
    mark(block, pattern);
    if (changed) {
      state.summaryDirty = true;
      // The block also knows the old path of a rename; the tree entry only
      // knows the new one, so push the block's verdict to it.
      const li = block.id && document.getElementById(SELECTORS.treeIdPrefix + block.id);
      if (li) evaluateTreeFile(li, true);
    }
    return rec;
  }

  /** The pattern hiding a tree entry: its file block's verdict if loaded, else by path. */
  function patternForTreeEntry(rec) {
    const block = document.getElementById(rec.key);
    if (block && block.matches(SELECTORS.diffFile)) {
      const diffRec = evaluateDiffFile(block);
      if (diffRec) return diffRec.pattern;
    }
    const match = matcher.matchingFilter([rec.path], state.filters);
    return match ? match.pattern : null;
  }

  function evaluateTreeFile(li, force) {
    let rec = records.get(li);
    if (rec && rec.version === state.version && !force) return rec;
    if (!rec) {
      const textEl = li.querySelector(SELECTORS.treeFilePathText);
      const path = textEl ? textEl.textContent.trim() : '';
      if (!path) return null;
      const prefix = SELECTORS.treeIdPrefix;
      rec = {
        kind: 'tree',
        key: li.id && li.id.startsWith(prefix) ? li.id.slice(prefix.length) : `path:${path}`,
        path,
        oldPath: null,
        pattern: null,
        version: -1,
      };
      records.set(li, rec);
    }
    const pattern = patternForTreeEntry(rec);
    const changed = pattern !== rec.pattern;
    rec.pattern = pattern;
    rec.version = state.version;
    mark(li, pattern);
    if (changed) {
      state.treeDirty = true;
      state.summaryDirty = true;
    }
    return rec;
  }

  /**
   * Hide tree folders whose files are ALL hidden, so the sidebar doesn't keep
   * a column of empty folders. Walks up from each hidden entry; stops at the
   * first folder that still has a visible file.
   */
  function updateEmptyFolders() {
    for (const el of state.emptyFolders) el.removeAttribute(ATTR_EMPTY); // no document-wide query
    state.emptyFolders.clear();
    const visibleFile = `${SELECTORS.treeFile}:not([${ATTR_HIDDEN}])`;
    const seen = new Set();
    for (const [el, rec] of records) {
      if (rec.kind !== 'tree' || rec.pattern === null || !el.isConnected) continue;
      let dir = el.parentElement && el.parentElement.closest(SELECTORS.treeDir);
      while (dir && !seen.has(dir)) {
        seen.add(dir);
        if (dir.querySelector(visibleFile)) break;
        dir.setAttribute(ATTR_EMPTY, '');
        state.emptyFolders.add(dir);
        dir = dir.parentElement && dir.parentElement.closest(SELECTORS.treeDir);
      }
    }
  }

  // --- finding work ------------------------------------------------------------------------

  /** Sort a newly added node into the file blocks / tree entries it is or contains. */
  function collect(node, blocks, entries) {
    if (node.nodeType !== 1 || node.id === BANNER_ID) return;
    // Lazy-loaded diff rows land inside an existing block: that block is all we need.
    const inBlock = node.closest(SELECTORS.diffFile);
    if (inBlock) return void blocks.add(inBlock);
    const inEntry = node.closest(SELECTORS.treeFile);
    if (inEntry) return void entries.add(inEntry);
    for (const b of node.querySelectorAll(SELECTORS.diffFile)) blocks.add(b);
    for (const e of node.querySelectorAll(SELECTORS.treeFile)) entries.add(e);
  }

  function flush() {
    if (!state.active) return;
    if (!contextValid()) return teardown(); // extension reloaded under us: leave the page clean
    if (!state.settings) return; // activate() flushes once settings have loaded

    if (state.reevaluate) {
      // Filters changed. Every element we care about is already in `records`
      // (found at activation or by the observer), so re-decide those directly
      // instead of re-querying a document that can hold millions of nodes.
      state.reevaluate = false;
      for (const [el, rec] of records) {
        if (!el.isConnected) continue;
        if (rec.kind === 'diff') evaluateDiffFile(el);
        else evaluateTreeFile(el);
      }
    }

    const blocks = new Set();
    const entries = new Set();
    if (state.needFullScan) {
      state.needFullScan = false;
      state.pending.clear();
      for (const b of document.querySelectorAll(SELECTORS.diffFile)) blocks.add(b);
      for (const e of document.querySelectorAll(SELECTORS.treeFile)) entries.add(e);
    } else {
      for (const node of state.pending) if (node.isConnected) collect(node, blocks, entries);
      state.pending.clear();
    }

    for (const b of blocks) evaluateDiffFile(b);
    for (const e of entries) evaluateTreeFile(e);

    for (const [el, rec] of records) {
      if (el.isConnected) continue;
      records.delete(el); // GitHub replaced/removed the node (e.g. SPA navigation)
      if (rec.pattern !== null) state.summaryDirty = true;
    }

    if (state.treeDirty) {
      state.treeDirty = false;
      updateEmptyFolders();
    }
    renderBanner();
  }

  /**
   * Coalesce mutation bursts into one flush per frame. requestAnimationFrame
   * runs BEFORE the next paint, so a lazy-loaded diff that should be hidden is
   * hidden before it is ever drawn (a timed debounce would flash it for its
   * delay). The timer is a fallback: rAF is paused in background tabs.
   */
  let flushRaf = 0;
  let flushTimer = 0;
  function flushSoon() {
    if (flushRaf || flushTimer) return;
    const run = () => {
      flushSoon.cancel();
      flush();
    };
    flushRaf = requestAnimationFrame(run);
    flushTimer = setTimeout(run, 250);
  }
  flushSoon.cancel = () => {
    cancelAnimationFrame(flushRaf);
    clearTimeout(flushTimer);
    flushRaf = 0;
    flushTimer = 0;
  };

  function onMutations(mutations) {
    if (!state.active) return;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1 && node.id !== BANNER_ID) state.pending.add(node);
      }
    }
    if (state.pending.size > MAX_PENDING_NODES) {
      state.pending.clear();
      state.needFullScan = true;
    }
    if (state.pending.size || state.needFullScan) flushSoon();
  }

  // --- banner ----------------------------------------------------------------------------------

  function hiddenFiles() {
    const byKey = new Map();
    for (const rec of records.values()) {
      if (rec.pattern === null) continue;
      const prev = byKey.get(rec.key);
      if (!prev || (rec.kind === 'diff' && prev.kind !== 'diff')) byKey.set(rec.key, rec);
    }
    return [...byKey.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  function setRevealed(on) {
    state.revealed = on;
    document.documentElement.toggleAttribute(ATTR_REVEALED, on);
  }

  function removeBanner() {
    if (state.banner) state.banner.remove();
    const stray = document.getElementById(BANNER_ID);
    if (stray) stray.remove();
    state.banner = null;
  }

  function findBannerHost() {
    for (const sel of SELECTORS.bannerHosts) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // Last resort: right above the first file block's container, so hidden
    // files are never silent even if the usual host disappears.
    const first = document.querySelector(SELECTORS.diffFile);
    return first ? first.parentElement : null;
  }

  function buildIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'pff-icon');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute(
      'd',
      'M.75 3h14.5a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1 0-1.5ZM3 7.75A.75.75 0 0 1 3.75 7h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 7.75Zm3 4a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z'
    );
    svg.append(path);
    return svg;
  }

  function buildBanner(files) {
    const n = files.length;
    const noun = n === 1 ? 'file' : 'files';
    const listId = `${BANNER_ID}-list`;

    const message = state.revealed
      ? [h('strong', { text: `${n} ${noun}` }), ` matching your filters ${n === 1 ? 'is' : 'are'} shown (PR Files Filter)`]
      : [h('strong', { text: `${n} ${noun}` }), ' hidden by PR Files Filter'];

    const toggle = h('button', {
      type: 'button',
      class: 'pff-btn',
      'data-pff-action': 'toggle',
      text: state.revealed ? 'Hide again' : 'Show',
    });
    const details = h('button', {
      type: 'button',
      class: 'pff-btn pff-btn-quiet',
      'data-pff-action': 'details',
      'aria-expanded': String(state.expanded),
      'aria-controls': listId,
      text: state.expanded ? 'Hide list ▴' : 'List ▾',
    });

    // The list is only built while expanded (and capped), so a PR with
    // thousands of hidden files doesn't pay for thousands of invisible nodes.
    const list = h('ul', { id: listId, class: 'pff-list' });
    list.hidden = !state.expanded;
    if (state.expanded) {
      // Remember scroll via an event: reading scrollTop during a flush would force layout.
      list.addEventListener('scroll', () => (state.listScroll = list.scrollTop), { passive: true });
      for (const f of files.slice(0, MAX_LISTED_FILES)) {
        const item = h('li', {}, h('code', { class: 'pff-path', text: f.path }));
        if (f.oldPath) {
          item.append(' ← renamed from ', h('code', { class: 'pff-path', text: f.oldPath }));
        }
        item.append(h('span', { class: 'pff-why' }, ' · matched ', h('code', { text: f.pattern })));
        list.append(item);
      }
      if (files.length > MAX_LISTED_FILES) {
        list.append(h('li', { class: 'pff-why', text: `…and ${files.length - MAX_LISTED_FILES} more` }));
      }
    }

    const banner = h(
      'div',
      { id: BANNER_ID, class: 'pff-banner', role: 'region', 'aria-label': 'PR Files Filter' },
      h('div', { class: 'pff-row' }, buildIcon(), h('span', { class: 'pff-msg' }, ...message), toggle, details),
      list
    );
    banner.addEventListener('click', onBannerClick);
    return banner;
  }

  function onBannerClick(event) {
    const btn = event.target.closest && event.target.closest('[data-pff-action]');
    if (!btn) return;
    if (btn.dataset.pffAction === 'toggle') setRevealed(!state.revealed);
    else if (btn.dataset.pffAction === 'details') {
      state.expanded = !state.expanded;
      state.listScroll = 0;
    }
    state.summaryDirty = true;
    renderBanner();
  }

  function renderBanner() {
    const old = state.banner;
    const attached = !!(old && old.isConnected);
    if (!state.summaryDirty && (attached || state.hiddenCount === 0)) return;
    state.summaryDirty = false;

    const files = hiddenFiles();
    state.hiddenCount = files.length;

    if (files.length === 0) {
      removeBanner(); // nothing hidden -> no banner (and no stale "Show" override)
      if (state.revealed) setRevealed(false);
      return;
    }
    const host = findBannerHost();
    if (!host) return;

    // Rebuilding drops focus and list scroll; keep both (keyboard users, long lists).
    const focusedAction = attached && old.contains(document.activeElement) ? document.activeElement.dataset.pffAction : null;

    const banner = buildBanner(files);
    if (attached && old.parentElement === host) old.replaceWith(banner);
    else {
      removeBanner();
      host.insertBefore(banner, host.firstChild);
    }
    state.banner = banner;
    // Only touch scrollTop when the list is open: writing it forces a synchronous
    // layout, which is very slow right after thousands of blocks changed display.
    if (state.expanded && state.listScroll) banner.querySelector('.pff-list').scrollTop = state.listScroll;
    if (focusedAction) {
      const target = banner.querySelector(`[data-pff-action="${focusedAction}"]`);
      if (target) target.focus();
    }
  }

  // --- activation / navigation ----------------------------------------------------------------------

  function startObserver() {
    if (state.observer) return;
    // documentElement, not body: Turbo can swap the whole <body>.
    state.observer = new MutationObserver(onMutations);
    state.observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (state.observer) state.observer.disconnect();
    state.observer = null;
  }

  /** One console.warn per page view if no file blocks ever show up. */
  function armNoFilesWarning() {
    clearTimeout(state.warnTimer);
    state.warned = false;
    state.warnTimer = setTimeout(() => {
      if (!state.active || state.warned || document.querySelector(SELECTORS.diffFile)) return;
      state.warned = true;
      console.warn(
        `${LOG} No file containers matching "${SELECTORS.diffFile}" were found on ${location.pathname} ` +
          `after ${NO_FILES_WARN_MS / 1000}s. GitHub's Files changed markup may have changed - ` +
          'update the SELECTORS object at the top of src/content.js.'
      );
    }, NO_FILES_WARN_MS);
  }

  /** Remove everything we added to the page. Safe to call repeatedly. */
  function clearPage() {
    flushSoon.cancel();
    clearTimeout(state.warnTimer);
    state.pending.clear();
    state.needFullScan = false;
    state.reevaluate = false;
    // Undo our marks using what we tracked, not a document-wide query.
    for (const el of records.keys()) el.removeAttribute(ATTR_HIDDEN);
    for (const el of state.emptyFolders) el.removeAttribute(ATTR_EMPTY);
    state.emptyFolders.clear();
    records.clear();
    removeBanner();
    setRevealed(false);
    state.expanded = false;
    state.listScroll = 0;
    state.hiddenCount = 0;
    state.treeDirty = false;
    state.summaryDirty = false;
  }

  function deactivate() {
    if (!state.active) return;
    state.active = false;
    state.prKey = '';
    stopObserver();
    clearPage();
  }

  async function activate(prKey) {
    if (state.active) clearPage(); // moved to a different PR's files page
    state.active = true;
    state.prKey = prKey;
    startObserver();
    armNoFilesWarning();
    await ensureSettings();
    if (!state.active || state.prKey !== prKey) return; // navigated away while loading
    state.needFullScan = true;
    flush();
  }

  /** Re-check the URL and start/stop work accordingly. */
  function sync() {
    if (!contextValid()) return teardown();
    const match = SELECTORS.filesPagePath.exec(location.pathname);
    if (!match) return deactivate();
    const here = location.pathname + location.search;
    if (state.active && state.prKey === match[1]) {
      // Same PR. Clicking a file in the tree only changes the #hash: nothing to do.
      // A different path/query (e.g. a commit range) may swap the DOM: re-scan.
      if (here !== state.lastLocation) {
        state.lastLocation = here;
        state.needFullScan = true;
        flushSoon();
      }
      return;
    }
    state.lastLocation = here;
    activate(match[1]);
  }
  const syncSoon = debounce(sync, 60, 300);

  /** The extension was reloaded/updated under us: stop and leave the page clean. */
  function teardown() {
    deactivate();
    clearPage();
  }

  // --- wiring ---------------------------------------------------------------------------------------------

  function init() {
    // Primary signal on current GitHub: Navigation API fires for Turbo/pushState navigations.
    if (globalThis.navigation && typeof globalThis.navigation.addEventListener === 'function') {
      globalThis.navigation.addEventListener('currententrychange', syncSoon);
    }
    // Fallbacks / belt and braces (cheap; sync() is idempotent).
    for (const type of ['turbo:load', 'turbo:render', 'turbo:frame-render', 'turbo:frame-load', 'pjax:end']) {
      document.addEventListener(type, syncSoon);
    }
    window.addEventListener('popstate', syncSoon);
    window.addEventListener('pageshow', syncSoon); // back/forward cache restores
    // Turbo snapshots the outgoing page for its own back/forward cache. A cloned
    // banner would have dead buttons (listeners aren't cloned) and stale marks,
    // so clean up first; sync() re-activates if we are still on a files page.
    document.addEventListener('turbo:before-cache', () => {
      deactivate();
      syncSoon();
    });

    // Live updates: popup changes (and other devices) arrive here, in every open tab.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes[storage.STORAGE_KEY]) return;
      if (!contextValid()) return teardown();
      applySettings(storage.normalize(changes[storage.STORAGE_KEY].newValue));
      if (state.active) {
        state.reevaluate = true;
        flush(); // immediate, not debounced: the user is watching the page
      }
    });

    // Popup asks for the hidden count of the active tab.
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== 'pff:getStatus') return;
      sendResponse({
        onFilesPage: state.active,
        filtering: !!(state.settings && state.settings.enabled),
        hiddenCount: state.hiddenCount,
        revealed: state.revealed,
      });
    });

    sync();
  }

  // For debugging from DevTools (pick this extension's context in the console).
  NS.debug = () => ({
    active: state.active,
    pr: state.prKey,
    filters: state.filters.map((f) => f.pattern),
    revealed: state.revealed,
    records: records.size,
    hidden: hiddenFiles().map((f) => ({ path: f.path, oldPath: f.oldPath, pattern: f.pattern })),
    selectors: SELECTORS,
  });

  try {
    init();
  } catch (err) {
    console.warn(`${LOG} failed to start:`, err);
  }
})();
