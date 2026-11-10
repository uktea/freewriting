'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { WritingGuard, clampMinutes } = require('../app.js');

class Element extends EventTarget {
  constructor(value = '') {
    super(); this.value = value; this.selectionStart = this.selectionEnd = value.length;
    this.hidden = false; this.readOnly = false; this.dataset = {}; this.attributes = {};
    this.icon = { src: '' };
  }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  setAttribute(key, value) { this.attributes[key] = value; }
  focus() {} blur() {} select() { this.setSelectionRange(0, this.value.length); }
  querySelector() { return this.icon; }
  setPointerCapture() {} hasPointerCapture() { return true; } releasePointerCapture() {}
  click() { send(this, 'click'); }
  showModal() { this.open = true; } close() { this.open = false; }
}
function send(element, type, props = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
  element.dispatchEvent(event);
  return event;
}
function setupGuard(value = '文章') {
  const editor = new Element(value);
  let commits = 0;
  const guard = new WritingGuard(editor, {
    active: () => true, onCommit: () => commits++, onCompositionEnd: () => {},
  });
  return { editor, guard, commits: () => commits };
}
function nativeInsert(editor, text) {
  const event = send(editor, 'beforeinput', { inputType: 'insertText' });
  if (event.defaultPrevented) return;
  const position = editor.selectionStart;
  editor.value = editor.value.slice(0, position) + text + editor.value.slice(editor.selectionEnd);
  editor.setSelectionRange(position + text.length, position + text.length);
  send(editor, 'input', { inputType: 'insertText' });
}

