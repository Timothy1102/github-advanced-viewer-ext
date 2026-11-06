# GitHub Advanced Viewer

A Chrome extension (Manifest V3) that hides files on GitHub's pull request **Files changed** tab based on filename filters you control. It is meant for reviewing AI-generated PRs, where much of the diff is noise: by default it hides tests, snapshots, Storybook stories, lockfiles, and generated/build output (full list in `DEFAULT_PATTERNS` in `src/storage.js`; edit it in the popup).

Hiding is never silent: a banner at the top of the diff area always says how many files are hidden, lets you list them, and lets you reveal them with one click.

It does the same for a pull request's **Conversation** tab: resolved review threads, comments and reviews written by bots (claude, Copilot, dependabot, github-actions, ...), and timeline status rows ("marked this pull request as draft", "requested review from ...", "Copilot started reviewing on behalf of ...") are hidden, and a small button in the corner shows how many and toggles them.

- Vanilla JavaScript, **no build step, no dependencies**
- Permissions: `storage` only (plus a content script on `https://github.com/*`)
- Settings sync through `chrome.storage.sync`
- Chrome 105 or newer

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Open any pull request's **Files changed** tab. Noise files (tests, snapshots, lockfiles, ...) are hidden and a banner appears.

After editing the source, click the reload icon on the extension's card in `chrome://extensions`, then reload the GitHub tab.

## Using it

**Banner** (on the Files changed tab, only when something is hidden):

```
[≡]  3 files hidden by GitHub Advanced Viewer      [Show]  [List ▾]
     Lines changed: All +782 −4 · After filters +300 −1 · Hidden +482 −3
```

