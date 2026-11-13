import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/display-ui.js', import.meta.url), 'utf8');

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.events = {};
    this.style = { values: {}, setProperty: (key, value) => { this.style.values[key] = value; } };
    this.classes = new Set();
    this.classList = { add: name => this.classes.add(name) };
    this.textContent = '';
  }
  appendChild(child) { this.children.push(child); return child; }
  insertBefore(child, before) {
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
  }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  emit(name) { for (const callback of this.events[name] || []) callback(); }
  getBoundingClientRect() { return { height: 44 }; }
}

function browser({ supported = true, rejected = false, readyState = 'complete' } = {}) {
  const document = new Element('document');
  document.readyState = readyState;
  document.documentElement = new Element('html');
  document.head = new Element('head');
  document.body = new Element('body');
  document.createElement = tag => new Element(tag);
  document.fullscreenEnabled = supported;
  const calls = { enter: 0, exit: 0 };
  if (supported) document.documentElement.requestFullscreen = () => {
    calls.enter++;
    if (rejected) return Promise.reject(new Error('Permission denied'));
    document.fullscreenElement = document.documentElement;
    document.emit('fullscreenchange');
    return Promise.resolve();
  };
  document.exitFullscreen = () => {
    calls.exit++;
    document.fullscreenElement = null;
    document.emit('fullscreenchange');
    return Promise.resolve();
  };
  const window = { document };
  runInNewContext(source, { window, console });
  return {
    window, document, calls,
    get button() { return document.body.children[0]?.children[1]; },
    get status() { return document.body.children[0]?.children[0]; }
  };
}

function telegram(version = '8.0') {
  const handlers = {};
  const calls = { expand: 0, enter: 0, exit: 0 };
  const sdk = {
    version, isFullscreen: false,
    safeAreaInset: { top: 24, bottom: 16, left: 0, right: 0 },
    contentSafeAreaInset: { top: 48, bottom: 0, left: 0, right: 0 },
    isVersionAtLeast: minimum => Number(version) >= Number(minimum),
    expand() { calls.expand++; },
    requestFullscreen() { calls.enter++; },
    exitFullscreen() { calls.exit++; },
    onEvent(name, callback) { handlers[name] = callback; },
    offEvent(name, callback) { if (handlers[name] === callback) delete handlers[name]; }
  };
  return { sdk, calls, emit: name => handlers[name]?.(), handlers };
}

test('browser waits for a user click and reflects enter, exit and Escape state', () => {
  const app = browser();
  assert.equal(app.calls.enter, 0, 'opening a website must not trigger browser fullscreen');
  assert.equal(app.button.textContent, 'На весь экран');
  assert.equal(app.button.type, 'button');
  app.button.emit('click');
  assert.equal(app.calls.enter, 1);
  assert.equal(app.button.attrs['aria-pressed'], 'true');
  assert.equal(app.button.textContent, 'Выйти из полного экрана');
  app.button.emit('click');
  assert.equal(app.calls.exit, 1);
  app.button.emit('click');
  app.document.fullscreenElement = null; // User presses Escape in the browser.
  app.document.emit('fullscreenchange');
  assert.equal(app.button.attrs['aria-pressed'], 'false');
  assert.equal(app.button.textContent, 'На весь экран');
});