test('minute settings are whole minutes within 1–180', () => {
  assert.deepEqual([0, -2, 1, 2.6, 180, 999, '', 'bad'].map(clampMinutes), [1, 1, 1, 3, 180, 180, 3, 3]);
});
test('committed text cannot be deleted, cut, undone, or dragged', () => {
  const { editor } = setupGuard();
  for (const key of ['Backspace', 'Delete']) assert.equal(send(editor, 'keydown', { key }).defaultPrevented, true);
  for (const key of ['x', 'z', 'y']) assert.equal(send(editor, 'keydown', { key, ctrlKey: true }).defaultPrevented, true);
  for (const inputType of ['deleteContentBackward', 'deleteByCut', 'historyUndo', 'historyRedo']) {
    assert.equal(send(editor, 'beforeinput', { inputType }).defaultPrevented, true);
  }
  for (const type of ['cut', 'drop', 'dragstart']) assert.equal(send(editor, type).defaultPrevented, true);
});
test('typing over a selection inserts without replacing committed text', () => {
  const { editor } = setupGuard('前の文章');
  editor.setSelectionRange(0, 2);
  nativeInsert(editor, '新しい');
  assert.equal(editor.value, '前の新しい文章');
});
test('a non-cancelable mobile deletion is rolled back', () => {
  const { editor } = setupGuard('消せない');
  editor.value = '消せな';
  send(editor, 'input', { inputType: 'deleteContentBackward' });
  assert.equal(editor.value, '消せない');
});
test('Japanese conversion is allowed while manual deletion of provisional text is blocked', () => {
  const { editor, guard } = setupGuard('本文');
  send(editor, 'compositionstart');
  for (const key of ['Backspace', 'Delete']) {
    assert.equal(send(editor, 'keydown', { key, isComposing: true }).defaultPrevented, true);
  }
  for (const key of ['Enter', ' ', 'F7', 'Convert']) {
    assert.equal(send(editor, 'keydown', { key, isComposing: true }).defaultPrevented, false);
  }
  for (const inputType of ['deleteCompositionText', 'insertCompositionText', 'insertText']) {
    assert.equal(send(editor, 'beforeinput', { inputType, isComposing: true }).defaultPrevented, false);
  }
  editor.value = '本文にほんご';
  send(editor, 'input', { isComposing: true });
  editor.value = '本文にほん';
  send(editor, 'input', { isComposing: true });
  assert.equal(editor.value, '本文にほん');
  editor.value = '本文日本語';
  editor.setSelectionRange(5, 5);
  send(editor, 'compositionend', { data: '日本語' });
  send(editor, 'input', { inputType: 'insertText' });
  assert.equal(editor.value, '本文日本語');
  assert.equal(guard.composing, false);
  assert.equal(send(editor, 'keydown', { key: 'Backspace' }).defaultPrevented, true);
});
test('physical deletion keys are blocked even when the IME reports Process/229', () => {
  const { editor } = setupGuard();
  send(editor, 'compositionstart');
  for (const code of ['Backspace', 'Delete']) {
    assert.equal(send(editor, 'keydown', { key: 'Process', code, keyCode: 229, isComposing: true }).defaultPrevented, true);
  }
  assert.equal(send(editor, 'keydown', { key: 'Process', code: 'KeyA', keyCode: 229, isComposing: true }).defaultPrevented, false);
});
test('manual beforeinput deletion and undo are blocked during composition', () => {
  const { editor } = setupGuard('本文');
  send(editor, 'compositionstart');
  for (const inputType of ['deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteByCut', 'historyUndo', 'historyRedo']) {
    assert.equal(send(editor, 'beforeinput', { inputType, isComposing: true }).defaultPrevented, true);
  }
  assert.equal(send(editor, 'cut').defaultPrevented, true);
  assert.equal(send(editor, 'beforeinput', { inputType: 'deleteCompositionText', isComposing: true }).defaultPrevented, false);
});
test('shorter kanji candidates and katakana conversion still work before commit', () => {
  const { editor } = setupGuard();
  send(editor, 'compositionstart');
  for (const candidate of ['にほんご', '日本語', 'ニホンゴ']) {
    assert.equal(send(editor, 'beforeinput', { inputType: 'insertCompositionText', isComposing: true }).defaultPrevented, false);
    editor.value = '文章' + candidate;
    editor.setSelectionRange(editor.value.length, editor.value.length);
    send(editor, 'input', { isComposing: true });
    assert.equal(editor.value, '文章' + candidate);
  }
  send(editor, 'compositionend', { data: 'ニホンゴ' });
  assert.equal(editor.value, '文章ニホンゴ');
});
test('committed text cannot be reconverted or replaced by spelling suggestions', () => {
  const { editor } = setupGuard('確定済み');
  assert.equal(send(editor, 'keydown', { key: 'Convert' }).defaultPrevented, true);
  assert.equal(send(editor, 'keydown', { key: 'Process', code: 'Convert', keyCode: 229 }).defaultPrevented, true);
  assert.equal(send(editor, 'beforeinput', { inputType: 'insertReplacementText' }).defaultPrevented, true);
  editor.value = '修正した文字';
  send(editor, 'input', { inputType: 'insertReplacementText' });
  assert.equal(editor.value, '確定済み');
});
test('composition in the middle preserves both sides of the committed text', () => {
  const { editor } = setupGuard('前後');
  editor.setSelectionRange(1, 1);
  send(editor, 'compositionstart');
  editor.value = '前日本語後';
  editor.setSelectionRange(4, 4);
  send(editor, 'compositionend', { data: '日本語' });
  assert.equal(editor.value, '前日本語後');
});
test('reconversion cannot overwrite previously committed text', () => {
  const { editor } = setupGuard('確定文字');
  editor.setSelectionRange(0, 2);
  send(editor, 'compositionstart');
  editor.value = '変換文字';
  send(editor, 'compositionend', { data: '変換' });
  assert.equal(editor.value, '確定文字');
});
test('canceling an IME conversion preserves the original committed text', () => {
  const { editor } = setupGuard('もとの文章');
  send(editor, 'compositionstart');
  editor.value += 'みかくてい';
  editor.value = 'もとの文章';
  send(editor, 'compositionend', { data: '' });
  assert.equal(editor.value, 'もとの文章');
});

test('a delayed IME deletion cannot become the baseline for the next input', () => {
  const { editor, guard } = setupGuard('確定済み');
  editor.value = '確定済';
  editor.setSelectionRange(3, 3);
  send(editor, 'input', { inputType: 'deleteContentBackward', isComposing: true });
  assert.equal(guard.accepted, '確定済み');
  nativeInsert(editor, '追加');
  assert.equal(editor.value, '確定済み追加');
});

