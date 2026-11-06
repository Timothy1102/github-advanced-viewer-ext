/*
 * GitHub Advanced Viewer - background service worker.
 *
 * Its only job: seed the default filters when the extension is first
 * installed. Reasons other than "install" (update, browser_update, ...) never
 * touch storage, so a default the user deleted stays deleted.
 */
importScripts('matcher.js', 'storage.js'); // paths are relative to this file

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== 'install') return;
  try {
    // ensureSeeded() is a no-op if valid settings already exist (for example
    // synced from another device), so a reinstall can't overwrite them.
    await globalThis.PRFilesFilter.storage.ensureSeeded();
  } catch (err) {
    console.error('[GitHub Advanced Viewer] Could not seed default filters:', err);
  }
});
