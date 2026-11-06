/*
 * GitHub Advanced Viewer - "conversation noise" helpers.
 *
 * Pure functions, no DOM access, so they can be unit-tested in Node. Same
 * loading scheme as matcher.js (classic <script> -> globalThis.PRFilesFilter,
 * or require() in Node). The DOM walking lives in src/conversation.js; this file
 * only holds the decisions that can be made from plain strings.
 *
 * What counts as noise on a PR's Conversation tab:
 *   resolved - review threads GitHub marks resolved
 *   bots     - reviews / comments written only by GitHub Apps (claude, Copilot,
 *              dependabot, github-actions, ...); never their unresolved review threads
 *   events   - timeline rows such as "marked this pull request as draft",
 *              "requested review from ...", "Copilot started reviewing ...",
 *              "changed the title", label / assignee changes
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    const ns = (root.PRFilesFilter = root.PRFilesFilter || {});
    ns.noise = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const CATEGORIES = ['resolved', 'bots', 'events'];

  // Timeline rows that carry information a reviewer needs, so they are never
  // hidden. Everything else with a badge icon is noise. Keyed by the octicon name
  // on the row's badge (stable across GitHub's wording changes).
  const KEPT_EVENT_ICONS = new Set([
    'git-commit', // commits pushed to the PR
    'git-merge', // merged
    'git-pull-request-closed', // closed
    'git-pull-request', // reopened
    'repo-push', // force-pushed: the history changed under the reviewer
  ]);

  // Every GitHub App (and Copilot) links its name to /apps/<slug>. Real users
  // link to /<login>. Only Apps are treated as bots: an ordinary account used
  // as a bot cannot be told apart from a person.
  const APP_HREF = /^(?:https:\/\/github\.com)?\/apps\/[^/?#]+/;

  /** "octicon octicon-git-merge color-fg-done" -> "git-merge" ('' if none). */
  function iconName(classText) {
    const m = /(?:^|\s)octicon-([a-z0-9-]+)/.exec(typeof classText === 'string' ? classText : '');
    return m ? m[1] : '';
  }

  /** Is a timeline row with this badge icon noise? Rows with no known icon are left alone. */
  function isNoiseEventIcon(icon) {
    return typeof icon === 'string' && icon !== '' && !KEPT_EVENT_ICONS.has(icon);
  }

  /** Does this author link point at a GitHub App? */
  function isBotHref(href) {
    return typeof href === 'string' && APP_HREF.test(href);
  }

  /**
   * True only when there is at least one author and every one is a GitHub App.
   * A single human anywhere (a reply, a review comment) makes the whole thing
   * worth reading, and an empty list means "unknown", never "all bots".
   */
  function isBotOnly(hrefs) {
    return Array.isArray(hrefs) && hrefs.length > 0 && hrefs.every(isBotHref);
  }

  const LABELS = {
    resolved: ['resolved thread', 'resolved threads'],
    bots: ['bot comment', 'bot comments'],
    events: ['timeline event', 'timeline events'],
  };

  /**
   * { resolved, bots, events } counts -> { total, parts: ['3 resolved threads', ...], text }
   * `text` joins the non-zero parts with " · " ('' when nothing is hidden).
   */
  function summarize(counts) {
    const parts = [];
    let total = 0;
    for (const key of CATEGORIES) {
      const n = counts && Number.isInteger(counts[key]) && counts[key] > 0 ? counts[key] : 0;
      if (!n) continue;
      total += n;
      parts.push(`${n.toLocaleString('en-US')} ${LABELS[key][n === 1 ? 0 : 1]}`);
    }
    return { total, parts, text: parts.join(' · ') };
  }

  return { CATEGORIES, KEPT_EVENT_ICONS, iconName, isNoiseEventIcon, isBotHref, isBotOnly, summarize };
});