test('composition starting after a DOM deletion still protects the accepted text', () => {
  const { editor } = setupGuard('消せない本文');
  editor.value = '消せない本';
  editor.setSelectionRange(5, 5);
  send(editor, 'compositionstart');
  assert.equal(editor.value, '消せない本文');
  editor.value += 'にほん';
  send(editor, 'input', { isComposing: true });
  editor.value = '消せない本文日本';
  editor.setSelectionRange(8, 8);
  send(editor, 'compositionend', { data: '日本' });
  assert.equal(editor.value, '消せない本文日本');
});

test('a missing compositionstart does not drop the final Japanese conversion', () => {
  const { editor, guard } = setupGuard('本文');
  editor.value = '本文日本語';
  editor.setSelectionRange(5, 5);
  send(editor, 'input', { isComposing: true });
  send(editor, 'compositionend', { data: '日本語' });
  assert.equal(editor.value, '本文日本語');
  assert.equal(guard.accepted, '本文日本語');
});

test('a missing compositionstart cannot allow reconversion to replace committed text', () => {
  const { editor } = setupGuard('確定済み');
  editor.value = '日本語';
  editor.setSelectionRange(3, 3);
  send(editor, 'input', { isComposing: true });
  send(editor, 'compositionend', { data: '日本語' });
  assert.equal(editor.value, '確定済み');
});

test('the DOM is not rewritten during active candidate editing', () => {
  const { editor, guard } = setupGuard('本文');
  send(editor, 'compositionstart');
  editor.value = '本にほん';
  send(editor, 'beforeinput', { inputType: 'deleteContentBackward', isComposing: true });
  send(editor, 'input', { isComposing: true });
  assert.equal(editor.value, '本にほん');
  assert.equal(guard.accepted, '本文');
  editor.value = '本日本';
  send(editor, 'compositionend', { data: '日本' });
  assert.equal(editor.value, '本文日本');
});

