/*
 * GitHub Advanced Viewer - line-count ("diffstat") helpers.
 *
 * Pure functions, no DOM access, so they can be unit-tested in Node. Same
 * loading scheme as matcher.js (classic <script> -> globalThis.PRFilesFilter,
 * or require() in Node).
 *
 * Texts these parse (verified against live github.com PR pages):
 *   per file  (screen-reader span in the file header):
 *       "342 changes: 173 additions & 169 deletions"
 *   PR total  (#diffstat in the Files changed toolbar; U+2212 minus sign):
 *       "+183 −173"
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    const ns = (root.PRFilesFilter = root.PRFilesFilter || {});
    ns.diffstat = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const toInt = (s) => parseInt(String(s).replace(/,/g, ''), 10);

  /** "173 additions & 169 deletions" -> { additions, deletions } | null */
  function parseFileStats(text) {
    if (typeof text !== 'string') return null;
    const m = /(\d[\d,]*)\s+additions?\s*(?:&|and)\s*(\d[\d,]*)\s+deletions?/i.exec(text);
    return m ? { additions: toInt(m[1]), deletions: toInt(m[2]) } : null;
  }

  /** "+183 −173" (also ASCII "-" or en dash) -> { additions, deletions } | null */
  function parseTotalStats(text) {
    if (typeof text !== 'string') return null;
    const add = /\+\s*(\d[\d,]*)/.exec(text);
    const del = /[−–‒-]\s*(\d[\d,]*)/.exec(text);
    if (!add || !del) return null;
    return { additions: toInt(add[1]), deletions: toInt(del[1]) };
  }

  /**
   * Combine the PR total with the files the filters hide.
   * `hiddenFiles` is a list of { stats: {additions, deletions} | null }.
   * Returns { total, hidden, shown, unknownHidden } where `unknownHidden` counts
   * hidden files whose line counts were unavailable (diff not loaded yet,
   * binary file, ...): they are NOT part of `hidden`, so `shown` may be
   * slightly overstated while that number is non-zero.
   * `total` is null when unavailable; `shown` is then null too.
   */
  function summarize(total, hiddenFiles) {
    const hidden = { additions: 0, deletions: 0 };
    let unknownHidden = 0;
    for (const f of hiddenFiles) {
      if (f && f.stats) {
        hidden.additions += f.stats.additions;
        hidden.deletions += f.stats.deletions;
      } else {
        unknownHidden++;
      }
    }
    const shown = total
      ? {
          additions: Math.max(0, total.additions - hidden.additions),
          deletions: Math.max(0, total.deletions - hidden.deletions),
        }
      : null;
    return { total: total || null, hidden, shown, unknownHidden };
  }

  return { parseFileStats, parseTotalStats, summarize };
});
