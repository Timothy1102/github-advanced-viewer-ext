/*
 * PR Files Filter - gitignore-style glob matcher.
 *
 * Works in three places without a build step:
 *   - content script / popup: listed as a classic <script>; attaches to
 *     globalThis.PRFilesFilter.matcher
 *   - service worker: importScripts('matcher.js'), same global
 *   - Node (unit tests): require('./matcher.js')
 *
 * Syntax (see README for the full table):
 *   *      any run of characters inside one path segment (never '/')
 *   **     as a whole segment: zero or more directories ("a/**" + "/b").
 *          A trailing "/**" needs at least one more segment.
 *   ?      exactly one character (never '/')
 *   \x     escape: matches x literally (so "\*" is a literal asterisk)
 *   /      a pattern without '/' is matched against the basename at any
 *          depth; a pattern with '/' (leading or middle) is matched against
 *          the whole path from the repo root
 *   x/     trailing slash: the directory x and everything below it
 *   /x     leading slash: anchor to the repo root
 * Everything else is a literal, including [ ] { } ( ) + ^ $ | and '.'.
 * Matching is case-sensitive. '!' negation is not supported.
 *
 * Why not compile to a RegExp? Backtracking regexes can take exponential or
 * high-polynomial time on patterns like "*a*a*a*a*b". This matcher works
 * segment by segment with a memoised walk over '**' and a linear two-pointer
 * glob for '*'/'?', so worst-case time is bounded by pattern length x path
 * length no matter what the user types.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  } else {
    const ns = (root.PRFilesFilter = root.PRFilesFilter || {});
    ns.matcher = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const MAX_PATTERN_LENGTH = 256;
  const MAX_SEGMENTS = 32;

  // Segment tokens: a one-code-point string is a literal; these are wildcards.
  const STAR = 0; // '*'
  const ANY = 1; // '?'
  // Whole-segment '**' marker (distinct from any compiled segment array).
  const GLOBSTAR = { globstar: true };

  const fail = (error) => ({ ok: false, error });

  /** Compile one path-segment glob into a token array. Never throws. */
  function compileSegment(part) {
    const chars = Array.from(part); // code points, so '?' matches an emoji
    const tokens = [];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === '\\' && i + 1 < chars.length) {
        tokens.push(chars[++i]); // escaped: literal, even if it is * or ?
      } else if (ch === '*') {
        // Runs of '*' inside a segment behave like one '*' (gitignore rule).
        if (tokens[tokens.length - 1] !== STAR) tokens.push(STAR);
      } else if (ch === '?') {
        tokens.push(ANY);
      } else {
        tokens.push(ch);
      }
    }
    return tokens;
  }

  /**
   * Compile a pattern. Returns { ok: true, pattern, anchored, segs } or
   * { ok: false, error }. Never throws, whatever the input.
   */
  function compile(rawPattern) {
    if (typeof rawPattern !== 'string') return fail('Pattern must be text.');
    const pattern = rawPattern.trim();
    if (!pattern) return fail('Pattern is empty.');
    if (pattern.length > MAX_PATTERN_LENGTH) {
      return fail(`Pattern is too long (max ${MAX_PATTERN_LENGTH} characters).`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(pattern)) return fail('Pattern contains control characters.');
    if (pattern[0] === '!') return fail('Negation ("!") is not supported.');

    let body = pattern;
    const rooted = body[0] === '/';
    if (rooted) body = body.replace(/^\/+/, '');
    const dirOnly = body.endsWith('/');
    if (dirOnly) body = body.replace(/\/+$/, '');

    const parts = body.split('/').filter((s) => s !== ''); // "a//b" == "a/b"
    if (parts.length === 0) return fail('Pattern needs a file or directory name.');
    if (parts.length > MAX_SEGMENTS) {
      return fail(`Pattern has too many path segments (max ${MAX_SEGMENTS}).`);
    }

    // A pattern is matched against the full path if it has a '/' at the start
    // or in the middle; a trailing '/' alone does not anchor it (gitignore).
    const anchored = rooted || parts.length > 1;

    let segs;
    if (!anchored && parts[0] === '**') {
      segs = [compileSegment('*')]; // lone "**" == "*" (basename, any depth)
    } else {
      segs = [];
      for (const part of parts) {
        if (part === '**') {
          if (segs[segs.length - 1] !== GLOBSTAR) segs.push(GLOBSTAR);
        } else {
          segs.push(compileSegment(part));
        }
      }
    }

    // "x/" == "**/x/**" (any depth) ; "a/b/" == "a/b/**" (anchored).
    if (dirOnly) {
      if (!anchored) segs.unshift(GLOBSTAR);
      if (segs[segs.length - 1] !== GLOBSTAR) segs.push(GLOBSTAR);
    }

    return { ok: true, pattern, anchored: anchored || dirOnly, segs };
  }

  /** Linear-time glob for a single segment ('*' and '?' only). */
  function matchSegment(tokens, str) {
    const s = Array.from(str);
    const n = s.length;
    const m = tokens.length;
    let p = 0;
    let i = 0;
    let star = -1;
    let mark = 0;
    while (i < n) {
      const tok = p < m ? tokens[p] : undefined;
      if (tok === ANY || (typeof tok === 'string' && tok === s[i])) {
        p++;
        i++;
      } else if (tok === STAR) {
        star = p++;
        mark = i;
      } else if (star !== -1) {
        p = star + 1;
        i = ++mark;
      } else {
        return false;
      }
    }
    while (p < m && tokens[p] === STAR) p++;
    return p === m;
  }

  /** Match compiled segments against path segments (memoised, no regex). */
  function matchSegments(segs, pathSegs) {
    const P = segs.length;
    const S = pathSegs.length;
    const memo = new Uint8Array((P + 1) * (S + 1)); // 0 unknown, 1 yes, 2 no
    function go(pi, si) {
      const k = pi * (S + 1) + si;
      if (memo[k]) return memo[k] === 1;
      let result;
      if (pi === P) {
        result = si === S;
      } else if (segs[pi] === GLOBSTAR) {
        if (pi === P - 1) {
          result = si < S; // trailing "/**": at least one more segment
        } else {
          result = false;
          for (let j = si; j <= S && !result; j++) result = go(pi + 1, j);
        }
      } else {
        result = si < S && matchSegment(segs[pi], pathSegs[si]) && go(pi + 1, si + 1);
      }
      memo[k] = result ? 1 : 2;
      return result;
    }
    return go(0, 0);
  }

  // --- compiled-pattern cache -------------------------------------------
  const cache = new Map();
  const CACHE_LIMIT = 500;
  function compileCached(pattern) {
    let c = cache.get(pattern);
    if (!c) {
      if (cache.size >= CACHE_LIMIT) cache.clear();
      c = compile(pattern);
      cache.set(pattern, c);
    }
    return c;
  }

  const splitPath = (p) => String(p).split('/').filter((s) => s !== '');

  /** { ok: true } or { ok: false, error } - used by the popup for messages. */
  function validatePattern(pattern) {
    const c = compile(pattern);
    return c.ok ? { ok: true } : { ok: false, error: c.error };
  }

  /** Run a compiled pattern against an already-split path. */
  function matchCompiled(c, pathSegs) {
    if (!c.anchored) return matchSegment(c.segs[0], pathSegs[pathSegs.length - 1]);
    return matchSegments(c.segs, pathSegs);
  }

  /** Does one pattern match one path? Invalid patterns never match. */
  function matchesPattern(pattern, path) {
    if (typeof path !== 'string' || path === '') return false;
    const c = compileCached(pattern);
    if (!c.ok) return false;
    const pathSegs = splitPath(path);
    return pathSegs.length > 0 && matchCompiled(c, pathSegs);
  }

  /**
   * First enabled filter that matches any of the given paths, or null.
   * `paths` is a string or an array (pass [oldPath, newPath] for renames).
   * `filters` items are { pattern, enabled } objects or bare pattern strings.
   * Disabled and invalid filters are skipped; this never throws.
   */
  function matchingFilter(paths, filters) {
    if (!Array.isArray(filters) || filters.length === 0) return null;
    // Split each path once, not once per filter (this runs for every file in a PR).
    const splits = [];
    for (const p of Array.isArray(paths) ? paths : [paths]) {
      if (typeof p !== 'string' || p === '') continue;
      const segs = splitPath(p);
      if (segs.length > 0) splits.push(segs);
    }
    if (splits.length === 0) return null;
    for (const f of filters) {
      const filter = typeof f === 'string' ? { pattern: f, enabled: true } : f;
      if (!filter || typeof filter.pattern !== 'string' || filter.enabled === false) continue;
      try {
        const c = compileCached(filter.pattern);
        if (!c.ok) continue;
        for (const segs of splits) if (matchCompiled(c, segs)) return filter;
      } catch (_) {
        // Defensive: a bug must never break the host page. Skip the filter.
      }
    }
    return null;
  }

  const isHidden = (paths, filters) => matchingFilter(paths, filters) !== null;

  return {
    MAX_PATTERN_LENGTH,
    compile,
    validatePattern,
    matchesPattern,
    matchingFilter,
    isHidden,
  };
});