function app(saved) {
  const html = readFileSync(require.resolve('../index.html'), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  elements.minutes.value = '3';
  const document = new EventTarget();
  document.body = new Element();
  document.getElementById = (id) => elements[id];
  let clock = 100000;
  const intervals = new Map();
  let intervalId = 0;
  const window = new EventTarget();
  const storage = new Map();
  if (saved) storage.set('freewriting-session-v1', JSON.stringify(saved));
  const context = {
    document, window, console, Blob, URL, navigator: {},
    Date: class extends Date { static now() { return clock; } },
    setInterval: (fn) => { intervals.set(++intervalId, fn); return intervalId; },
    clearInterval: (id) => intervals.delete(id), setTimeout: () => {},
    localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) },
  };
  vm.runInNewContext(readFileSync(require.resolve('../app.js'), 'utf8'), context);
  return {
    elements, document, window, storage,
    advance: (ms) => { clock += ms; for (const fn of [...intervals.values()]) fn(); },
    state: () => document.body.dataset.state,
  };
}
test('waiting does not spend time and can be canceled with Escape', () => {
  const a = app();
  a.elements.start.click();
  assert.equal(a.state(), 'waiting');
  assert.equal(a.elements.editor.readOnly, false);
  a.advance(600000);
  assert.equal(a.state(), 'waiting');
  assert.equal(a.elements['remaining-minutes'].textContent, '03');
  assert.equal(a.elements['remaining-seconds'].textContent, '00');
  send(a.document, 'keydown', { key: 'Escape' });
  a.advance(2000);
  assert.equal(a.state(), 'ready');
  assert.equal(a.elements.editor.hidden, true);
});
test('the first key starts immediately and its character is preserved', () => {
  const a = app();
  a.elements.start.click();
  assert.equal(send(a.elements.editor, 'keydown', { key: 'a' }).defaultPrevented, false);
  assert.equal(a.state(), 'writing');
  nativeInsert(a.elements.editor, 'a');
  assert.equal(a.elements.editor.value, 'a');
  a.advance(1000);
  assert.equal(a.elements['remaining-minutes'].textContent, '02');
  assert.equal(a.elements['remaining-seconds'].textContent, '59');
});
test('the first Japanese composition starts the timer and preserves conversion', () => {
  const a = app();
  a.elements.start.click();
  send(a.elements.editor, 'compositionstart');
  assert.equal(a.state(), 'writing');
  assert.equal(send(a.elements.editor, 'keydown', { key: 'Backspace', isComposing: true }).defaultPrevented, true);
  a.elements.editor.value = 'にほん';
  send(a.elements.editor, 'input', { isComposing: true });
  a.elements.editor.value = '日本';
  a.elements.editor.setSelectionRange(2, 2);
  send(a.elements.editor, 'compositionend', { data: '日本' });
  assert.equal(a.elements.editor.value, '日本');
  assert.equal(send(a.elements.editor, 'keydown', { key: 'Backspace' }).defaultPrevented, true);
});
test('mobile input starts without a keydown and keeps the first character', () => {
  const a = app();
  a.elements.start.click();
  nativeInsert(a.elements.editor, 'あ');
  assert.equal(a.state(), 'writing');
  assert.equal(a.elements.editor.value, 'あ');
});
test('modifiers and navigation do not accidentally start a waiting session', () => {
  const a = app();
  a.elements.start.click();
  for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'Tab', 'CapsLock']) {
    send(a.elements.editor, 'keydown', { key });
    assert.equal(a.state(), 'waiting');
  }
  send(a.elements.editor, 'keydown', { key: 'c', ctrlKey: true });
  assert.equal(a.state(), 'waiting');
  a.elements.stop.click();
  assert.equal(a.state(), 'ready');
});
test('timer reaches zero, progress recedes left, and text remains readable', () => {
  const a = app();
  a.elements.minutes.value = '1';
  send(a.elements.minutes, 'change');
  a.elements.start.click();
  send(a.elements.editor, 'keydown', { key: 'Enter' });
  assert.equal(a.state(), 'writing');
  nativeInsert(a.elements.editor, '残る文章');
  a.advance(30000);
  assert.equal(a.elements['remaining-seconds'].textContent, '30');
  assert.equal(a.elements['progress-line'].attributes.width, '90');
  a.advance(30000);
  assert.equal(a.state(), 'finished');
  assert.equal(a.elements.editor.readOnly, true);
  assert.equal(a.elements.editor.value, '残る文章');
  assert.equal(a.elements['progress-line'].attributes.width, '0');
});
test('progress decreases between whole-second digit updates and resets to full', () => {
  const a = app();
  a.elements.minutes.value = '1'; send(a.elements.minutes, 'change');
  a.elements.start.click();
  a.advance(5000);
  assert.equal(a.elements['progress-line'].attributes.width, '180');
  nativeInsert(a.elements.editor, '本文');
  a.advance(250);
  assert.equal(a.elements['remaining-minutes'].textContent, '01');
  assert.equal(a.elements['remaining-seconds'].textContent, '00');
  assert.equal(Number(a.elements['progress-line'].attributes.width), 179.25);
  a.advance(250);
  assert.equal(a.elements['remaining-seconds'].textContent, '00');
  assert.equal(Number(a.elements['progress-line'].attributes.width), 178.5);
  a.advance(59500);
  assert.equal(a.state(), 'finished');
  assert.equal(a.elements['progress-line'].attributes.width, '0');
  a.elements.restart.click();
  assert.equal(a.elements['progress-line'].attributes.width, '180');
});
test('only the active timer layer participates in focus and accessibility', () => {
  const a = app();
  assert.equal(a.elements['time-setting'].inert, false);
  assert.equal(a.elements['time-remaining'].inert, true);
  a.elements.start.click();
  assert.equal(a.elements['time-setting'].inert, true);
  assert.equal(a.elements['time-setting'].attributes['aria-hidden'], 'true');
  assert.equal(a.elements['time-remaining'].attributes['aria-hidden'], 'false');
  send(a.document, 'keydown', { key: 'Escape' });
  assert.equal(a.state(), 'ready');
  assert.equal(a.elements['time-setting'].inert, false);
  assert.equal(a.elements['time-setting'].attributes['aria-hidden'], 'false');
  assert.equal(a.elements['time-remaining'].inert, true);
});
test('deadline during Japanese composition waits for commit without dropping characters', () => {
  const a = app();
  a.elements.minutes.value = '1'; send(a.elements.minutes, 'change');
  a.elements.start.click(); send(a.elements.editor, 'keydown', { key: 'Enter' });
  nativeInsert(a.elements.editor, '本文');
  send(a.elements.editor, 'compositionstart');
  a.elements.editor.value = '本文にほんご';
  a.advance(60000);
  assert.equal(a.state(), 'writing');
  assert.equal(a.elements.editor.readOnly, false);
  send(a.document, 'keydown', { key: 'Escape', isComposing: true });
  assert.equal(a.state(), 'writing');
  a.elements.editor.value = '本文日本語';
  a.elements.editor.setSelectionRange(5, 5);
  send(a.elements.editor, 'compositionend', { data: '日本語' });
  assert.equal(a.state(), 'finished');
  assert.equal(a.elements.editor.value, '本文日本語');
  const saved = JSON.parse(a.storage.get('freewriting-session-v1'));
  assert.equal(saved.text, '本文日本語');
});
test('two quick Escape presses stop writing and preserve the text', () => {
  const a = app();
  a.elements.start.click(); send(a.elements.editor, 'keydown', { key: 'Enter' });
  nativeInsert(a.elements.editor, '中止しても残る');
  send(a.document, 'keydown', { key: 'Escape' });
  assert.equal(a.state(), 'writing');
  a.advance(200);
  send(a.document, 'keydown', { key: 'Escape' });
  assert.equal(a.state(), 'finished');
  assert.equal(a.elements.editor.value, '中止しても残る');
});
test('Space and Enter match the start button without spending time', () => {
  for (const key of [' ', 'Enter']) {
    const a = app();
    const event = send(a.document, 'keydown', { key });
    assert.equal(event.defaultPrevented, true);
    assert.equal(a.state(), 'waiting');
    // The same DOM event must not advance a second state during capture.
    a.elements.editor.dispatchEvent(event);
    assert.equal(a.state(), 'waiting');
    send(a.elements.editor, 'keydown', { key, repeat: true });
    a.advance(10000);
    assert.equal(a.state(), 'waiting');
    nativeInsert(a.elements.editor, '最初の文字');
    assert.equal(a.state(), 'writing');
    assert.equal(a.elements.editor.value, '最初の文字');
  }
});
test('Space and Enter keep their usual text editing behavior during writing', () => {
  const a = app();
  a.elements.start.click();
  send(a.elements.editor, 'keydown', { key: 'a' });
  for (const key of [' ', 'Enter']) {
    assert.equal(send(a.elements.editor, 'keydown', { key }).defaultPrevented, false);
    assert.equal(a.state(), 'writing');
  }
});
test('one Escape event is not counted twice during DOM propagation', () => {
  const a = app();
  a.elements.start.click();
  nativeInsert(a.elements.editor, '本文');
  const event = send(a.document, 'keydown', { key: 'Escape' });
  a.elements.editor.dispatchEvent(event);
  assert.equal(a.state(), 'writing');
  send(a.elements.editor, 'keydown', { key: 'Escape' });
  assert.equal(a.state(), 'finished');
});
test('Escape presses more than 400ms apart do not stop writing', () => {
  const a = app();
  a.elements.start.click(); nativeInsert(a.elements.editor, '本文');
  send(a.document, 'keydown', { key: 'Escape' });
  a.advance(401);
  send(a.document, 'keydown', { key: 'Escape' });
  assert.equal(a.state(), 'writing');
  a.advance(100);
  send(a.document, 'keydown', { key: 'Escape' });
  assert.equal(a.state(), 'finished');
});
test('holding Escape is not a double press and typing interrupts the pair', () => {
  const a = app();
  a.elements.start.click(); nativeInsert(a.elements.editor, '本文');
  send(a.document, 'keydown', { key: 'Escape' });
  for (let i = 0; i < 5; i++) {
    a.advance(20);
    send(a.document, 'keydown', { key: 'Escape', repeat: true });
    assert.equal(a.state(), 'writing');
  }
  send(a.elements.editor, 'keydown', { key: 'a' });
  send(a.document, 'keydown', { key: 'Escape' });
  assert.equal(a.state(), 'writing');
});
test('IME cancellation presses are excluded from double Escape', () => {
  const a = app();
  a.elements.start.click(); nativeInsert(a.elements.editor, '本文');
  send(a.document, 'keydown', { key: 'Escape' });
  send(a.elements.editor, 'compositionstart');
  for (let i = 0; i < 2; i++) send(a.document, 'keydown', { key: 'Escape', isComposing: true });
  a.elements.editor.value = '本文日本語';
  a.elements.editor.setSelectionRange(5, 5);
  send(a.elements.editor, 'compositionend', { data: '日本語' });
  assert.equal(a.state(), 'writing');
  send(a.document, 'keydown', { key: 'Escape' });
  assert.equal(a.state(), 'writing');
  send(a.document, 'keydown', { key: 'Escape' });
  assert.equal(a.state(), 'finished');
  assert.equal(a.elements.editor.value, '本文日本語');
});
test('Space, Enter, and Escape reset finished sessions without restarting', () => {
  for (const key of [' ', 'Enter', 'Escape']) {
    const a = app({ text: '終了した文章', minutes: 8, date: '2026-11-09T12:00:00Z' });
    assert.equal(a.state(), 'finished');
    const event = send(a.document, 'keydown', { key });
    assert.equal(event.defaultPrevented, true);
    a.elements.editor.dispatchEvent(event);
    assert.equal(a.state(), 'ready');
    assert.equal(a.elements.editor.value, '');
    assert.equal(a.elements.editor.hidden, true);
    assert.equal(a.elements.minutes.value, '8');
    assert.equal(JSON.parse(a.storage.get('freewriting-session-v1')).text, '');
    send(a.document, 'keydown', { key, repeat: true });
    assert.equal(a.state(), 'ready');
  }
});
test('shortcuts leave filename editing and IME confirmation untouched', () => {
  const a = app({ text: '保存する文章', minutes: 3, date: '2026-11-09T12:00:00Z' });
  a.elements['save-dialog'].open = true;
  for (const key of [' ', 'Enter', 'Escape']) {
    assert.equal(send(a.document, 'keydown', { key }).defaultPrevented, false);
    assert.equal(a.state(), 'finished');
  }
  a.elements['save-dialog'].open = false;
  for (const key of [' ', 'Enter', 'Escape']) {
    assert.equal(send(a.document, 'keydown', { key, isComposing: true }).defaultPrevented, false);
    assert.equal(a.state(), 'finished');
  }
});
test('a delayed IME deletion is neither persisted nor kept on stop', () => {
  const a = app();
  a.elements.start.click(); nativeInsert(a.elements.editor, '確定済み');
  a.elements.editor.value = '確定済';
  a.elements.editor.setSelectionRange(3, 3);
  send(a.elements.editor, 'input', { inputType: 'deleteContentBackward', isComposing: true });
  send(a.window, 'pagehide');
  assert.equal(JSON.parse(a.storage.get('freewriting-session-v1')).text, '確定済み');
  a.elements.stop.click();
  assert.equal(a.state(), 'finished');
  assert.equal(a.elements.editor.value, '確定済み');
  assert.equal(JSON.parse(a.storage.get('freewriting-session-v1')).text, '確定済み');
});
test('a throttled background tab uses the real deadline instead of counting ticks', () => {
  const a = app();
  a.elements.start.click();
  send(a.elements.editor, 'keydown', { key: 'Enter' });
  a.advance(200000);
  assert.equal(a.state(), 'finished');
});
test('a saved session is recovered with export available', () => {
  const a = app({ text: '前回の日本語', minutes: 8, date: '2026-11-09T12:00:00Z' });
  assert.equal(a.state(), 'finished');
  assert.equal(a.elements.editor.value, '前回の日本語');
  assert.equal(a.elements['save-open'].disabled, false);
  a.elements.restart.click();
  assert.equal(a.state(), 'ready');
  assert.equal(a.elements.editor.value, '');
  assert.equal(a.elements.minutes.value, '8');
});
test('minute arrows and vertical drag change the duration in whole minutes', () => {
  const a = app();
  a.elements.increase.click(); assert.equal(a.elements.minutes.value, '4');
  a.elements.decrease.click(); assert.equal(a.elements.minutes.value, '3');
  send(a.elements.minutes, 'pointerdown', { button: 0, clientY: 200, pointerId: 1 });
  send(a.window, 'pointermove', { clientY: 164, pointerId: 1 });
  send(a.window, 'pointerup', { pointerId: 1 });
  assert.equal(a.elements.minutes.value, '6');
});
