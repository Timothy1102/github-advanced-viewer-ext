/*
 * GitHub Advanced Viewer - Conversation tab noise (content script, github.com/*).
 *
 * Load order (manifest): matcher.js, storage.js, diffstat.js, content.js, noise.js,
 * conversation.js - they share globalThis.PRFilesFilter. content.js handles the
 * Files changed tab; this file handles the Conversation tab
 * (https://github.com/<owner>/<repo>/pull/<n>) and is idle everywhere else.
 *
 * What it does: marks three kinds of noise with data-pff-noise="<category>"
 * (CSS in content.css hides them with `display: none !important`; GitHub's nodes
 * are never removed) and shows a small pill that always says how many items are
 * hidden and toggles them. The toggle is persisted (settings.hideNoise), so every
 * PR tab follows it.
 *
 *   resolved  review threads marked resolved
 *   bots      bot-only reviews with no unresolved thread, bot issue comments
 *   events    timeline rows: draft / ready for review, review requested,
 *             "Copilot started reviewing", title changes, labels, ...
 *
 * DOM facts below were verified against a live github.com PR page:
 *   - the timeline is `.js-discussion`; each entry is a `.js-timeline-item`. The PR
 *     description is NOT one (it is the first child of `.js-discussion`), so it is
 *     never touched, even when a bot opened the PR.
 *   - review:   .js-comment#pullrequestreview-<id>, whose direct children are
 *       `.TimelineItem` blocks: [0] header ("<author> reviewed"; badge icon `eye`),
 *       then an optional body, then one block per inline thread.
 *   - thread:   .js-resolvable-timeline-thread-container[data-resolved="true|false"].
 *       Resolved threads load their comments lazily (an <include-fragment>), so a
 *       resolved thread is hidden without ever reading its comments.
 *   - comment:  [id^="issuecomment-"] inside a `.js-comment-container` block.
 *   - event:    `.TimelineItem` rows with a `.TimelineItem-badge svg.octicon-<name>`;
 *       the icon says what happened (eye, git-branch, pencil, ...). Commits are
 *       `git-commit` and merge / close / reopen / force-push are kept (noise.js).
 *   - author:   `a.author`. GitHub Apps (claude, aikido, Copilot, dependabot, ...) link
 *       to /apps/<slug>; people link to /<login>. The "Bot" label is NOT used:
 *       Copilot's reviews do not carry one.
 */
