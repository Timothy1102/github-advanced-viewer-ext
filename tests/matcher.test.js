'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compile, validatePattern, matchesPattern, matchingFilter, isHidden } = require('../src/matcher.js');

const yes = (pattern, ...paths) =>
  paths.forEach((p) => assert.equal(matchesPattern(pattern, p), true, `"${pattern}" should match "${p}"`));
const no = (pattern, ...paths) =>
  paths.forEach((p) => assert.equal(matchesPattern(pattern, p), false, `"${pattern}" should NOT match "${p}"`));

test('*.spec.ts: basename pattern, any depth', () => {
  yes('*.spec.ts', 'a.spec.ts', 'src/a.spec.ts', 'a/b/c/d/user.service.spec.ts');
  no('*.spec.ts', 'a.spec.tsx', 'a.spec.ts.bak', 'spec.ts', 'a.ts', 'src/spec.ts/a.ts');
});

test('*.snap: hides snapshots at any depth', () => {
  yes('*.snap', 'foo.snap', 'a/b/c/foo.test.snap', 'e2e/__tests__/__snapshots__/showConfig.test.ts.snap');
  no('*.snap', 'foo.snapshot', 'snap', 'a.snap/b.txt');
});

test('pattern without "/" matches the basename only, at every depth', () => {
  yes('README.md', 'README.md', 'a/README.md', 'a/b/c/README.md');
  no('README.md', 'README.md.bak', 'docs/README.markdown', 'README.md/index.js');
  yes('foo*', 'foo', 'x/y/foobar.ts');
  no('foo*', 'x/foo/bar.ts'); // dir named foo is not the basename
});

test('pattern with "/" is matched against the full path from the repo root', () => {
  yes('src/generated/**', 'src/generated/a.ts', 'src/generated/x/y/z.ts');
  no('src/generated/**', 'lib/src/generated/a.ts', 'src/generated', 'src/other/a.ts');
  yes('src/*.ts', 'src/a.ts');
  no('src/*.ts', 'src/x/a.ts', 'a.ts', 'lib/src/a.ts');
  yes('docs/api.md', 'docs/api.md');
  no('docs/api.md', 'x/docs/api.md');
});

test('**/__snapshots__/**', () => {
  yes('**/__snapshots__/**', '__snapshots__/a.snap', 'a/__snapshots__/a.snap', 'a/b/__snapshots__/c/d/e.snap');
  no('**/__snapshots__/**', 'a/__snapshots__', 'a/__snapshots__x/b', 'a/x__snapshots__/b', 'src/a.ts');
});

test('"**" in the middle matches zero or more directories', () => {
  yes('a/**/b.ts', 'a/b.ts', 'a/x/b.ts', 'a/x/y/z/b.ts');
  no('a/**/b.ts', 'b.ts', 'x/a/b.ts', 'a/b.tsx');
  yes('**/b.ts', 'b.ts', 'a/b.ts', 'a/b/c/b.ts');
});

test('"**" inside a segment behaves like "*" (does not cross "/")', () => {
  yes('src/a**b.ts', 'src/axxb.ts', 'src/ab.ts');
  no('src/a**b.ts', 'src/a/b.ts');
});

test('"?" matches exactly one non-slash character', () => {
  yes('file?.ts', 'file1.ts', 'x/fileA.ts');
  no('file?.ts', 'file.ts', 'file12.ts');
  no('a?b', 'a/b');
  yes('src/?/x.ts', 'src/a/x.ts');
  no('src/?/x.ts', 'src/ab/x.ts');
  yes('a?b', 'a😀b'); // one code point, not two UTF-16 units
});

test('"*" does not cross path separators in anchored patterns', () => {
  yes('src/*/index.ts', 'src/foo/index.ts');
  no('src/*/index.ts', 'src/foo/bar/index.ts', 'src/index.ts');
});

test('leading "/" anchors a basename-looking pattern to the repo root', () => {
  yes('/foo.ts', 'foo.ts');
  no('/foo.ts', 'src/foo.ts');
  yes('/*.md', 'README.md');
  no('/*.md', 'docs/a.md');
});

test('trailing "/" means a directory and everything below it', () => {
  yes('__snapshots__/', '__snapshots__/a.snap', 'a/b/__snapshots__/c/d.snap');
  no('__snapshots__/', '__snapshots__', 'a/__snapshots__', 'a/__snapshots__x/b.ts');
  yes('src/generated/', 'src/generated/a.ts', 'src/generated/x/y.ts');
  no('src/generated/', 'lib/src/generated/a.ts', 'src/generated');
});

test('special regex characters are literal', () => {
  yes('*.spec.ts', 'a.spec.ts');
  no('*.spec.ts', 'a-spec-ts', 'aXspecXts', 'a.specXts'); // '.' is a literal dot
  yes('a+b.ts', 'a+b.ts');
  no('a+b.ts', 'aab.ts', 'ab.ts');
  yes('f(1).ts', 'f(1).ts');
  yes('pages/[id].tsx', 'pages/[id].tsx');
  no('pages/[id].tsx', 'pages/i.tsx', 'pages/d.tsx'); // [] is not a character class
  yes('{a,b}.ts', '{a,b}.ts');
  no('{a,b}.ts', 'a.ts', 'b.ts');
  yes('a$b^c|d.ts', 'a$b^c|d.ts');
  yes('a.b', 'a.b');
  no('a.b', 'axb');
});

