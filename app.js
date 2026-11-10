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
  let lastEscape = null;
  const doubleEscapeMs = 400;

  // Start before WritingGuard handles the same event. In particular, an IME's
  // first compositionstart must reach the guard with writing already active.
  function handleShortcut(event) {
    if (event.defaultPrevented) return;
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
    if (state === 'finished' && (activate || escape)) {
      event.preventDefault();
      resetSession();
      return;
    }
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
    $('restart').focus({ preventScroll: true });
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

  $('copy').addEventListener('click', async () => {
    const button = $('copy');
    const icon = button.querySelector('img');
    try {
      await navigator.clipboard.writeText(editor.value);
    } catch {
      editor.focus();
      editor.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* File export remains available. */ }
      if (!copied) {
        announce('コピーできませんでした。選択中の文章を手動でコピーしてください。');
        return;
      }
    }
    icon.src = './icons/check.svg';
    button.setAttribute('aria-label', 'コピーしました');
    announce('コピーしました。');
    setTimeout(() => {
      icon.src = './icons/content_copy.svg';
      button.setAttribute('aria-label', '文章をコピー');
    }, 1800);
  });

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
if (typeof module !== 'undefined') module.exports = { WritingGuard, clampMinutes, isInsertionAt };
