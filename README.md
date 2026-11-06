# PR Files Filter

A Chrome extension (Manifest V3) that hides files on GitHub's pull request **Files changed** tab based on filename filters you control. It is meant for reviewing AI-generated PRs, where much of the diff is noise: by default it hides tests, snapshots, Storybook stories, lockfiles, and generated/build output (full list in `DEFAULT_PATTERNS` in `src/storage.js`; edit it in the popup).

Hiding is never silent: a banner at the top of the diff area always says how many files are hidden, lets you list them, and lets you reveal them with one click.

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
[≡]  3 files hidden by PR Files Filter      [Show]  [List ▾]
```

- **Show** reveals the hidden files for this page view only (nothing is saved) and the button becomes **Hide again**. Revealed files get a dashed outline so you can tell them apart.
- **List ▾** expands the list of hidden paths, with the pattern that matched each one (and the old name for renamed files).
- If nothing matches, there is no banner.

**Popup** (click the toolbar icon):

- Master switch: turns all filtering off without losing your list.
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
- `src/background.js` (service worker) seeds the defaults on `install` only, and never overwrites existing synced settings.
- Settings live in `chrome.storage.sync` under the key `settings`:
  `{ "version": 1, "enabled": true, "filters": [{ "id": "…", "pattern": "*.snap", "enabled": true }] }`.
  Missing or corrupt data falls back to the defaults. Chrome limits one synced item to about 8 KB, which is roughly 100 short patterns; hitting it shows a "quota exceeded" message in the popup.

### GitHub's DOM, as verified

These selectors live in the `SELECTORS` object at the top of `src/content.js`. They were checked against real github.com PR pages (classic server-rendered Files changed layout):

- File block: `div.file[data-tagsearch-path]` (id `diff-<sha256>`). For renamed files the attribute holds the **new** path; the header link `a.Link--primary[title]` holds `old → new` (its visible text is ellipsized, so the title is used).
- Sidebar entry: `li[role=treeitem][data-tree-entry-type=file]` with id `file-tree-item-` + the block's id, and a hidden `[data-filterable-item-text]` span holding the path. The tree lists **all** files even before their diffs load, so the banner count is exact immediately.
- CI annotations on unchanged files render as a `div.file` with no `data-tagsearch-path` and no tree entry. These are deliberately **never hidden**.

If GitHub changes this markup, the extension logs a single warning on the files page:

```
[PR Files Filter] No file containers matching "div.file[data-tagsearch-path]" were found on /…/files after 5s. …
```

## Debugging

- **Nothing is hidden / no banner**
  1. Open DevTools on the PR tab and look for a `[PR Files Filter]` warning in the Console (selectors no longer match; see above).
  2. In the console, switch the context dropdown (top-left of the Console, normally "top") to **PR Files Filter**, then run `PRFilesFilter.debug()`. It returns whether the script is active, the active patterns, the hidden files (with matched pattern and old path), and the current `SELECTORS`.
  3. In the Elements panel, search for `data-pff-hidden`; its value is the pattern that matched.
- **Popup / storage**: right-click the toolbar icon, **Inspect popup**. To look at stored data, run `chrome.storage.sync.get(null, console.log)` in that console.
- **Service worker**: `chrome://extensions` → the extension card → **service worker** link.
- **Stale behaviour after reloading the extension**: reload the GitHub tab. (A page left open from before a reload cleans itself up and goes idle.)

## Tests

```bash
npm test            # or: node --test "tests/*.test.js"
```

No dependencies; uses Node's built-in test runner (Node 18+). `tests/matcher.test.js` covers the glob syntax, case sensitivity, escaping, renames, validation and pathological patterns. `tests/storage.test.js` covers defaults, normalization of corrupt data, seeding that never overwrites, add/edit/remove/validation and export/import against an in-memory fake of `chrome.storage`.

The shared files (`src/matcher.js`, `src/storage.js`) are written so the same file works as a content-script/popup `<script>` (attaching to `globalThis.PRFilesFilter`), via `importScripts` in the service worker, and via `require` in Node.

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
13. **Dark mode**: switch the OS or GitHub theme to dark and check the popup and banner.

## Layout

```
manifest.json
src/matcher.js      glob matcher (pure, shared)
src/storage.js      schema, defaults, normalization, storage helpers (shared)
src/content.js      DOM discovery, hiding, banner, observers (+ SELECTORS)
src/content.css     hiding rules and banner styles
src/background.js   service worker: seeds defaults on install
popup/              popup.html, popup.css, popup.js
icons/              placeholder PNGs (16, 48, 128)
scripts/            generate-icons.js
tests/              matcher.test.js, storage.test.js
```

## Known limitations

- **Only the classic Files changed layout was verified.** GitHub has been rolling out a React-based diff view, which could not be inspected while building this (no logged-in browser was available). If it uses different markup, you will see the console warning above and nothing will be hidden. In that case, paste the `outerHTML` of one file container, one file-tree entry, and the header of a renamed file; only the `SELECTORS` object should need changes.
- **GitHub Enterprise is not supported.** It would need an optional `scripting` permission and optional host permissions, which go beyond the "storage only" constraint; add them deliberately if you want this.
- A rename that matches only on its **old** path is hidden in the sidebar once its diff has rendered (the sidebar only knows the new path). The banner count catches up as soon as it does.
- Right after a hard page load the filter starts when the DOM is ready, so a diff may be visible for a moment before it is hidden. Diffs that load later are hidden before they are painted.
- On large PRs GitHub loads diffs lazily, but the sidebar already lists every file, so the banner count includes files whose diffs have not rendered yet.
- Chrome only (uses the Navigation API and an MV3 service worker).
