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

  const sum = (files) => {
    const t = { additions: 0, deletions: 0 };
    let unknown = 0;
    for (const f of files) {
      if (f && f.stats) {
        t.additions += f.stats.additions;
        t.deletions += f.stats.deletions;
      } else unknown++;
    }
    return { sum: t, unknown };
  };

  /**
   * Combine the files the filters hide / keep (lists of { stats | null }) with the
   * optional PR total. `shown` is summed from the visible files' own counts
   * (reliable, independent of GitHub's toolbar); only when `shownFiles` is not
   * given does it fall back to total - hidden. Files without counts (not loaded
   * yet, binary, ...) are tallied in `unknownHidden` / `unknownShown`, never guessed.
   * Returns { total, hidden, shown, unknownHidden, unknownShown }.
   */
  function summarize(total, hiddenFiles, shownFiles) {
    const h = sum(hiddenFiles);
    let shown = null;
    let unknownShown = 0;
    if (shownFiles) {
      const s = sum(shownFiles);
      shown = s.sum;
      unknownShown = s.unknown;
    } else if (total) {
      shown = {
        additions: Math.max(0, total.additions - h.sum.additions),
        deletions: Math.max(0, total.deletions - h.sum.deletions),
      };
    }
    return { total: total || null, hidden: h.sum, shown, unknownHidden: h.unknown, unknownShown };
  }

  return { parseFileStats, parseTotalStats, summarize };
});
