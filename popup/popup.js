/*
 * GitHub Advanced Viewer - popup UI.
 *
 * Rules of this file:
 *   - Every write goes through storage.update(), which re-reads the latest
 *     stored settings first, so the popup never overwrites a newer change.
 *   - The DOM is built with createElement/textContent only. Filter patterns are
 *     user input: they never go through innerHTML.
 *   - The popup works with no GitHub tab open; the "hidden in this tab" line
 *     is a best-effort extra.
 */
(() => {
  'use strict';

  const { storage, matcher } = globalThis.PRFilesFilter;
  const $ = (id) => document.getElementById(id);

  const ui = {
    settings: storage.defaultSettings(),
    editingId: null, // id of the row being edited inline
    editDraft: '',
    editError: '',
    focusEdit: false, // focus the edit input after the next render
  };

  /** Tiny DOM builder: h('li', { class: 'x', text: 'hi', onclick }, child, ...). */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    node.append(...children.filter(Boolean));
    return node;
  }

  // --- feedback ------------------------------------------------------------

  let noteTimer = null;
  function showNote(text) {
    const note = $('note');
    note.textContent = text;
    note.hidden = !text;
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => showNote(''), 5000);
  }

  function setAddError(text) {
    const box = $('add-error');
    box.textContent = text || '';
    box.hidden = !text;
    $('add-input').toggleAttribute('aria-invalid', !!text);
  }

  // --- storage writes --------------------------------------------------------

  /** Apply a pure settings mutation. Re-renders on success; returns the result. */
  async function mutate(fn) {
    const res = await storage.update(fn);
    if (res && res.ok) ui.settings = res.settings;
    render();
    return res;
  }

  // --- rendering ---------------------------------------------------------------

  function buildRow(filter) {
    const syntax = matcher.validatePattern(filter.pattern);
    const editing = ui.editingId === filter.id;
    const classes = ['row'];
    if (!filter.enabled) classes.push('off');
    if (!syntax.ok) classes.push('invalid');

    const toggle = h(
      'label',
      { class: 'switch', title: filter.enabled ? 'Enabled - click to disable' : 'Disabled - click to enable' },
      h('input', {
        type: 'checkbox',
        role: 'switch',
        'aria-label': `Enable filter ${filter.pattern}`,
        checked: filter.enabled,
        onchange: async (e) => {
          const res = await mutate((s) => storage.updateFilter(s, filter.id, { enabled: e.target.checked }));
          if (!res.ok) showNote(res.error);
        },
      }),
      h('span', { class: 'track', 'aria-hidden': 'true' })
    );
    // `checked` is a property, not an attribute, so set it explicitly.
    toggle.querySelector('input').checked = filter.enabled;

    const row = h('li', { class: classes.join(' '), 'data-id': filter.id }, toggle);

    if (editing) {
      row.append(
        h('input', {
          type: 'text',
          class: 'edit-input',
          value: ui.editDraft,
          spellcheck: 'false',
          'aria-label': 'Edit filter pattern',
          'aria-invalid': ui.editError ? 'true' : false,
          oninput: (e) => {
            ui.editDraft = e.target.value;
          },
          onkeydown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              saveEdit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelEdit();
            }
          },
        }),
        h('button', { type: 'button', class: 'icon', title: 'Save (Enter)', 'aria-label': 'Save', text: '✓', onclick: saveEdit }),
        h('button', { type: 'button', class: 'icon', title: 'Cancel (Esc)', 'aria-label': 'Cancel', text: '✕', onclick: cancelEdit })
      );
      if (ui.editError) row.append(h('p', { class: 'row-error', role: 'alert', text: ui.editError }));
    } else {
      row.append(
        h('span', { class: 'pattern', title: 'Click to edit', onclick: () => startEdit(filter), text: filter.pattern }),
        h('button', { type: 'button', class: 'icon', title: 'Edit', 'aria-label': `Edit ${filter.pattern}`, text: '✎', onclick: () => startEdit(filter) }),
        h('button', {
          type: 'button',
          class: 'icon danger',
          title: 'Delete',
          'aria-label': `Delete ${filter.pattern}`,
          text: '🗑',
          onclick: async () => {
            const res = await mutate((s) => storage.removeFilter(s, filter.id));
            if (!res.ok) showNote(res.error);
          },
        })
      );
      if (!syntax.ok) {
        row.append(h('p', { class: 'row-error', text: `Ignored - invalid pattern: ${syntax.error}` }));
      }
    }
    return row;
  }

  function render() {
    const { settings } = ui;
    if (ui.editingId && !settings.filters.some((f) => f.id === ui.editingId)) ui.editingId = null;

    $('master').checked = settings.enabled;
    $('master-label').textContent = settings.enabled ? 'On' : 'Off';

    const list = $('filters');
    list.classList.toggle('master-off', !settings.enabled);
    list.replaceChildren(...settings.filters.map(buildRow));
    $('empty').hidden = settings.filters.length > 0;

    if (ui.focusEdit) {
      ui.focusEdit = false;
      const input = list.querySelector('.edit-input');
      if (input) {
        input.focus();
        input.select();
      }
    }
  }

  // --- inline edit ---------------------------------------------------------------

  function startEdit(filter) {
    ui.editingId = filter.id;
    ui.editDraft = filter.pattern;
    ui.editError = '';
    ui.focusEdit = true;
    render();
  }

  function cancelEdit() {
    ui.editingId = null;
    ui.editError = '';
    render();
  }

  async function saveEdit() {
    const id = ui.editingId;
    if (!id) return;
    const res = await storage.update((s) => storage.updateFilter(s, id, { pattern: ui.editDraft }));
    if (res.ok) {
      ui.settings = res.settings;
      ui.editingId = null;
      ui.editError = '';
    } else {
      ui.editError = res.error; // stay in edit mode so the user can fix it
      ui.focusEdit = true;
    }
    render();
  }

  // --- add form ----------------------------------------------------------------------

  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault(); // Enter in the input and the Add button both land here
    const input = $('add-input');
    const res = await mutate((s) => storage.addFilter(s, input.value));
    if (res.ok) {
      input.value = '';
      setAddError('');
    } else {
      setAddError(res.error);
    }
    input.focus();
  });
  $('add-input').addEventListener('input', () => setAddError(''));

  // --- master switch ----------------------------------------------------------------------

  $('master').addEventListener('change', async (e) => {
    const res = await mutate((s) => storage.setMasterEnabled(s, e.target.checked));
    if (!res.ok) showNote(res.error);
  });

  // --- reset to defaults (two-step confirm, no window.confirm) ------------------------------------

  const resetBtn = $('reset');
  let resetTimer = null;
  function disarmReset() {
    clearTimeout(resetTimer);
    resetBtn.textContent = 'Reset to defaults';
    resetBtn.classList.remove('confirming');
  }
  resetBtn.addEventListener('click', async () => {
    if (!resetBtn.classList.contains('confirming')) {
      resetBtn.textContent = 'Click again to confirm';
      resetBtn.classList.add('confirming');
      resetTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    ui.editingId = null;
    const res = await mutate((s) => storage.resetFilters(s));
    showNote(res.ok ? 'Filters reset to the default noise filters.' : res.error);
  });

  // --- export / import ---------------------------------------------------------------------------

  function ioMessage(text, ok) {
    const msg = $('io-msg');
    msg.textContent = text;
    msg.hidden = !text;
    msg.className = `small ${ok ? 'ok' : 'bad'}`;
  }

  $('toggle-io').addEventListener('click', (e) => {
    const panel = $('io');
    panel.hidden = !panel.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
  });

  $('export').addEventListener('click', async () => {
    const box = $('io-text');
    box.value = storage.exportJson(ui.settings);
    try {
      await navigator.clipboard.writeText(box.value);
      ioMessage('Copied to clipboard.', true);
    } catch (_) {
      box.select();
      ioMessage('Select the text above and copy it.', true);
    }
  });

  $('import').addEventListener('click', async () => {
    const text = $('io-text').value.trim();
    if (!text) return ioMessage('Paste exported JSON above first.', false);
    const res = await mutate((s) => storage.mergeImport(s, text));
    if (!res.ok) return ioMessage(res.error, false);
    const skipped = res.skipped ? `, ${res.skipped} skipped (duplicate or invalid)` : '';
    ioMessage(`Imported ${res.added} filter${res.added === 1 ? '' : 's'}${skipped}.`, true);
  });

  // --- hidden count for the active tab (best effort) ---------------------------------------------------
  // chrome.tabs.query/sendMessage need no extra permission: we only read the
  // tab id and talk to our own content script, which answers on GitHub PR pages.

  async function refreshTabStatus() {
    const out = $('tab-status');
    let text = 'Open a pull request’s Files changed tab to see hidden counts.';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const res = tab && tab.id != null ? await chrome.tabs.sendMessage(tab.id, { type: 'pff:getStatus' }) : null;
      if (res && res.onFilesPage) {
        if (!res.filtering) text = 'Filtering is off in this tab.';
        else if (res.hiddenCount === 0) text = 'No files hidden in this tab.';
        else {
          text = `${res.hiddenCount} file${res.hiddenCount === 1 ? '' : 's'} hidden in this tab`;
          if (res.revealed) text += ' (currently shown)';
          text += '.';
        }
      }
    } catch (_) {
      // No content script in the active tab (not GitHub, or not reloaded yet): keep the default text.
    }
    out.textContent = text;
  }

  // --- boot ---------------------------------------------------------------------------------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[storage.STORAGE_KEY]) return;
    ui.settings = storage.normalize(changes[storage.STORAGE_KEY].newValue);
    render();
    setTimeout(refreshTabStatus, 300); // give the tab's content script a moment to re-filter
  });

  (async () => {
    ui.settings = await storage.load(); // falls back to defaults on missing/corrupt data
    render();
    refreshTabStatus();
    setInterval(refreshTabStatus, 2000); // lazy-loaded diffs can change the count while the popup is open
  })();
})();
