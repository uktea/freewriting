/* Functional JavaScript only: timer, minute input, writing protection, and export. */
'use strict';

const clampMinutes = (value) => Math.max(1, Math.min(180,
  Math.round(String(value).trim() && Number.isFinite(Number(value)) ? Number(value) : 3)));
const isInsertionAt = (before, after, position) => after.length >= before.length
  && after.startsWith(before.slice(0, position))
  && after.endsWith(before.slice(position));
class WritingGuard {
  constructor(editor, { active, onCommit, onCompositionEnd }) {
    this.editor = editor;
    this.active = active;
    this.onCommit = onCommit;
    this.onCompositionEnd = onCompositionEnd;
    this.composing = false;
    this.reconverting = false;
    this.accepted = editor.value;
    this.position = editor.selectionEnd;
    editor.addEventListener('keydown', (event) => this.keydown(event));
    editor.addEventListener('beforeinput', (event) => this.beforeinput(event));
    editor.addEventListener('input', (event) => this.input(event));
    editor.addEventListener('compositionstart', () => this.compositionstart());
    editor.addEventListener('compositionend', (event) => this.compositionend(event));
    editor.addEventListener('cut', (event) => {
      if (this.active()) event.preventDefault();
    });
    editor.addEventListener('paste', () => {
      if (this.active() && !this.composing) this.collapseSelection();
    });
    // Dragging selected text can delete its original location without a keypress.
    editor.addEventListener('drop', (event) => {
      if (this.active()) event.preventDefault();
    });
    editor.addEventListener('dragstart', (event) => {
      if (this.active()) event.preventDefault();
    });
  }

  reset() {
    this.accepted = this.editor.value;
    this.position = this.editor.selectionEnd;
    this.composing = false;
    this.reconverting = false;
  }

  collapseSelection() {
    const end = this.editor.selectionEnd;
    if (this.editor.selectionStart !== end) this.editor.setSelectionRange(end, end);
    this.position = end;
  }

  restoreCommitted() {
    // Only call outside an active composition. Browser/IME events can arrive
    // with a modified DOM value before the next cancelable beforeinput.
    if (this.editor.value !== this.accepted) {
      this.editor.value = this.accepted;
      this.editor.setSelectionRange(this.position, this.position);
    }
  }

  keydown(event) {
    if (!this.active()) return;
    // IMEs often report key="Process" / keyCode=229 but retain the physical
    // code. Block explicit deletion without canceling candidate replacement.
    if (['Backspace', 'Delete'].includes(event.key) || ['Backspace', 'Delete'].includes(event.code)
      || [8, 46].includes(event.keyCode)
      || ((event.ctrlKey || event.metaKey) && ['x', 'z', 'y'].includes((event.key || '').toLowerCase()))) {
      event.preventDefault();
    }
    if (!this.composing && (event.key === 'Convert' || event.code === 'Convert')) event.preventDefault();
  }

  beforeinput(event) {
    if (!this.active()) return;
    // Manual deletion/undo are forbidden even for underlined provisional text.
    // deleteCompositionText is an IME operation used to replace a candidate.
    if ((event.inputType.startsWith('delete') && event.inputType !== 'deleteCompositionText')
      || event.inputType.startsWith('history')) {
      event.preventDefault();
      return;
    }
    // Leave native candidate replacement and phonetic-to-kanji conversion alone.
    if (this.composing || event.isComposing
      || ['insertCompositionText', 'deleteCompositionText', 'insertFromComposition'].includes(event.inputType)) return;
    this.restoreCommitted();
    if (event.inputType === 'insertReplacementText') {
      event.preventDefault();
      return;
    }
    this.collapseSelection();
  }

  input(event) {
    if (!this.active() || this.composing || event.isComposing) return;
    if (!isInsertionAt(this.accepted, this.editor.value, this.position)) {
      // Covers non-cancelable beforeinput, OS undo, and browser replacement.
      this.editor.value = this.accepted;
      this.editor.setSelectionRange(this.position, this.position);
    }
    this.accepted = this.editor.value;
    this.position = this.editor.selectionEnd;
    this.onCommit();
  }

