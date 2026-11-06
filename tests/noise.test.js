'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { iconName, isNoiseEventIcon, isBotHref, isBotOnly, summarize, KEPT_EVENT_ICONS } = require('../src/noise.js');

test('iconName: reads the octicon from an SVG class attribute', () => {
  assert.equal(iconName('octicon octicon-git-merge'), 'git-merge');
  assert.equal(iconName('octicon octicon-pencil color-fg-inherit'), 'pencil');
  assert.equal(iconName('color-fg-done octicon-git-pull-request-draft octicon'), 'git-pull-request-draft');
  for (const bad of ['', 'octicon', 'not-octicon-x', null, undefined, 7, {}]) assert.equal(iconName(bad), '');
});

test('isNoiseEventIcon: the rows named in the request are noise', () => {
  assert.equal(isNoiseEventIcon('git-pull-request-draft'), true); // "marked this pull request as draft"
  assert.equal(isNoiseEventIcon('eye'), true); // "requested review from ...", "marked as ready for review"
  assert.equal(isNoiseEventIcon('git-branch'), true); // "Copilot started reviewing on behalf of ..."
  assert.equal(isNoiseEventIcon('pencil'), true); // "changed the title"
  assert.equal(isNoiseEventIcon('tag'), true); // labels
  assert.equal(isNoiseEventIcon('person'), true); // assignees
});

test('isNoiseEventIcon: commits, merge, close, reopen and force-push are never noise', () => {
  for (const icon of ['git-commit', 'git-merge', 'git-pull-request-closed', 'git-pull-request', 'repo-push']) {
    assert.equal(isNoiseEventIcon(icon), false, icon);
    assert.ok(KEPT_EVENT_ICONS.has(icon));
  }
});

test('isNoiseEventIcon: a row with no recognisable icon is left alone', () => {
  for (const icon of ['', null, undefined, 3]) assert.equal(isNoiseEventIcon(icon), false);
});

test('isBotHref: GitHub Apps link to /apps/<slug>, people to /<login>', () => {
  for (const href of ['/apps/claude', '/apps/aikido-pr-checks', '/apps/copilot-pull-request-reviewer', '/apps/dependabot', 'https://github.com/apps/github-actions']) {
    assert.equal(isBotHref(href), true, href);
  }
  for (const href of ['/Timothy1102', '/apps', '/apps/', '/users/apps/x', '/someone/apps/claude', 'https://evil.example/apps/claude', '', null, undefined, 5]) {
    assert.equal(isBotHref(href), false, String(href));
  }
});

test('isBotOnly: needs at least one author and no humans', () => {
  assert.equal(isBotOnly(['/apps/claude']), true);
  assert.equal(isBotOnly(['/apps/claude', '/apps/aikido-pr-checks', '/apps/claude']), true);
  assert.equal(isBotOnly(['/apps/claude', '/Timothy1102']), false, 'a human reply keeps the whole thing');
  assert.equal(isBotOnly(['/Timothy1102']), false);
  assert.equal(isBotOnly([]), false, 'no authors found means unknown, never "all bots"');
  assert.equal(isBotOnly(['']), false, 'an author link with no href is not a bot');
  for (const bad of [null, undefined, 'x', {}]) assert.equal(isBotOnly(bad), false);
});

test('summarize: counts, pluralisation and order', () => {
  assert.deepEqual(summarize({ resolved: 3, bots: 8, events: 6 }), {
    total: 17,
    parts: ['3 resolved threads', '8 bot comments', '6 timeline events'],
    text: '3 resolved threads · 8 bot comments · 6 timeline events',
  });
  assert.equal(summarize({ resolved: 1, bots: 1, events: 1 }).text, '1 resolved thread · 1 bot comment · 1 timeline event');
  assert.equal(summarize({ resolved: 0, bots: 2, events: 0 }).text, '2 bot comments', 'zero parts are skipped');
  assert.equal(summarize({ resolved: 1200, bots: 0, events: 0 }).text, '1,200 resolved threads');
});

test('summarize: nothing hidden, or junk input', () => {
  const none = { total: 0, parts: [], text: '' };
  assert.deepEqual(summarize({ resolved: 0, bots: 0, events: 0 }), none);
  assert.deepEqual(summarize({}), none);
  assert.deepEqual(summarize(null), none);
  assert.deepEqual(summarize({ resolved: -2, bots: 1.5, events: 'x' }), none);
});