- **Lines changed** shows GitHub's PR total (**All**), what is left once the filters are applied (**After filters**), and what the filters hid (**Hidden**). *After filters* is the PR total minus the hidden files' own counts, read from each file's header.
- Hidden files whose line counts are unavailable (binary files, or a diff GitHub hasn't rendered yet) are not subtracted; the banner says how many there are, so *After filters* is then slightly overstated.

- **Show** reveals the hidden files for this page view only (nothing is saved) and the button becomes **Hide again**. Revealed files get a dashed outline so you can tell them apart.
- **List ▾** expands the list of hidden paths, with the pattern that matched each one (and the old name for renamed files).
- If nothing matches, there is no banner.

**Conversation noise** (on a pull request's Conversation tab, `github.com/<owner>/<repo>/pull/<n>`, only when something is hidden):

```
[👁  21 noise items hidden  Show]        <- fixed at the bottom-left of the window
```

- The button says how many items are hidden and, on hover, what they are (`2 resolved threads · 14 bot comments · 10 timeline events`). **Show** reveals them (each gets a dashed outline so you can tell them apart) and the button becomes **Hide**.
- Unlike the files banner, this toggle is **remembered**: it is saved in your settings, so every PR tab (and the popup switch) follows it. It starts **on**.
- What counts as noise:

  | Category | Hidden |
  | --- | --- |
  | resolved threads | inline review threads marked **Resolved**. A review left with nothing visible loses its header too |
  | bot comments | reviews and comments written only by GitHub Apps (author links to `/apps/<name>`). A bot review is hidden only when it has no unresolved thread; unresolved threads are always shown, even when only a bot wrote them |
  | timeline events | draft / ready for review, review requested, "Copilot started reviewing", title changes, labels, assignees, and similar rows |

- Never hidden: the PR description (even if a bot opened the PR), commits, human comments and reviews (apart from their resolved threads), and merged / closed / reopened / force-pushed rows.
- A link to something that is hidden (for example `#pullrequestreview-123` from a notification) shows the noise for that page view, so you never land on a blank page. Your saved setting is unchanged.
- The Files changed tab is not affected by this; inline comments there are left alone.

**Popup** (click the toolbar icon):

- **Hide conversation noise** switch: the same setting as the button on the page. Its line shows the hidden counts for the active tab when that tab is a PR Conversation tab.
- Master switch (top right): turns all *file* filtering off without losing your list. It does not affect conversation noise.
- Each filter has an on/off toggle, the pattern, an edit button (or click the pattern; **Enter** saves, **Esc** cancels) and a delete button.
- Type a pattern and press **Enter** or **Add**. Patterns are trimmed; empty, duplicate, and invalid patterns are rejected with an inline message.
- **Reset to defaults** (click twice to confirm) restores the default noise filters (also how existing installs pick up newly added defaults). It leaves the master switch alone.
- **Export / import** copies your filters as JSON, or merges pasted JSON into your list (duplicates and invalid patterns are skipped).
- The line under the title shows how many files are hidden in the active tab, when that tab is a PR files page.

Changes apply immediately to every open GitHub PR tab, no reload needed. Defaults are written only on first install: if you delete one, it stays deleted.

## Pattern syntax

Patterns are gitignore-style globs, matched against the file's full path from the repo root. Matching is **case-sensitive**.

| Pattern | Meaning |
| --- | --- |
| `*` | Any run of characters within one path segment (never crosses `/`) |
| `**` | As a whole segment: zero or more directories. A trailing `/**` needs at least one more segment |
| `?` | Exactly one character (never `/`) |
| no `/` in the pattern | Matched against the **basename at any depth** |
| `/` at the start or middle | Matched against the **full path from the repo root** |
| `dir/` (trailing `/`) | That directory and everything below it |
| `/name` (leading `/`) | Anchored to the repo root |
| `\*` `\?` `\\` | Backslash escapes: matches the character literally |

Everything else is literal, including `.` `+` `(` `)` `[` `]` `{` `}` `^` `$` `|`. So `pages/[id].tsx` matches that exact path (there are no character classes), and `*.spec.ts` only matches a real dot.

`**` that is not a whole segment (like `a**b`) behaves like a single `*`. Negation (`!pattern`) is not supported.

| Pattern | Hides | Does not hide |
| --- | --- | --- |
| `*.spec.ts` | `a.spec.ts`, `src/deep/x.spec.ts` | `a.spec.tsx`, `a.spec.ts.bak` |
| `*.snap` | `a/b/c/foo.test.snap` | `foo.snapshot` |
| `**/__snapshots__/**` | `__snapshots__/a.snap`, `a/b/__snapshots__/c/d.snap` | `a/__snapshots__` (a file by that name) |
| `src/generated/**` | `src/generated/a.ts`, `src/generated/x/y.ts` | `lib/src/generated/a.ts` (anchored) |
| `src/*.ts` | `src/a.ts` | `src/x/a.ts` |
| `a/**/b.ts` | `a/b.ts`, `a/x/y/b.ts` | `x/a/b.ts` |
| `file?.ts` | `file1.ts` | `file.ts`, `file12.ts` |
| `__snapshots__/` | anything under any `__snapshots__` directory | a file named `__snapshots__` |
| `/CHANGELOG.md` | `CHANGELOG.md` at the root | `docs/CHANGELOG.md` |
| `CHANGELOG.md` | `CHANGELOG.md` at any depth | |

**Renamed files** are hidden if **either** the old or the new path matches.

Invalid patterns (for example from imported or synced data) never throw: they are skipped by the filter and flagged in the popup. Matching runs in time proportional to pattern length times path length, so a pattern like `*a*a*a*a*b` cannot freeze a tab (this is why the matcher is not a single regular expression).

## How it works

- `src/content.js` runs on all `https://github.com/*` pages but only acts on `/<owner>/<repo>/pull/<n>/files` (and `/changes`, plus `/files/<range>` sub-paths). Elsewhere it is idle: no MutationObserver, no scanning.
- It finds each changed-file block and each sidebar file-tree entry, and sets `data-pff-hidden="<pattern>"` on matches. `src/content.css` turns that into `display: none !important`. GitHub's nodes are never removed. Folders in the tree whose files are all hidden are collapsed too.
- A `MutationObserver` on the document picks up lazily rendered diffs. Work is coalesced to one pass per animation frame (which runs before paint, so a lazy-loaded diff that should be hidden is never drawn) and processes only the added nodes. Every element is remembered with the filter version it was evaluated against, so repeat processing is a no-op.
- Navigation is detected with the Navigation API's `currententrychange` plus `turbo:*`, `pjax:end`, `popstate` and `pageshow` listeners. See the notes in the header of `src/content.js` for what was verified.
- `src/conversation.js` (same content-script bundle) acts only on `/<owner>/<repo>/pull/<n>`. It walks the timeline (`.js-discussion .js-timeline-item`), sets `data-pff-noise="resolved|bots|events"` on what is noise, and `src/content.css` hides those with `display: none !important`. Showing noise is one attribute on `<html>` (`data-pff-noise-shown`), so the toggle is instant. It uses the same frame-coalesced `MutationObserver` approach; items added or removed anywhere in the timeline trigger a re-scan, so the count stays right. The decisions that need no DOM (is this link a bot? is this icon noise? how to word the count) live in `src/noise.js`, which has unit tests.
- `src/background.js` (service worker) seeds the defaults on `install` only, and never overwrites existing synced settings.
- Settings live in `chrome.storage.sync` under the key `settings`:
  `{ "version": 1, "enabled": true, "hideNoise": true, "filters": [{ "id": "…", "pattern": "*.snap", "enabled": true }] }`.
  `hideNoise` is missing in settings saved by earlier versions and then counts as `true`.
  Missing or corrupt data falls back to the defaults. Chrome limits one synced item to about 8 KB, which is roughly 100 short patterns; hitting it shows a "quota exceeded" message in the popup.

### GitHub's DOM, as verified

These selectors live in the `SELECTORS` object at the top of `src/content.js`. They were checked against real github.com PR pages (classic server-rendered Files changed layout):

- File block: `div.file[data-tagsearch-path]` (id `diff-<sha256>`). For renamed files the attribute holds the **new** path; the header link `a.Link--primary[title]` holds `old → new` (its visible text is ellipsized, so the title is used).
- Sidebar entry: `li[role=treeitem][data-tree-entry-type=file]` with id `file-tree-item-` + the block's id, and a hidden `[data-filterable-item-text]` span holding the path. The tree lists **all** files even before their diffs load, so the banner count is exact immediately.
- Line counts: each file header has a screen-reader span `.file-header .sr-only` reading `N changes: A additions & D deletions`; the PR total is the `#diffstat` element in the toolbar (`+183 −173`, with a U+2212 minus). Parsing lives in `src/diffstat.js`.
- CI annotations on unchanged files render as a `div.file` with no `data-tagsearch-path` and no tree entry. These are deliberately **never hidden**.

**Conversation tab** (checked against a live PR page; selectors are in `SELECTORS` at the top of `src/conversation.js`):

- The timeline is `.js-discussion`; each entry is a `.js-timeline-item`. The PR description is *not* one, so it is never touched.
- Review: `.js-comment#pullrequestreview-<id>`; its direct children are `.TimelineItem` blocks: the header (`<author> reviewed`, badge icon `eye`), an optional body, then one block per inline thread.
- Thread: `.js-resolvable-timeline-thread-container[data-resolved="true|false"]`. Resolved threads load their comments lazily (an `<include-fragment>`), so they are hidden without reading their comments.
- Comment: `[id^="issuecomment-"]`. Event row: a `.TimelineItem` with a badge `svg.octicon-<name>` (`eye`, `git-branch`, `pencil`, `git-pull-request-draft`, ...); commits are `git-commit`.
- Authors are `a.author`. GitHub Apps link to `/apps/<slug>` (claude, aikido-pr-checks, `copilot-pull-request-reviewer`, dependabot, ...), people to `/<login>`. The visible **Bot** label is not used: Copilot's reviews do not carry one.

If GitHub changes the Files changed markup, the extension logs a single warning on the files page:

```
[GitHub Advanced Viewer] No file containers matching "div.file[data-tagsearch-path]" were found on /…/files after 5s. …
```

## Debugging

- **Nothing is hidden / no banner**
  1. Open DevTools on the PR tab and look for a `[GitHub Advanced Viewer]` warning in the Console (selectors no longer match; see above).
  2. In the console, switch the context dropdown (top-left of the Console, normally "top") to **GitHub Advanced Viewer**, then run `PRFilesFilter.debug()`. It returns whether the script is active, the active patterns, the hidden files (with matched pattern and old path), and the current `SELECTORS`.
  3. In the Elements panel, search for `data-pff-hidden`; its value is the pattern that matched.
- **Conversation noise not hidden (or too much hidden)**: with the same console context, run `PRFilesFilter.debugNoise()`. It returns whether the script is active, the setting, the counts, every marked element (category, id, start of its text) and the current `SELECTORS`. In the Elements panel, search for `data-pff-noise`; its value is the category (`empty` is just a wrapper whose contents are all hidden).
- **Popup / storage**: right-click the toolbar icon, **Inspect popup**. To look at stored data, run `chrome.storage.sync.get(null, console.log)` in that console.
- **Service worker**: `chrome://extensions` → the extension card → **service worker** link.
- **Stale behaviour after reloading the extension**: reload the GitHub tab. (A page left open from before a reload cleans itself up and goes idle.)

## Tests

```bash
npm test            # or: node --test "tests/*.test.js"
```

No dependencies; uses Node's built-in test runner (Node 18+). `tests/matcher.test.js` covers the glob syntax, case sensitivity, escaping, renames, validation and pathological patterns. `tests/storage.test.js` covers defaults, normalization of corrupt data, seeding that never overwrites, add/edit/remove/validation, the `hideNoise` setting and export/import against an in-memory fake of `chrome.storage`. `tests/noise.test.js` covers the DOM-free noise decisions: which links are GitHub Apps, which timeline icons are noise, and the count wording. The DOM walking in `src/conversation.js` is checked by the manual list below.

The shared files (`src/matcher.js`, `src/storage.js`, `src/diffstat.js`, `src/noise.js`) are written so the same file works as a content-script/popup `<script>` (attaching to `globalThis.PRFilesFilter`), via `importScripts` in the service worker, and via `require` in Node.

To regenerate the placeholder icons: `npm run icons` (`node scripts/generate-icons.js`, dependency-free).

## Manual test checklist

Use any PR that changes a `*.spec.ts` or `*.snap` file, ideally a large one.

1. **Defaults**: load the extension, open a PR's Files changed tab. `.spec.ts` and `.snap` diffs and their sidebar entries are hidden, empty folders in the sidebar are collapsed, and the banner shows the right count.
2. **Banner**: click **Show**: everything appears (dashed outline on previously hidden files), button reads **Hide again**. Click it: hidden again. Click **List ▾**: paths and matched patterns are listed. Reload the page: files are hidden again (Show is not persisted).
3. **Popup add**: add `*.md`, press Enter. The open PR tab updates immediately, no reload. Try adding it again (duplicate), an empty value, and `!x` (negation): each shows an inline error.
4. **Toggle / edit / delete**: toggle a filter off and on; edit its pattern (Enter saves, Esc cancels); delete it. Each change is reflected live.
5. **Master switch**: turn it off, everything is visible and there is no banner. Turn it on: filtering resumes. The list is intact.
6. **Defaults persist**: delete `*.snap`, close and reopen the popup: it stays deleted. **Reset to defaults** (click twice) brings it back.
7. **Navigation without reload**: from the PR's Conversation tab, click **Files changed**. Files are hidden without reloading the page. Go back to Conversation (banner disappears), then forward again.
8. **Lazy loading**: on a large PR, scroll down. Diffs that load later are hidden as they arrive and the banner count grows (a hidden diff should never flash into view).
9. **Renames**: on a PR with a renamed file, add a pattern that matches only the old name (or only the new name). The file is hidden either way, and the list shows "renamed from …".
10. **Reveal while editing filters**: click **Show**, then add or remove a filter in the popup. The page stays revealed and the count updates.
11. **Multiple tabs**: open two PR tabs and change a filter: both update.
12. **No GitHub tab**: open the popup on a non-GitHub tab (for example `chrome://extensions`): you can still manage filters.
13. **Dark mode**: switch the OS or GitHub theme to dark and check the popup, banner and noise button.

Conversation noise (use a PR with bot reviews, a few timeline events such as draft / ready for review, and at least one resolved thread):

14. **Hidden by default**: open the PR's Conversation tab. Bot reviews/comments, resolved threads and status rows are gone; commits, the PR description and human comments remain. The button reads `N noise items hidden`; hovering it breaks the number down.
15. **Toggle**: click **Show**: everything returns with dashed outlines, the button reads **Hide**. Click it: hidden again. Reload: the choice is remembered.
16. **Popup**: the **Hide conversation noise** switch matches the button; flip it in the popup and the open PR tab follows without a reload. While the Conversation tab is active the popup lists the counts.
17. **Bot threads**: an unresolved review thread written by a bot stays visible (with its review header); once resolved it is hidden. A review whose threads are all resolved and has no body disappears entirely, header included.
18. **Kept rows**: a merged / closed / reopened / force-pushed row is never hidden.
19. **Permalink**: copy the link of a hidden bot review (its timestamp) and open it in a new tab: the noise is shown for that view and the button says **Showing**.
20. **Navigation without reload**: Conversation → Files changed → Conversation: no leftover button or hidden items on Files changed, and the noise is hidden again when you return.
21. **Live updates**: with the tab open, have a bot comment on the PR: it stays hidden and the count grows.

## Layout

```
manifest.json
src/matcher.js      glob matcher (pure, shared)
src/storage.js      schema, defaults, normalization, storage helpers (shared)
src/diffstat.js     parses GitHub's line counts, computes the after-filters totals (pure, shared)
src/noise.js        conversation-noise decisions: bot links, noise icons, count text (pure, shared)
src/content.js      Files changed: DOM discovery, hiding, banner, observers (+ SELECTORS)
src/conversation.js Conversation tab: finds and hides noise, the toggle button (+ SELECTORS)
src/content.css     hiding rules, banner and noise-button styles
src/background.js   service worker: seeds defaults on install
popup/              popup.html, popup.css, popup.js
icons/              placeholder PNGs (16, 48, 128)
scripts/            generate-icons.js
tests/              matcher.test.js, storage.test.js, diffstat.test.js, noise.test.js
```

## Known limitations

- **Only the classic Files changed layout was verified.** GitHub has been rolling out a React-based diff view, which could not be inspected while building this (no logged-in browser was available). If it uses different markup, you will see the console warning above and nothing will be hidden. In that case, paste the `outerHTML` of one file container, one file-tree entry, and the header of a renamed file; only the `SELECTORS` object should need changes.
- **GitHub Enterprise is not supported.** It would need an optional `scripting` permission and optional host permissions, which go beyond the "storage only" constraint; add them deliberately if you want this.
- A rename that matches only on its **old** path is hidden in the sidebar once its diff has rendered (the sidebar only knows the new path). The banner count catches up as soon as it does.
- Right after a hard page load the filter starts when the DOM is ready, so a diff may be visible for a moment before it is hidden. Diffs that load later are hidden before they are painted.
- On large PRs GitHub loads diffs lazily, but the sidebar already lists every file, so the banner count includes files whose diffs have not rendered yet.
- **Conversation noise: only GitHub Apps count as bots.** A person-style account used as a bot (a machine user) looks like a human to GitHub's markup and is not hidden. There is no per-account list yet.
- **Conversation noise: all categories share one switch.** You cannot hide resolved threads but keep bot comments (or the other way round); the category list is fixed in `src/noise.js` / `src/conversation.js`.
- The noise is hidden once the script runs (DOM ready), so on a hard page load a bot comment can be visible for a moment. Items that arrive later are hidden before they are painted.
- Chrome only (uses the Navigation API and an MV3 service worker).