  compositionstart() {
    if (!this.active() || this.composing) return;
    this.reconverting = this.editor.selectionStart !== this.editor.selectionEnd;
    this.restoreCommitted();
    this.collapseSelection();
    this.compositionBase = this.accepted;
    this.compositionPosition = this.editor.selectionEnd;
    this.composing = true;
  }

  compositionend(event) {
    if (!this.composing && !this.active()) return;
    const hadComposition = this.composing;
    const base = this.composing ? this.compositionBase : this.accepted;
    const position = this.composing ? this.compositionPosition : this.position;
    this.composing = false;
    if (this.reconverting || (!hadComposition && !isInsertionAt(base, this.editor.value, position))) {
      this.editor.value = base;
      this.editor.setSelectionRange(position, position);
    } else if (!isInsertionAt(base, this.editor.value, position)) {
      // A selection or IME reconversion must never replace committed text.
      const inserted = event.data || '';
      this.editor.value = base.slice(0, position) + inserted + base.slice(position);
      this.editor.setSelectionRange(position + inserted.length, position + inserted.length);
    }
    this.reconverting = false;
    this.accepted = this.editor.value;
    this.position = this.editor.selectionEnd;
    this.onCommit();
    this.onCompositionEnd();
  }
}

// Keep export initialization in this entry point: HTML bundlers isolate scripts.
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

function obsidianFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `FreeWriting-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.md`;
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
  let requestedFeedback = false;
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

  function showFeedback(message) {
    $('obsidian-feedback').hidden = false;
    $('obsidian-message').textContent = message;
  }

  function setRequestedFeedback(active) {
    requestedFeedback = active;
    $('obsidian-logo').hidden = active;
    $('obsidian-check').hidden = !active;
    button.setAttribute('aria-label', active ? 'Obsidianに起動を依頼しました' : 'Obsidianに保存');
    button.setAttribute('title', active ? '起動を依頼しました' : 'Obsidianに保存');
  }

  function requested() {
    $('obsidian-feedback').hidden = true;
    setRequestedFeedback(true);
    $('status').textContent = 'Obsidianに起動を依頼しました。';
    // Ignore accidental double-clicks. A later save creates a separate note.
    button.disabled = true;
    clearTimeout(cooldown);
    const request = pending;
    cooldown = setTimeout(() => {
      if (pending !== request) return;
      setRequestedFeedback(false);
      button.disabled = !getSession()?.text;
    }, 1200);
  }

  function save() {
    const session = getSession();
    if (!session?.text || button.disabled) return;
    if (!settings) { openSettings(true); return; }
    const filename = obsidianFilename(session.date);
    const file = settings.folder ? `${settings.folder}/${filename}` : filename;
    // Let Obsidian resolve existing names; never request append or overwrite.
    pending = { text: session.text, filename, file, uri: null };
    let uri;
    try { uri = buildObsidianUri('new', { vault: settings.vault, file, content: session.text }); } catch {
      // Clipboard/file fallback also handles an unpaired surrogate in the text.
    }
    if (uri && uri.length <= OBSIDIAN_URI_BUDGET) {
      pending.uri = uri;
      // Keep this synchronous with the click to preserve user activation.
      window.location.href = uri;
      requested();
      return;
    }
    const clipboardUri = buildObsidianUri('new', { vault: settings.vault, file, clipboard: 'true' });
    if (clipboardUri.length > OBSIDIAN_URI_BUDGET) {
      showFeedback('保存先の名前が長すぎます。設定にVault IDか短いフォルダー名を使ってください。');
      return;
    }
    $('obsidian-open-long').hidden = true;
    $('obsidian-copy-long').disabled = false;
    $('obsidian-long-message').textContent = '';
    $('obsidian-feedback').hidden = true;
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
    // Changing the target invalidates pending clipboard operations and feedback.
    pending = null;
    clearTimeout(cooldown);
    setRequestedFeedback(false);
    button.disabled = !getSession()?.text;
    $('obsidian-feedback').hidden = true;
    $('status').textContent = 'Obsidianの設定を保存しました。';
    if (saveAfterSettings) {
      save();
    }
    if (!remembered) showFeedback('設定を記憶できないため、次回は再設定してください。このページを閉じるまでは利用できます。');
  });
  $('obsidian-test').addEventListener('click', () => {
    const value = readSettings();
    if (!value) return;
    $('obsidian-settings-message').textContent = 'ObsidianでVaultが開くか確認してください。';
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
      $('obsidian-long-message').textContent = 'コピーしました。次にObsidianを開いてください。';
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
  $('obsidian-download-long').addEventListener('click', downloadMarkdown);

  setRequestedFeedback(false);
  return {
    refresh() {
      const session = getSession();
      button.disabled = !session?.text || requestedFeedback;
      if (!session) {
        pending = null;
        clearTimeout(cooldown);
        setRequestedFeedback(false);
        $('obsidian-feedback').hidden = true;
        if (dialog.open) dialog.close();
        if (longDialog.open) longDialog.close();
      }
    },
  };
}

function initializeApp() {
  const $ = (id) => document.getElementById(id);
  const editor = $('editor');
  const minutes = $('minutes');
  const hideTimer = $('hide-timer');
  const storageKey = 'freewriting-session-v1';
  let state = 'ready';
  let duration = 3;
  let totalSeconds = 180;
  let deadline = 0;
  let interval;
  let pendingFinish = false;
  let pendingReason = '';
  let lastRenderedSecond = -1;
  let lastTimeMasked = null;
  let sessionDate = new Date();
  let storageAvailable = true;
  let copyOperation = 0;
  let copyFeedbackTimer;
  let lastEscape = null;
  const doubleEscapeMs = 400;

  // Start before WritingGuard handles the same event. In particular, an IME's
  // first compositionstart must reach the guard with writing already active.
  function handleShortcut(event) {
    if (event.defaultPrevented || state === 'finished') return;
    // Leave candidate selection, IME cancellation, and filename editing native.
    if (event.isComposing || event.keyCode === 229 || guard.composing || $('save-dialog').open) {
      lastEscape = null;
      return;
    }
    if (event.repeat) {
      if (event.key === 'Escape' || (state !== 'writing' && [' ', 'Enter'].includes(event.key))) event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      lastEscape = null;
      return;
    }
    const activate = event.key === ' ' || event.key === 'Enter';
    const escape = event.key === 'Escape';
    // A focused checkbox keeps its native Space-to-toggle operation.
    if (state === 'ready' && event.target === hideTimer && event.key === ' ') return;
    if (!escape) lastEscape = null;
    if (state === 'ready' && activate) {
      event.preventDefault();
      prepareWriting();
      return;
    }
    if (state === 'waiting') {
      if (escape) {
        event.preventDefault();
        cancelWaiting();
      } else if (!['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'CapsLock'].includes(event.key)) {
        if (event.target !== editor) event.preventDefault();
        beginWriting();
      }
      return;
    }
    if (state === 'writing' && escape) {
      event.preventDefault();
      const now = Date.now();
      if (lastEscape !== null && now - lastEscape <= doubleEscapeMs) {
        lastEscape = null;
        finish('中止しました。文章は残っています。');
      } else {
        lastEscape = now;
      }
    }
  }
  document.addEventListener('keydown', handleShortcut, true);
  editor.addEventListener('keydown', handleShortcut, true);
  editor.addEventListener('compositionstart', () => {
    lastEscape = null;
    beginWriting();
  }, true);
  editor.addEventListener('beforeinput', (event) => {
    if (event.inputType.startsWith('insert')) beginWriting();
  }, true);

  const guard = new WritingGuard(editor, {
    active: () => state === 'writing',
    onCommit: () => persist(),
    onCompositionEnd: () => {
      if (pendingFinish) finish(pendingReason);
    },
  });

  function announce(message) { $('status').textContent = message; }

  const obsidian = initializeObsidianExport({
    getSession: () => state === 'finished' ? { text: editor.value, date: sessionDate } : null,
  });

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        minutes: duration,
        text: state === 'writing' ? guard.accepted : editor.value,
        date: sessionDate.toISOString(),
        showTimer: !hideTimer.checked,
      }));
    } catch {
      storageAvailable = false;
    }
  }

  function renderState() {
    document.body.dataset.state = state;
    const ready = state === 'ready';
    const waiting = state === 'waiting';
    const writing = state === 'writing';
    const finished = state === 'finished';
    const timerMasked = (waiting || writing) && hideTimer.checked;
    $('start').hidden = !ready;
    editor.hidden = !waiting && !writing && !finished;
    editor.readOnly = !waiting && !writing;
    editor.placeholder = waiting ? '何かキーを押して開始' : '';
    $('stop').hidden = !waiting && !writing;
    $('stop').setAttribute('aria-label', waiting ? '開始をキャンセル' : '執筆を中止して文章を残す');
    $('stop').setAttribute('title', waiting ? 'キャンセル（Esc）' : '中止して文章を残す（Escを2回）');
    // Keep both layers rendered for the timer-only CSS transition, while the
    // inactive layer is excluded from focus, interaction, and accessibility.
    $('time-setting').inert = !ready;
    $('time-setting').setAttribute('aria-hidden', String(!ready));
    $('time-remaining').inert = ready;
    $('time-remaining').setAttribute('aria-hidden', String(ready));
    $('timer').setAttribute('data-masked', String(timerMasked));
    hideTimer.disabled = !ready;
    $('timer-visibility-icon').src = hideTimer.checked ? './icons/visibility_off.svg' : './icons/visibility.svg';
    $('timer-option').inert = !ready;
    $('timer-option').setAttribute('aria-hidden', String(!ready));
    $('result-actions').hidden = !finished;
    $('copy').disabled = !editor.value;
    $('save-open').disabled = !editor.value;
    obsidian.refresh();
    document.title = writing ? 'FreeWriting — 執筆中' : 'FreeWriting';
    if (!ready && lastRenderedSecond >= 0) renderTime(lastRenderedSecond);
  }

  function updateDuration(value) {
    if (state !== 'ready') return;
    duration = clampMinutes(value);
    minutes.value = String(duration);
    updateInputWidth();
    minutes.setAttribute('aria-valuenow', String(duration));
    totalSeconds = duration * 60;
    $('timer').setAttribute('data-digits', duration >= 100 ? '3' : '2');
    $('increase').disabled = duration === 180;
    $('decrease').disabled = duration === 1;
    persist();
  }

  function updateInputWidth() {
    $('timer').setAttribute('data-input-digits', String(Math.max(1, Math.min(3, minutes.value.length))));
  }

  function renderTime(seconds) {
    const masked = (state === 'waiting' || state === 'writing') && hideTimer.checked;
    if (seconds === lastRenderedSecond && masked === lastTimeMasked) return;
    lastRenderedSecond = seconds;
    lastTimeMasked = masked;
    $('timer').setAttribute('data-digits', totalSeconds >= 6000 ? '3' : '2');
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    $('remaining-minutes').textContent = masked ? '--' : mm;
    $('remaining-seconds').textContent = masked ? '--' : ss;
    $('time-remaining').setAttribute('aria-label', masked ? '残り時間は非表示' : `残り${Math.floor(seconds / 60)}分${seconds % 60}秒`);
  }

  function renderProgress(milliseconds) {
    // Independent of the whole-second digits: the existing 100ms timer feeds
    // short linear CSS transitions, always recomputed from the real deadline.
    const ratio = Math.max(0, Math.min(1, milliseconds / (totalSeconds * 1000)));
    $('progress-line').setAttribute('width', String(180 * ratio));
  }

  function prepareWriting() {
    if (state !== 'ready') return;
    resetCopyFeedback();
    updateDuration(minutes.value);
    editor.value = '';
    guard.reset();
    lastEscape = null;
    pendingFinish = false;
    state = 'waiting';
    lastRenderedSecond = -1;
    renderTime(totalSeconds);
    renderProgress(totalSeconds * 1000);
    renderState();
    editor.focus({ preventScroll: true });
  }

  function beginWriting() {
    if (state !== 'waiting') return;
    state = 'writing';
    lastEscape = null;
    sessionDate = new Date();
    deadline = Date.now() + totalSeconds * 1000;
    renderState();
    if (document.activeElement !== editor) editor.focus({ preventScroll: true });
    interval = setInterval(tick, 100);
    persist();
    announce('開始しました。');
  }

  function tick() {
    const now = Date.now();
    if (state === 'writing') {
      const milliseconds = Math.max(0, deadline - now);
      const seconds = Math.ceil(milliseconds / 1000);
      renderTime(seconds);
      renderProgress(milliseconds);
      if (seconds === 0) finish('時間になりました。');
    }
  }

  function finish(reason) {
    if (state !== 'writing') return;
    clearInterval(interval);
    if (guard.composing) {
      // Let the current conversion commit before setting readonly. Locking the
      // textarea at the deadline would discard Japanese provisional text.
      pendingFinish = true;
      pendingReason = reason;
      return;
    }
    pendingFinish = false;
    lastEscape = null;
    guard.restoreCommitted();
    state = 'finished';
    renderState();
    persist();
    announce(reason);
    // Keep subsequent Enter/Space presses on the readonly text, away from the
    // destructive reset button's native keyboard activation.
    editor.focus({ preventScroll: true });
    if (editor.value.trim()) void copyText(true);
  }

  function cancelWaiting() {
    if (state !== 'waiting') return;
    state = 'ready';
    renderState();
    renderProgress(totalSeconds * 1000);
    $('start').focus({ preventScroll: true });
  }

  $('start').addEventListener('click', prepareWriting);
  $('stop').addEventListener('click', () => {
    if (state === 'waiting') {
      cancelWaiting();
      return;
    }
    // Clicking the stop button normally commits the composition via blur first.
    editor.blur();
    finish('中止しました。文章は残っています。');
  });
  $('increase').addEventListener('click', () => updateDuration(duration + 1));
  $('decrease').addEventListener('click', () => updateDuration(duration - 1));
  minutes.addEventListener('input', () => {
    if (state === 'ready') updateInputWidth();
  });
  hideTimer.addEventListener('change', () => {
    if (state !== 'ready') return;
    persist();
    renderState();
  });

  let wheelDelta = 0;
  let lastWheelAt = 0;
  $('timer').addEventListener('wheel', (event) => {
    if (state !== 'ready' || event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY) return;
    event.preventDefault();
    const now = Date.now();
    if (now - lastWheelAt > 200 || Math.sign(wheelDelta) !== Math.sign(event.deltaY)) wheelDelta = 0;
    lastWheelAt = now;
    // One mouse notch changes one minute; accumulate small trackpad deltas
    // instead of treating every pixel as a separate step.
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
    wheelDelta += event.deltaY * units;
    if (Math.abs(wheelDelta) >= 40) {
      updateDuration(clampMinutes(minutes.value) - Math.sign(wheelDelta));
      wheelDelta = 0;
    }
  }, { passive: false });
  $('timer').addEventListener('mouseleave', () => { wheelDelta = 0; });
  minutes.addEventListener('change', () => updateDuration(minutes.value));
  minutes.addEventListener('blur', () => updateDuration(minutes.value));
  minutes.addEventListener('focus', () => minutes.select());
  minutes.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      updateDuration(Number(minutes.value) + (event.key === 'ArrowUp' ? 1 : -1));
    } else if (event.key === 'Enter') {
      updateDuration(minutes.value);
      minutes.blur();
    }
  });

  let drag;
  minutes.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || state !== 'ready') return;
    drag = { y: event.clientY, value: clampMinutes(minutes.value), moved: false, id: event.pointerId };
  });
  window.addEventListener('pointermove', (event) => {
    if (!drag || drag.id !== event.pointerId || state !== 'ready') return;
    const difference = drag.y - event.clientY;
    if (!drag.moved && Math.abs(difference) < 8) return;
    if (!drag.moved) {
      minutes.setPointerCapture(event.pointerId);
      minutes.blur();
      drag.moved = true;
    }
    event.preventDefault();
    updateDuration(drag.value + Math.trunc(difference / 12));
  }, { passive: false });
  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.moved && minutes.hasPointerCapture(event.pointerId)) minutes.releasePointerCapture(event.pointerId);
    drag = undefined;
  }
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  function resetSession() {
    clearInterval(interval);
    resetCopyFeedback();
    editor.value = '';
    guard.reset();
    lastEscape = null;
    pendingFinish = false;
    state = 'ready';
    renderProgress(totalSeconds * 1000);
    renderState();
    persist();
    announce('時間を設定して開始できます。');
    $('start').focus({ preventScroll: true });
  }
  $('restart').addEventListener('click', resetSession);
  window.addEventListener('blur', () => { lastEscape = null; });

  function resetCopyFeedback() {
    copyOperation++;
    clearTimeout(copyFeedbackTimer);
    const button = $('copy');
    button.querySelector('img').src = './icons/content_copy.svg';
    button.setAttribute('aria-label', '文章をコピー');
    button.setAttribute('title', 'コピー');
  }

  async function copyText(automatic = false) {
    const text = editor.value;
    if (state !== 'finished' || !text) return false;
    resetCopyFeedback();
    const operation = copyOperation;
    const button = $('copy');
    const icon = button.querySelector('img');
    const current = () => operation === copyOperation && state === 'finished' && editor.value === text;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (!current()) return false;
      // Timer completion may lack the activation required by the browser.
      // Never steal focus or change selection in an automatic fallback.
      if (automatic) {
        button.setAttribute('title', '自動コピーできませんでした。クリックしてコピー');
        announce('自動コピーできませんでした。コピーボタンでコピーできます。');
        return false;
      }
      if ($('save-dialog').open) return false;
      editor.focus();
      editor.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* File export remains available. */ }
      if (!copied) {
        announce('コピーできませんでした。選択中の文章を手動でコピーしてください。');
        return false;
      }
    }
    if (!current()) return true;
    icon.src = './icons/check.svg';
    button.setAttribute('aria-label', 'コピーしました');
    button.setAttribute('title', 'コピーしました');
    announce(automatic ? '文章を自動コピーしました。' : 'コピーしました。');
    copyFeedbackTimer = setTimeout(() => {
      if (!current()) return;
      icon.src = './icons/content_copy.svg';
      button.setAttribute('aria-label', '文章をコピー');
      button.setAttribute('title', 'コピー');
    }, 1800);
    return true;
  }
  $('copy').addEventListener('click', () => { void copyText(); });

  function defaultFilename() {
    const pad = (n) => String(n).padStart(2, '0');
    const d = sessionDate;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}.txt`;
  }
  $('save-open').addEventListener('click', () => {
    $('filename').value = defaultFilename();
    $('save-dialog').showModal();
    $('filename').focus();
    $('filename').setSelectionRange(0, $('filename').value.length - 4);
  });
  $('save-form').addEventListener('submit', (event) => {
    event.preventDefault();
    let filename = $('filename').value.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/[. ]+$/, '');
    if (!filename) filename = defaultFilename();
    if (!filename.toLowerCase().endsWith('.txt')) filename += '.txt';
    const blob = new Blob(['\uFEFF', editor.value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    $('save-dialog').close();
    announce('保存しました。');
  });

  // Background tabs may throttle intervals. Always recompute from the deadline.
  document.addEventListener('visibilitychange', () => {
    if (state === 'writing') tick();
  });
  window.addEventListener('pagehide', persist);
  window.addEventListener('beforeunload', (event) => {
    if (!storageAvailable && (editor.value || guard.composing)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && typeof saved === 'object') {
      duration = clampMinutes(saved.minutes);
      if (typeof saved.showTimer === 'boolean') hideTimer.checked = !saved.showTimer;
      if (typeof saved.text === 'string' && saved.text.length) {
        editor.value = saved.text;
        guard.reset();
        state = 'finished';
        const restoredDate = new Date(saved.date);
        if (!Number.isNaN(restoredDate.getTime())) sessionDate = restoredDate;
      }
    }
  } catch { /* Storage may be disabled; the writing session still works. */ }
  minutes.value = String(duration);
  updateInputWidth();
  totalSeconds = duration * 60;
  renderState();
  if (state === 'ready') updateDuration(duration);
  else {
    renderTime(0);
    renderProgress(0);
  }
}

if (typeof document !== 'undefined') initializeApp();
