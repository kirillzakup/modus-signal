(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root.document) root.ModusDisplay = api;
}(typeof window === 'object' ? window : globalThis, function (win) {
  'use strict';
  var doc = win.document, tg = null, initialized = false, bound = [], button, status, bar;
  var attempted = false, observer = null;
  var css = [
    ':root{--modus-safe-top:0px;--modus-safe-right:0px;--modus-safe-bottom:0px;--modus-safe-left:0px;--modus-display-height:44px;',
    '--modus-inset-top:max(env(safe-area-inset-top,0px),var(--modus-safe-top));',
    '--modus-inset-right:max(env(safe-area-inset-right,0px),var(--modus-safe-right));',
    '--modus-inset-bottom:max(env(safe-area-inset-bottom,0px),var(--modus-safe-bottom));',
    '--modus-inset-left:max(env(safe-area-inset-left,0px),var(--modus-safe-left));',
    '--modus-sticky-top:calc(var(--modus-inset-top) + var(--modus-display-height));}',
    'html.modus-display body{height:auto;min-height:100dvh;box-sizing:border-box;padding:var(--modus-inset-top) var(--modus-inset-right) var(--modus-inset-bottom) var(--modus-inset-left)}',
    '.modus-display-bar{position:sticky;top:var(--modus-inset-top);z-index:80;min-height:44px;box-sizing:border-box;display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:4px 16px;background:#082742;color:#fff;border-bottom:1px solid #29465f;font:12px/1.4 "Segoe UI",Arial,sans-serif}',
    '.modus-display-button{min-height:36px;flex:none;padding:6px 12px;background:#183e5b;color:#fff;border:1px solid #59748b;border-radius:7px;font:inherit;cursor:pointer}',
    '.modus-display-button:hover{background:#244d6d}.modus-display-button:focus-visible{outline:3px solid #a7d4ff;outline-offset:2px}',
    '.modus-display-status{margin:0;max-width:700px;color:#d4e2ed;font-size:12px}',
    '.modus-display .top,.modus-display .mtop{top:var(--modus-sticky-top)}',
    '.modus-display .side{top:var(--modus-sticky-top);height:calc(100dvh - var(--modus-sticky-top) - var(--modus-inset-bottom))}',
    '.modus-display .app,.modus-display .pub{min-height:calc(100dvh - var(--modus-sticky-top) - var(--modus-inset-bottom))}',
    '.modus-display .view{max-width:none}.modus-display .side-card{top:calc(var(--modus-sticky-top) + 100px)}',
    '.modus-display .bnav{left:var(--modus-inset-left);right:var(--modus-inset-right);bottom:var(--modus-inset-bottom);padding-bottom:6px}',
    '.modus-display .ov{top:var(--modus-inset-top);right:var(--modus-inset-right);bottom:var(--modus-inset-bottom);left:var(--modus-inset-left)}',
    '.modus-display .panel{top:calc(var(--modus-sticky-top) + 70px)}',
    '@media(max-width:860px){.modus-display-bar{gap:8px;padding:4px 12px}.modus-display-status{font-size:11px}.modus-display .side-card{position:static}.modus-display .panel{top:calc(var(--modus-sticky-top) + 64px)}}'
  ].join('\n');

  function message(text) { if (status) status.textContent = text; }
  function supportedTelegram() {
    if (!tg || typeof tg.requestFullscreen !== 'function') return false;
    try {
      return typeof tg.isVersionAtLeast === 'function' ? tg.isVersionAtLeast('8.0') : parseFloat(tg.version) >= 8;
    } catch (_) { return false; }
  }
  function fullscreen() { return !!(doc && doc.fullscreenElement) || !!(tg && tg.isFullscreen); }
  function refresh() {
    if (!button) return;
    var active = fullscreen();
    button.textContent = active ? 'Выйти из полного экрана' : 'На весь экран';
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('title', active ? 'Вернуть обычный размер окна' : 'Развернуть рабочее пространство');
    if (active) message('');
    updateInsets();
  }
  function inset(value) { return Number.isFinite(value) && value >= 0 ? Math.min(value, 1000) : 0; }
  function updateInsets() {
    if (!doc) return;
    ['top', 'right', 'bottom', 'left'].forEach(function (side) {
      var device = tg && tg.safeAreaInset || {};
      var content = tg && tg.contentSafeAreaInset || {};
      // Device and Telegram chrome are separate safe areas, both need room.
      var pixels = inset(device[side]) + inset(content[side]);
      doc.documentElement.style.setProperty('--modus-safe-' + side, pixels + 'px');
    });
  }
  function failure() {
    refresh();
    message(tg ? 'Полный экран недоступен в этом Telegram. Продолжайте работу в обычном окне.' : 'Браузер не разрешил полный экран. Попробуйте кнопку ещё раз или нажмите F11 на компьютере.');
  }
  function observeResult(result) { if (result && typeof result.catch === 'function') result.catch(failure); }
  function toggle() {
    // Browser fullscreen is requested only inside the user's click handler.
    try {
      if (doc.fullscreenElement) {
        if (typeof doc.exitFullscreen === 'function') observeResult(doc.exitFullscreen());
        else failure();
      } else if (tg && tg.isFullscreen) {
        if (typeof tg.exitFullscreen === 'function') observeResult(tg.exitFullscreen());
        else failure();
      } else if (supportedTelegram()) {
        observeResult(tg.requestFullscreen());
      } else if (typeof doc.documentElement.requestFullscreen === 'function' && doc.fullscreenEnabled !== false) {
        observeResult(doc.documentElement.requestFullscreen());
      } else {
        failure();
      }
    } catch (_) { failure(); }
  }
  function unbindTelegram() {
    bound.forEach(function (entry) {
      try { if (tg && typeof tg.offEvent === 'function') tg.offEvent(entry[0], entry[1]); } catch (_) {}
    });
    bound = [];
  }
  function bindTelegram(name, callback) {
    try {
      if (typeof tg.onEvent === 'function') { tg.onEvent(name, callback); bound.push([name, callback]); }
    } catch (_) { /* Older Telegram clients may not expose newer events. */ }
  }
  function attachTelegram(next) {
    if (!next || next === tg) return;
    unbindTelegram();
    tg = next;
    attempted = false;
    bindTelegram('fullscreenChanged', refresh);
    bindTelegram('fullscreenFailed', failure);
    bindTelegram('safeAreaChanged', updateInsets);
    bindTelegram('contentSafeAreaChanged', updateInsets);
    try { if (typeof tg.expand === 'function') tg.expand(); } catch (_) { /* Expansion is optional. */ }
    updateInsets();
    if (supportedTelegram() && !tg.isFullscreen && !attempted) {
      attempted = true;
      try { observeResult(tg.requestFullscreen()); } catch (_) { failure(); }
    }
    refresh();
  }
  function start(telegram) {
    if (!doc || !doc.body) return;
    if (!initialized) {
      initialized = true;
      var style = doc.createElement('style');
      style.id = 'modus-display-style';
      style.textContent = css;
      doc.head.appendChild(style);
      bar = doc.createElement('div');
      bar.className = 'modus-display-bar';
      bar.setAttribute('role', 'region');
      bar.setAttribute('aria-label', 'Размер окна приложения');
      status = doc.createElement('p');
      status.className = 'modus-display-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      button = doc.createElement('button');
      button.className = 'modus-display-button';
      button.type = 'button';
      button.addEventListener('click', toggle);
      bar.appendChild(status);
      bar.appendChild(button);
      doc.body.insertBefore(bar, doc.body.firstChild);
      doc.documentElement.classList.add('modus-display');
      doc.addEventListener('fullscreenchange', refresh);
      doc.addEventListener('fullscreenerror', failure);
      if (typeof win.ResizeObserver === 'function') {
        observer = new win.ResizeObserver(function () {
          doc.documentElement.style.setProperty('--modus-display-height', Math.ceil(bar.getBoundingClientRect().height) + 'px');
        });
        observer.observe(bar);
      }
    }
    if (telegram) attachTelegram(telegram);
    refresh();
  }
  if (doc) {
    var autoStart = function () { start(); };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', autoStart, { once: true });
    else autoStart();
  }
  return { start: start };
}));