test('backslash escapes wildcards', () => {
  yes('\\*.ts', '*.ts', 'dir/*.ts');
  no('\\*.ts', 'a.ts');
  yes('what\\?.md', 'what?.md');
  no('what\\?.md', 'whatx.md');
  yes('a\\\\b', 'a\\b'); // escaped backslash
  yes('trailing\\', 'trailing\\'); // lone trailing backslash is a literal
});

test('matching is case-sensitive', () => {
  no('*.SNAP', 'a.snap');
  no('*.snap', 'A.SNAP');
  yes('*.SNAP', 'a.SNAP');
  no('src/Generated/**', 'src/generated/a.ts');
});

test('isHidden: renamed files are hidden if either the old or new path matches', () => {
  const filters = [{ pattern: '*.spec.ts', enabled: true }];
  assert.equal(isHidden(['old/name.spec.ts', 'new/name.ts'], filters), true); // old matches
  assert.equal(isHidden(['old/name.ts', 'new/name.spec.ts'], filters), true); // new matches
  assert.equal(isHidden(['old/name.ts', 'new/name.tsx'], filters), false); // neither
  assert.equal(isHidden([undefined, 'a.spec.ts'], filters), true); // not a rename
  assert.equal(isHidden('a.spec.ts', filters), true); // plain string
});

test('isHidden / matchingFilter: disabled filters are ignored, first match wins', () => {
  const filters = [
    { id: '1', pattern: '*.snap', enabled: false },
    { id: '2', pattern: '*.spec.ts', enabled: true },
    { id: '3', pattern: 'src/**', enabled: true },
  ];
  assert.equal(isHidden('a.snap', filters), false);
  assert.equal(matchingFilter('src/a.spec.ts', filters).id, '2');
  assert.equal(matchingFilter('src/a.ts', filters).id, '3');
  assert.equal(matchingFilter('x.ts', filters), null);
  assert.equal(isHidden('a.snap', []), false);
  assert.equal(isHidden('a.snap', ['*.snap']), true); // bare strings accepted
});

test('validatePattern: rejects empty, negation, control chars, too long, no-name', () => {
  assert.equal(validatePattern('*.snap').ok, true);
  assert.equal(validatePattern('').ok, false);
  assert.equal(validatePattern('   ').ok, false);
  assert.match(validatePattern('!foo').error, /Negation/);
  assert.equal(validatePattern('a\u0000b').ok, false);
  assert.equal(validatePattern('a\nb').ok, false);
  assert.equal(validatePattern('x'.repeat(257)).ok, false);
  assert.equal(validatePattern('x'.repeat(256)).ok, true);
  assert.equal(validatePattern('/').ok, false);
  assert.equal(validatePattern('///').ok, false);
  assert.equal(validatePattern(Array(40).fill('a').join('/')).ok, false); // too many segments
});

test('never throws on garbage input', () => {
  for (const bad of [null, undefined, 42, {}, [], NaN, Symbol('x'), () => 1]) {
    assert.doesNotThrow(() => compile(bad));
    assert.doesNotThrow(() => validatePattern(bad));
    assert.doesNotThrow(() => matchesPattern(bad, 'a.ts'));
    assert.doesNotThrow(() => matchesPattern('*.ts', bad));
    assert.doesNotThrow(() => isHidden(bad, bad));
    assert.doesNotThrow(() => isHidden('a.ts', [bad, { pattern: bad }, null]));
  }
  assert.equal(isHidden('a.ts', [null, { pattern: 5 }, { enabled: true }]), false);
  assert.equal(matchesPattern('*.ts', ''), false);
  assert.equal(matchesPattern('*.ts', '/'), false);
});

test('invalid stored patterns are skipped, not fatal', () => {
  const filters = [
    { pattern: '!negated', enabled: true },
    { pattern: '', enabled: true },
    { pattern: '*.snap', enabled: true },
  ];
  assert.equal(isHidden('a.snap', filters), true);
  assert.equal(isHidden('a.ts', filters), false);
});

test('pathological patterns finish quickly (no catastrophic backtracking)', () => {
  const evil = '*a*a*a*a*a*a*a*a*a*a*b';
  const longPath = 'a'.repeat(4000);
  const t0 = Date.now();
  assert.equal(matchesPattern(evil, longPath), false);
  assert.equal(matchesPattern(`x/${evil}`, `x/${longPath}`), false);
  assert.equal(matchesPattern('**/**/**/**/**/**/**/**/*.never', Array(30).fill('d').join('/') + '/f.ts'), false);
  assert.equal(matchesPattern('**/a/**/a/**/a/**/a/**/b', Array(30).fill('a').join('/')), false);
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
});

test('compile() exposes anchoring decisions', () => {
  assert.equal(compile('*.snap').anchored, false);
  assert.equal(compile('a/b').anchored, true);
  assert.equal(compile('/a').anchored, true);
  assert.equal(compile('dist/').anchored, true); // compiles to **/dist/**
  assert.equal(compile('  *.snap  ').pattern, '*.snap'); // trimmed
});
