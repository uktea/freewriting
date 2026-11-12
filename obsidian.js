'use strict';

// A conservative routing budget, not a universal browser/OS URI limit.
const OBSIDIAN_URI_BUDGET = 1800;
const OBSIDIAN_SETTINGS_KEY = 'freewriting-obsidian-v1';

function validateObsidianSettings(value) {
  const vault = typeof value?.vault === 'string' ? value.vault.trim() : '';
  const rawFolder = typeof value?.folder === 'string' ? value.folder.trim() : '';
  const folder = rawFolder.replace(/\/+$/, '');
  if (!vault || vault.length > 200 || /[\u0000-\u001f\u007f]/.test(vault)) {
    throw new Error('Vault名を1〜200文字で入力してください。');
  }
  if (rawFolder.startsWith('/') || folder.length > 200 || (folder && folder.split('/').some((part) =>
    !part || part === '.' || part === '..' || /[<>:"\\|?*#^\[\]\u0000-\u001f\u007f]/.test(part)
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    throw new Error('フォルダーはVault内の相対パスで入力してください（例: FreeWriting/日記）。使用できない名前・記号や「..」は使えません。');
  }
  // Invalid UTF-16 must not prevent the rest of the writing app from loading.
  try { encodeURIComponent(vault); encodeURIComponent(folder); } catch {
    throw new Error('設定に使用できない文字が含まれています。入力し直してください。');
  }
  return { vault, folder };
}

function buildObsidianUri(action, params) {
  return `obsidian://${action}?${Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`;
}

function obsidianFilename(date, id) {
  const pad = (n, length = 2) => String(n).padStart(length, '0');
  return `FreeWriting-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}-${id}.md`;
}

function initializeObsidianExport({ getSession }) {
  const $ = (id) => document.getElementById(id);
  const button = $('obsidian-save');
  const dialog = $('obsidian-dialog');
  const longDialog = $('obsidian-long-dialog');
  let settings = null;
  let saveAfterSettings = false;
  let pending = null;
  let cooldown;
  try {
    settings = validateObsidianSettings(JSON.parse(localStorage.getItem(OBSIDIAN_SETTINGS_KEY)));
  } catch { /* Missing, corrupt, or unavailable storage falls back to setup. */ }

  function readSettings() {
    try {
      const value = validateObsidianSettings({ vault: $('obsidian-vault').value, folder: $('obsidian-folder').value });
      $('obsidian-settings-message').textContent = '';
      return value;
    } catch (error) {
      $('obsidian-settings-message').textContent = error.message;
      return null;
    }
  }

  function openSettings(thenSave) {
    saveAfterSettings = thenSave;
    $('obsidian-vault').value = settings?.vault || '';
    $('obsidian-folder').value = settings?.folder || '';
    $('obsidian-settings-submit').textContent = thenSave ? '設定して保存' : '設定を保存';
    $('obsidian-settings-message').textContent = '';
    dialog.showModal();
    $('obsidian-vault').focus();
  }

  function showFeedback(message, uri) {
    $('obsidian-feedback').hidden = false;
    $('obsidian-message').textContent = message;
    $('obsidian-retry').hidden = !uri;
    $('obsidian-download').hidden = !pending;
    if (uri) $('obsidian-retry').href = uri;
  }

  function requested() {
    showFeedback(`Obsidianに起動を依頼しました。起動・保存の完了はObsidian側で確認してください。\n保存先: ${settings.vault} / ${pending.file}\n開かない場合は設定の起動テストかMarkdownのダウンロードをお試しください。`, pending.uri);
    // Ignore accidental double-clicks. A later save creates a separate note.
    button.disabled = true;
    clearTimeout(cooldown);
    const request = pending;
    cooldown = setTimeout(() => {
      if (pending === request) button.disabled = !getSession()?.text;
    }, 1200);
  }

  function save() {
    const session = getSession();
    if (!session?.text || button.disabled) return;
    if (!settings) { openSettings(true); return; }
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, '0')).join('');
    const filename = obsidianFilename(session.date, id);
    const file = settings.folder ? `${settings.folder}/${filename}` : filename;
    // Do not append or overwrite. The browser cannot inspect existing Vault files.
    pending = { text: session.text, filename, file, uri: null };
    let uri;
    try { uri = buildObsidianUri('new', { vault: settings.vault, file, content: session.text }); } catch {
      // Clipboard/file fallback also handles an unpaired surrogate in the text.
    }
    if (uri && uri.length <= OBSIDIAN_URI_BUDGET) {
      pending.uri = uri;
      requested();
      // Keep this synchronous with the click to preserve user activation.
      window.location.href = uri;
      return;
    }
    const clipboardUri = buildObsidianUri('new', { vault: settings.vault, file, clipboard: 'true' });
    if (clipboardUri.length > OBSIDIAN_URI_BUDGET) {
      showFeedback('保存先の名前が長いため、起動用リンクを短くできません。設定のVault IDや短いフォルダー名を使うか、Markdownをダウンロードしてください。', null);
      return;
    }
    $('obsidian-open-long').hidden = true;
    $('obsidian-copy-long').disabled = false;
    $('obsidian-long-message').textContent = '';
    showFeedback('長文の受け渡しを準備しています。本文はこの画面に残っています。', null);
    longDialog.showModal();
  }

  button.addEventListener('click', save);
  $('obsidian-settings').addEventListener('click', () => openSettings(false));
  $('obsidian-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = readSettings();
    if (!value) return;
    settings = value;
    let remembered = true;
    try { localStorage.setItem(OBSIDIAN_SETTINGS_KEY, JSON.stringify(settings)); } catch { remembered = false; }
    dialog.close();
    // Changing the target invalidates any old retry link and pending copy.
    pending = null;
    clearTimeout(cooldown);
    button.disabled = !getSession()?.text;
    showFeedback(remembered ? 'Obsidianの設定を保存しました。' : '設定をこのブラウザーに記憶できませんでした。このページを閉じるまでは利用できます。', null);
    if (saveAfterSettings) {
      save();
      if (!remembered) $('obsidian-message').textContent += '\n設定を記憶できないため、次回は再設定してください。';
    }
  });
  $('obsidian-test').addEventListener('click', () => {
    const value = readSettings();
    if (!value) return;
    $('obsidian-settings-message').textContent = '起動を依頼しました。指定したVaultが開くことをObsidian側で確認してください。開かない場合はインストール状況とVault名を確認してください。';
    window.location.href = buildObsidianUri('open', { vault: value.vault });
  });

  $('obsidian-copy-long').addEventListener('click', async () => {
    const request = pending;
    if (!request || $('obsidian-copy-long').disabled) return;
    $('obsidian-copy-long').disabled = true;
    $('obsidian-open-long').hidden = true;
    try {
      await navigator.clipboard.writeText(request.text);
      if (pending !== request || !longDialog.open) return;
      request.uri = buildObsidianUri('new', { vault: settings.vault, file: request.file, clipboard: 'true' });
      $('obsidian-open-long').href = request.uri;
      $('obsidian-open-long').hidden = false;
      $('obsidian-long-message').textContent = 'コピーしました。「2. Obsidianを開く」を押してください。保存されるまでは別の内容をコピーしないでください。';
      // A fresh, explicit click avoids async clipboard permission prompts
      // consuming the activation needed for a custom protocol launch.
      $('obsidian-open-long').focus();
    } catch {
      if (pending !== request || !longDialog.open) return;
      $('obsidian-long-message').textContent = 'コピーできませんでした。再試行するか、MarkdownをダウンロードしてVaultに入れてください。';
    } finally {
      if (pending === request) $('obsidian-copy-long').disabled = false;
    }
  });
  $('obsidian-open-long').addEventListener('click', (event) => {
    if (!pending?.uri || $('obsidian-open-long').hidden) { event.preventDefault(); return; }
    requested();
    longDialog.close();
  });
  $('obsidian-retry').addEventListener('click', (event) => {
    if (!pending?.uri) { event.preventDefault(); return; }
    if (pending.uri.includes('clipboard=true')) {
      // The clipboard may have changed since the previous attempt.
      event.preventDefault();
      $('obsidian-open-long').hidden = true;
      $('obsidian-long-message').textContent = 'もう一度本文をコピーしてから開いてください。';
      longDialog.showModal();
    } else requested();
  });

  function downloadMarkdown() {
    if (!pending) return;
    const url = URL.createObjectURL(new Blob([pending.text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = pending.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  $('obsidian-download').addEventListener('click', downloadMarkdown);
  $('obsidian-download-long').addEventListener('click', downloadMarkdown);

  return {
    refresh() {
      const session = getSession();
      button.disabled = !session?.text;
      if (!session) {
        pending = null;
        clearTimeout(cooldown);
        $('obsidian-feedback').hidden = true;
        if (dialog.open) dialog.close();
        if (longDialog.open) longDialog.close();
      }
      $('obsidian-download').hidden = !pending;
    },
  };
}

if (typeof module !== 'undefined') module.exports = {
  OBSIDIAN_URI_BUDGET, validateObsidianSettings, buildObsidianUri, obsidianFilename,
};