test('fullscreen denial is announced without an unhandled rejection', async () => {
  const app = browser({ rejected: true });
  app.button.emit('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(app.status.textContent, /Браузер не разрешил/);
  assert.equal(app.status.attrs['aria-live'], 'polite');
  assert.equal(app.button.attrs['aria-pressed'], 'false');
});

test('unsupported browsers retain a usable page and explain the fallback', () => {
  const app = browser({ supported: false });
  assert.doesNotThrow(() => app.button.emit('click'));
  assert.match(app.status.textContent, /F11/);
  assert.equal(app.calls.enter, 0);
});

test('initialization is idempotent and the utility bar survives application rerenders', () => {
  const app = browser();
  const root = new Element('main');
  app.document.body.appendChild(root);
  app.window.ModusDisplay.start();
  app.window.ModusDisplay.start();
  root.children = []; // Authentication and routing replace only application content.
  assert.equal(app.document.body.children.length, 2);
  assert.equal(app.document.head.children.length, 1);
  app.button.emit('click');
  assert.equal(app.calls.enter, 1, 'one click must have one handler');
});

test('Telegram 8 expands and requests fullscreen once; host events control button state', () => {
  const app = browser();
  const tg = telegram();
  app.window.ModusDisplay.start(tg.sdk);
  app.window.ModusDisplay.start(tg.sdk);
  assert.deepEqual(tg.calls, { expand: 1, enter: 1, exit: 0 });
  assert.equal(app.calls.enter, 0, 'Telegram auto-open must not invoke browser fullscreen');
  assert.equal(app.button.attrs['aria-pressed'], 'false', 'a request is not proof of fullscreen');
  tg.sdk.isFullscreen = true;
  tg.emit('fullscreenChanged');
  assert.equal(app.button.attrs['aria-pressed'], 'true');
  app.button.emit('click');
  assert.equal(tg.calls.exit, 1);
  tg.sdk.isFullscreen = false;
  tg.emit('fullscreenChanged');
  assert.equal(app.button.attrs['aria-pressed'], 'false');
});

test('older Telegram versions expand without calling unsupported fullscreen API', () => {
  const app = browser({ supported: false });
  const tg = telegram('7.7');
  tg.sdk.onEvent = () => { throw new Error('Unsupported event'); };
  assert.doesNotThrow(() => app.window.ModusDisplay.start(tg.sdk));
  assert.deepEqual(tg.calls, { expand: 1, enter: 0, exit: 0 });
  app.button.emit('click');
  assert.match(app.status.textContent, /недоступен в этом Telegram/);
});

test('Telegram fullscreenFailed keeps the current screen usable and informs the user', () => {
  const app = browser();
  const tg = telegram();
  app.window.ModusDisplay.start(tg.sdk);
  tg.emit('fullscreenFailed');
  assert.match(app.status.textContent, /Полный экран недоступен/);
  assert.equal(app.button.attrs['aria-pressed'], 'false');
  app.button.emit('click');
  assert.equal(tg.calls.enter, 2, 'a user can retry after an automatic request failed');
});

test('safe-area events reserve room for device and Telegram controls after rotation', () => {
  const app = browser();
  const tg = telegram();
  app.window.ModusDisplay.start(tg.sdk);
  const styles = app.document.documentElement.style.values;
  assert.equal(styles['--modus-safe-top'], '72px');
  assert.equal(styles['--modus-safe-bottom'], '16px');
  tg.sdk.safeAreaInset = { top: 0, left: 24, right: 10, bottom: 8 };
  tg.sdk.contentSafeAreaInset = { top: 36, left: 2, right: 0, bottom: 2 };
  tg.emit('safeAreaChanged');
  tg.emit('contentSafeAreaChanged');
  assert.equal(styles['--modus-safe-top'], '36px');
  assert.equal(styles['--modus-safe-left'], '26px');
  assert.equal(styles['--modus-safe-bottom'], '10px');
  tg.sdk.safeAreaInset = { top: NaN, left: -1, right: Infinity };
  tg.sdk.contentSafeAreaInset = {};
  tg.emit('safeAreaChanged');
  assert.equal(styles['--modus-safe-top'], '0px');
  assert.equal(styles['--modus-safe-left'], '0px');
  assert.equal(styles['--modus-safe-right'], '0px');
});

test('script loaded in the document head waits until DOM content is available', () => {
  const app = browser({ readyState: 'loading' });
  assert.equal(app.button, undefined);
  app.document.emit('DOMContentLoaded');
  assert.equal(app.button.textContent, 'На весь экран');
  assert.equal(app.calls.enter, 0);
});
