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

test('generated filenames include local session time and a collision-resistant ID', () => {
  const date = new Date(2026, 10, 12, 9, 8, 7, 6);
  assert.equal(obsidianFilename(date, 'abc123'), 'FreeWriting-2026-11-12_09-08-07-006-abc123.md');
});