(() => {
  'use strict';

  const LOG = '[GitHub Advanced Viewer]';
  const NS = globalThis.PRFilesFilter;
  if (!NS || !NS.storage || !NS.noise) {
    console.warn(`${LOG} shared scripts did not load; conversation noise is off.`);
    return;
  }
  const { storage, noise } = NS;

  // All GitHub-specific knowledge lives here. If GitHub changes its markup, this is
  // the only object that should need editing.
  const SELECTORS = {
    // /<owner>/<repo>/pull/<n> only: not /files, /commits or /checks.
    conversationPath: /^\/([^/]+\/[^/]+\/pull\/\d+)\/?$/,
    timeline: '.js-discussion',
    timelineItem: '.js-discussion .js-timeline-item',
    review: '.js-comment[id^="pullrequestreview-"]',
    issueComment: '[id^="issuecomment-"]',
    block: '.TimelineItem',
    badgeIcon: '.TimelineItem-badge svg',
    thread: '.js-resolvable-timeline-thread-container',
    threadResolvedAttr: 'data-resolved',
    author: 'a.author',
    // A row containing any of these is a comment, never an "event", whatever its icon.
    commentLike: '.timeline-comment, .comment-body, .js-comment-container, .review-thread-component',
    // A plain "<author> reviewed" header (no approval / change request) has this icon.
    plainReviewIcon: 'eye',
  };

  const ATTR_NOISE = 'data-pff-noise'; // value = category, or EMPTY for a wrapper whose contents are all hidden
  const ATTR_SHOWN = 'data-pff-noise-shown'; // on <html> while noise is visible
  const PILL_ID = 'pff-noise-pill';
  const EMPTY = 'empty'; // wrapper only: counts nothing itself (its hidden children are counted)

  const state = {
    active: false, // are we on a PR conversation page and doing work?
    prKey: '',
    settings: null, // normalized settings (loaded lazily)
    observer: null,
    marked: new Map(), // element -> category, as of the last scan
    counts: { resolved: 0, bots: 0, events: 0 },
    linkReveal: false, // a permalink points into hidden noise: show it, this page view only
    pendingHash: '', // permalink id still to be looked up
    lastLocation: '',
    pill: null,
    pillMsg: null,
    pillAction: null,
    flushRaf: 0,
    flushTimer: 0,
  };

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
    return () => {
      const now = Date.now();
      if (!timer) started = now;
      else clearTimeout(timer);
      timer = setTimeout(() => {
        timer = 0;
        fn();
      }, Math.max(0, Math.min(wait, started + maxWait - now)));
    };
  }

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }

  const setText = (el, text) => {
    if (el.textContent !== text) el.textContent = text;
  };

  // --- settings --------------------------------------------------------------------

  const isShown = () => !!(state.settings && !state.settings.hideNoise) || state.linkReveal;

  function applyVisibility() {
    document.documentElement.toggleAttribute(ATTR_SHOWN, state.active && isShown());
  }

  function applySettings(settings) {
    state.settings = settings;
    if (state.active) {
      applyVisibility();
      renderPill();
    }
  }

  async function ensureSettings() {
    if (state.settings) return;
    const loaded = await storage.load(); // falls back to defaults on missing/corrupt data
    if (!state.settings) state.settings = loaded; // a storage change may have landed first: keep it
  }

  // --- classifying timeline items ----------------------------------------------------

  const iconOf = (block) => {
    const svg = block.querySelector(SELECTORS.badgeIcon);
    return noise.iconName(svg && svg.getAttribute('class'));
  };

  /** hrefs of every author link under `scope`, skipping those inside any `excluded` element. */
  function authorHrefs(scope, excluded = []) {
    const out = [];
    for (const a of scope.querySelectorAll(SELECTORS.author)) {
      if (excluded.some((e) => e.contains(a))) continue;
      out.push(a.getAttribute('href') || '');
    }
    return out;
  }

  /**
   * A review: hide resolved threads; hide the whole review when only bots took
   * part and no unresolved thread remains. `marks` receives element -> category.
   */
  function evaluateReview(item, root, marks) {
    const threads = [...item.querySelectorAll(SELECTORS.thread)].map((el) => {
      // Hide the thread's own `.TimelineItem` block (a direct child of the review) so its
      // frame goes with it; if the markup is not what we verified, hide just the thread.
      let wrapper = el.closest(SELECTORS.block);
      if (!wrapper || wrapper.parentElement !== root || wrapper.querySelectorAll(SELECTORS.thread).length !== 1) {
        wrapper = el;
      }
      const hrefs = authorHrefs(el);
      const resolved = el.getAttribute(SELECTORS.threadResolvedAttr) === 'true';
      // Unresolved threads are never noise, whoever wrote them: they still need an answer.
      const category = resolved ? 'resolved' : null;
      return { wrapper, hrefs, category };
    });

    const hiddenWrappers = threads.filter((t) => t.category).map((t) => t.wrapper);
    // A bot review is hidden only when no unresolved thread is left in it.
    const hasOpenThread = threads.some((t) => !t.category);
    if (!hasOpenThread && noise.isBotOnly(authorHrefs(item, hiddenWrappers))) {
      marks.set(item, 'bots');
      return;
    }

    for (const t of threads) if (t.category) marks.set(t.wrapper, t.category);

    // "<author> reviewed" with every thread hidden and no body would be an empty header.
    const blocks = [...root.children].filter((c) => c.matches(SELECTORS.block));
    const rest = blocks.slice(1);
    if (rest.length && rest.every((b) => marks.has(b)) && iconOf(blocks[0]) === SELECTORS.plainReviewIcon) {
      marks.set(item, EMPTY);
    }
  }

  /** A plain comment: noise only when a GitHub App wrote it. */
  function evaluateComment(item, marks) {
    if (noise.isBotOnly(authorHrefs(item))) marks.set(item, 'bots');
  }

  /** Everything else is a run of event rows (draft, review requested, ...) or commits. */
  function evaluateEvents(item, marks) {
    const blocks = [...item.querySelectorAll(SELECTORS.block)].filter((b) => !b.parentElement.closest(SELECTORS.block));
    if (!blocks.length) return;
    let allNoise = true;
    for (const b of blocks) {
      const isComment = b.matches(SELECTORS.commentLike) || b.querySelector(SELECTORS.commentLike);
      if (!isComment && noise.isNoiseEventIcon(iconOf(b))) marks.set(b, 'events');
      else allNoise = false;
    }
    if (allNoise) marks.set(item, EMPTY);
  }

  /** Re-decide every timeline item, write the marks, and recount. Cheap: a few hundred nodes at most. */
  function scan() {
    const next = new Map();
    const counts = { resolved: 0, bots: 0, events: 0 };
    for (const item of document.querySelectorAll(SELECTORS.timelineItem)) {
      const marks = new Map();
      const review = item.querySelector(SELECTORS.review);
      if (review) evaluateReview(item, review, marks);
      else if (item.querySelector(SELECTORS.issueComment)) evaluateComment(item, marks);
      else evaluateEvents(item, marks);

      // A hidden item counts once; an EMPTY wrapper counts what it holds.
      const own = marks.get(item);
      if (own && own !== EMPTY) counts[own]++;
      else for (const [el, category] of marks) if (el !== item) counts[category]++;
      for (const [el, category] of marks) next.set(el, category);
    }
    for (const [el, category] of next) if (el.getAttribute(ATTR_NOISE) !== category) el.setAttribute(ATTR_NOISE, category);
    for (const el of state.marked.keys()) if (!next.has(el)) el.removeAttribute(ATTR_NOISE);
    state.marked = next;
    state.counts = counts;
  }

  /**
   * A link like #pullrequestreview-123 or #discussion_r456 that lands inside hidden
   * noise would otherwise show a blank page: show the noise for this page view.
   */
  function revealPermalink() {
    if (!state.pendingHash) return;
    let id = state.pendingHash;
    try {
      id = decodeURIComponent(id);
    } catch (_) {
      /* keep the raw id */
    }
    const target = document.getElementById(id);
    if (!target) return; // not rendered yet: look again on the next flush
    state.pendingHash = '';
    if (target.closest(`[${ATTR_NOISE}]`)) state.linkReveal = true;
  }

  // --- the pill -------------------------------------------------------------------------

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
    // Octicons "eye".
    path.setAttribute(
      'd',
      'M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z'
    );
    svg.append(path);
    return svg;
  }

  function ensurePill() {
    if (state.pill && state.pill.isConnected) return state.pill;
    state.pillMsg = h('span', { class: 'pff-noise-msg' });
    state.pillAction = h('span', { class: 'pff-noise-action' });
    const pill = h('button', { id: PILL_ID, type: 'button', class: 'pff-noise-pill' }, buildIcon(), state.pillMsg, state.pillAction);
    pill.addEventListener('click', toggle);
    document.body.append(pill);
    state.pill = pill;
    return pill;
  }

  function removePill() {
    if (state.pill) state.pill.remove();
    const stray = document.getElementById(PILL_ID);
    if (stray) stray.remove();
    state.pill = state.pillMsg = state.pillAction = null;
  }

  /** The pill exists only while something is hidden or revealed; it says how much, always. */
  function renderPill() {
    const { total, text } = noise.summarize(state.counts);
    if (!state.active || total === 0) return removePill();
    const pill = ensurePill();
    const shown = isShown();
    const noun = total === 1 ? 'item' : 'items';
    setText(state.pillMsg, shown ? `Showing ${total} noise ${noun}` : `${total} noise ${noun} hidden`);
    setText(state.pillAction, shown ? 'Hide' : 'Show');
    const label = `${shown ? 'Hide' : 'Show'} noise: ${text}`;
    pill.setAttribute('title', label);
    pill.setAttribute('aria-label', label);
  }

  /** Show / hide all noise. Applied at once, then saved so every PR tab follows. */
  async function toggle() {
    const hide = isShown(); // currently visible -> hide it, and the other way round
    state.linkReveal = false;
    state.settings = { ...(state.settings || storage.defaultSettings()), hideNoise: hide };
    applyVisibility();
    renderPill();
    const res = await storage.update((s) => storage.setHideNoise(s, hide));
    if (!res || !res.ok) console.warn(`${LOG} could not save the noise toggle:`, res && res.error);
  }

  // --- scheduling ---------------------------------------------------------------------------

  function flush() {
    if (!state.active) return;
    if (!contextValid()) return teardown(); // extension reloaded under us: leave the page clean
    if (!state.settings) return; // activate() flushes once settings have loaded
    scan();
    revealPermalink();
    applyVisibility();
    renderPill();
  }

  /**
   * One flush per frame. requestAnimationFrame runs BEFORE the next paint, so a
   * lazily added noise item is hidden before it is ever drawn; the timer is the
   * fallback for background tabs, where rAF is paused.
   */
  function flushSoon() {
    if (state.flushRaf || state.flushTimer) return;
    const run = () => {
      cancelFlush();
      flush();
    };
    state.flushRaf = requestAnimationFrame(run);
    state.flushTimer = setTimeout(run, 250);
  }

  function cancelFlush() {
    cancelAnimationFrame(state.flushRaf);
    clearTimeout(state.flushTimer);
    state.flushRaf = 0;
    state.flushTimer = 0;
  }

  /**
   * Anything added to OR removed from the timeline can change what is hidden or how
   * many items there are (a deleted comment must drop out of the pill's count), and
   * a removed node is gone, so look at where the change happened (`target`). A whole
   * page section swapped in by Turbo is caught by the added-node check. Changes
   * outside the timeline (our own pill, tooltips, popovers) are ignored.
   */
  function touchesTimeline(m) {
    if (m.target.nodeType === 1 && m.target.closest(SELECTORS.timeline)) return true;
    for (const node of m.addedNodes) {
      if (node.nodeType === 1 && node.id !== PILL_ID && node.querySelector(SELECTORS.timeline)) return true;
    }
    return false;
  }

  function onMutations(mutations) {
    if (!state.active) return;
    if (mutations.some(touchesTimeline)) flushSoon();
  }

  // --- activation / navigation ------------------------------------------------------------------

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

  /** Remove everything we added to the page. Safe to call repeatedly. */
  function clearPage() {
    cancelFlush();
    for (const el of state.marked.keys()) el.removeAttribute(ATTR_NOISE);
    state.marked.clear();
    state.counts = { resolved: 0, bots: 0, events: 0 };
    state.linkReveal = false;
    state.pendingHash = '';
    removePill();
    document.documentElement.removeAttribute(ATTR_SHOWN);
  }

  function deactivate() {
    if (!state.active) return;
    state.active = false;
    state.prKey = '';
    stopObserver();
    clearPage();
  }

  async function activate(prKey) {
    if (state.active) clearPage(); // moved to a different PR
    state.active = true;
    state.prKey = prKey;
    state.pendingHash = location.hash.slice(1);
    startObserver();
    await ensureSettings();
    if (!state.active || state.prKey !== prKey) return; // navigated away while loading
    flush();
  }

  /** Re-check the URL and start/stop work accordingly. */
  function sync() {
    if (!contextValid()) return teardown();
    const match = SELECTORS.conversationPath.exec(location.pathname);
    if (!match) return deactivate();
    const here = location.pathname + location.search;
    if (state.active && state.prKey === match[1]) {
      // Same PR: Turbo may have swapped the timeline under us, so look again.
      if (here !== state.lastLocation) {
        state.lastLocation = here;
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

  // --- wiring ---------------------------------------------------------------------------------------

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
    window.addEventListener('hashchange', () => {
      if (!state.active) return;
      state.pendingHash = location.hash.slice(1);
      flushSoon();
    });
    // Turbo snapshots the outgoing page for its own back/forward cache. A cloned
    // pill would have a dead button (listeners aren't cloned), so clean up first;
    // sync() re-activates if we are still on a conversation page.
    document.addEventListener('turbo:before-cache', () => {
      deactivate();
      syncSoon();
    });

    // Live updates: the popup, another tab's pill, or another device.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes[storage.STORAGE_KEY]) return;
      if (!contextValid()) return teardown();
      applySettings(storage.normalize(changes[storage.STORAGE_KEY].newValue));
    });

    // Popup asks for the hidden count of the active tab.
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || message.type !== 'pff:getNoiseStatus') return;
      sendResponse({
        onConversationPage: state.active,
        hideNoise: !!(state.settings && state.settings.hideNoise),
        shown: state.active && isShown(),
        counts: { ...state.counts },
      });
    });

    sync();
  }

  // For debugging from DevTools (pick this extension's context in the console).
  NS.debugNoise = () => ({
    active: state.active,
    pr: state.prKey,
    hideNoise: state.settings && state.settings.hideNoise,
    shown: isShown(),
    counts: { ...state.counts },
    marked: [...state.marked].map(([el, category]) => ({ category, id: el.id || '', text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) })),
    selectors: SELECTORS,
  });

  try {
    init();
  } catch (err) {
    console.warn(`${LOG} conversation noise failed to start:`, err);
  }
})();
