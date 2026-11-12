'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { buildObsidianUri, validateObsidianSettings, obsidianFilename } = new Function(
  readFileSync(require.resolve('../app.js'), 'utf8')
    + '\nreturn { buildObsidianUri, validateObsidianSettings, obsidianFilename };',
)();

test('URI values round-trip Japanese, spaces, emoji, newlines and reserved characters', () => {
  const params = { vault: '私の Vault & #+%', file: '日記/メモ.md', content: '日本語😀\n&file=evil? #+% /\\' };
  const uri = buildObsidianUri('new', params);
  assert.ok(uri.includes('%20'));
  assert.ok(uri.includes('%2F'));
  assert.ok(!uri.includes('\n'));
  assert.deepEqual(Object.fromEntries(new URL(uri).searchParams), params);
});

test('settings allow Vault IDs and relative folders but reject unsafe paths', () => {
  assert.deepEqual(validateObsidianSettings({ vault: '  私の Vault  ', folder: ' 日記/FreeWriting/ ' }),
    { vault: '私の Vault', folder: '日記/FreeWriting' });
  assert.equal(validateObsidianSettings({ vault: 'ef6ca3e3b524d22f' }).folder, '');
  for (const folder of ['/root', '/', '../outside', 'a/../b', './x', 'a//b', 'C:/notes', 'a\\b',
    'a#b', 'a^b', 'a[b]', 'a/b./c', 'a/CON', 'a/NUL.md', 'a\u0000b']) {
    assert.throws(() => validateObsidianSettings({ vault: 'Vault', folder }), undefined, folder);
  }
  for (const vault of ['', '   ', 'bad\nname', 'a'.repeat(201), '\ud800']) {
    assert.throws(() => validateObsidianSettings({ vault }));
  }
});

test('filenames use only the local session date, without time or random IDs', () => {
  const date = new Date(2026, 10, 12, 9, 8, 7, 6);
  assert.equal(obsidianFilename(date), 'FreeWriting-2026-11-12.md');
  assert.equal(obsidianFilename(new Date(2026, 10, 12, 23, 59)), obsidianFilename(date));
  assert.equal(obsidianFilename(new Date(2026, 0, 2)), 'FreeWriting-2026-01-02.md');
});
