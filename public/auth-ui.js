(function () {
  'use strict';
  var setupToken = '', generation = 0;
  var setupMatch = location.hash.match(/^#\/setup\/([A-Za-z0-9_-]{32,256})$/);
  if (setupMatch) {
    setupToken = setupMatch[1];
    history.replaceState(null, '', location.pathname + location.search + '#/');
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function addStyles() {
    if (document.getElementById('auth-ui-style')) return;
    var style = document.createElement('style'); style.id = 'auth-ui-style';
    style.textContent = '.auth-card{max-width:460px;margin:0 auto}.auth-logo{font-size:20px;letter-spacing:.08em;font-weight:800}.auth-logo span{color:#ff6868}.auth-intro{margin:12px 0 24px;color:var(--grey);line-height:1.7}.auth-error{color:#a51522;background:#fff0f0;border-radius:8px;padding:12px;margin:12px 0;overflow-wrap:anywhere}.auth-error:empty{display:none}.auth-form .btn.red{width:100%;margin-top:8px}.auth-form input{width:100%}.account-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.mobile-identity{font-size:11px;color:#fff;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.auth-hint{margin:20px 0 0;color:var(--grey);font-size:12px;line-height:1.6}';
    document.head.appendChild(style);
  }
  function frame(title, intro, content) {
    addStyles();
    return '<div class="pub"><header class="pubtop"><div class="auth-logo" style="max-width:1120px;margin:auto;color:white">МОДУС <span>· СИГНАЛ</span></div></header><main class="pubbody"><div class="card auth-card"><div class="eyebrow">Рабочее пространство компании</div><h1>' + esc(title) + '</h1><p class="auth-intro">' + esc(intro) + '</p>' + content + '</div></main></div>';
  }
  function request(path, body, extraHeaders) {
    return fetch(path, { method: body == null ? 'GET' : 'POST', credentials: 'same-origin', headers: Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}), body: body == null ? undefined : JSON.stringify(body) }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) { var error = new Error(data.error || 'Не удалось выполнить запрос'); error.status = response.status; error.code = data.code; throw error; }
        return data;
      });
    });
  }
  function unavailable(root, retry) {
    root.innerHTML = frame('Не удалось подключиться', 'Проверьте соединение и повторите попытку. Ваши данные остаются на сервере.', '<button class="btn red" id="authRetry">Попробовать снова</button>');
    root.querySelector('#authRetry').addEventListener('click', retry);
  }
  function loginInput() {
    return '<div class="field"><label class="f" for="authLogin">Логин</label><input class="inp" id="authLogin" name="username" required minlength="3" maxlength="100" pattern="[a-zA-Z0-9][a-zA-Z0-9._@+\\-]{2,99}" autocomplete="username" autocapitalize="none" spellcheck="false"><div class="help">Латинские буквы, цифры, . _ @ + -</div></div>';
  }
  function passwordInput(id, label, autocomplete) {
    return '<div class="field"><label class="f" for="' + id + '">' + label + '</label><input class="inp" id="' + id + '" type="password" required minlength="12" maxlength="256" autocomplete="' + autocomplete + '"><div class="help">От 12 до 256 символов.</div></div>';
  }
  function validCredentials(login, password) {
    return /^[a-z0-9][a-z0-9._@+-]{2,99}$/i.test(login) && password.length >= 12 && password.length <= 256;
  }
  function telegramInitData() {
    var app = window.Telegram && window.Telegram.WebApp;
    return app && typeof app.initData === 'string' ? app.initData : '';
  }
  function bindSubmit(form, onSubmit) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (!form.reportValidity()) return;
      var button = form.querySelector('[type="submit"]'), error = form.querySelector('[role="alert"]');
      if (button.disabled) return;
      button.disabled = true; error.textContent = '';
      Promise.resolve().then(onSubmit).catch(function (e) { error.textContent = e.message || 'Не удалось выполнить запрос'; }).finally(function () { if (button.isConnected) button.disabled = false; });
    });
  }
  function show(root, options) {
    options = options || {};
    var seq = ++generation;
    root.innerHTML = frame('Вход в систему', 'Загружаем параметры входа…', '');
    return request('/api/auth/status').then(function (status) {
      if (seq !== generation) return;
      var setup = status.setupRequired && !!setupToken;
      if (status.setupRequired && !setupToken) {
        root.innerHTML = frame('Первый запуск', 'Рабочее пространство ещё не настроено. Собственник должен открыть персональную ссылку первоначальной настройки.', '<button class="btn line" id="authRefresh">Обновить</button>');
        root.querySelector('#authRefresh').addEventListener('click', function () { show(root, options); });
        return;
      }
      if (!status.setupRequired) setupToken = '';
      var miniAppInitData = telegramInitData();
      if (!setup && !options.admin) {
        var adminButton = '<button class="btn line" type="button" id="authAdmin" style="width:100%;margin-top:16px">Вход администратора и собственника</button>';
        if (!miniAppInitData) {
          var botUsername = /^[A-Za-z0-9_]{5,32}$/.test(status.botUsername || '') ? status.botUsername : 'Modus_agent_bot';
          root.innerHTML = frame('Начните с Telegram', 'Сотрудники регистрируются через Telegram-аккаунт и группу компании.',
            '<a class="btn red" style="width:100%" href="https://t.me/' + encodeURIComponent(botUsername) + '?start=app">Войти через Telegram</a>' + adminButton);
        } else {
          root.innerHTML = frame('Регистрация сотрудника', 'Подтвердим ваш Telegram-аккаунт и участие в группе компании. Вы получите доступ сотрудника.',
            '<form class="auth-form" id="telegramForm"><div class="field"><label class="f" for="registrationName">Имя и фамилия</label><input class="inp" id="registrationName" required minlength="2" maxlength="100" autocomplete="name"></div>' +
            '<div class="field"><label class="f" for="registrationJobTitle">Ваша должность</label><input class="inp" id="registrationJobTitle" required minlength="2" maxlength="100" autocomplete="organization-title" placeholder="Например: менеджер по продажам"></div>' +
            '<div class="auth-error" role="alert"></div><button class="btn red" type="submit">Зарегистрироваться через Telegram</button></form>' + adminButton);
          var registration = root.querySelector('#telegramForm');
          bindSubmit(registration, function () {
            return request('/api/auth/telegram/register', { initData: miniAppInitData, name: registration.querySelector('#registrationName').value.trim(), jobTitle: registration.querySelector('#registrationJobTitle').value.trim() }).then(function () {
              miniAppInitData = ''; registration.reset(); ++generation;
              if (options.onSuccess) return options.onSuccess();
            });
          });
        }
        root.querySelector('#authAdmin').addEventListener('click', function () { show(root, Object.assign({}, options, { admin: true })); });
        return;
      }
      var title = setup ? 'Создайте свой доступ' : 'С возвращением';
      var intro = setup ? 'Настройте аккаунт собственника. Этот шаг выполняется один раз.' : 'Отдельный вход доступен только администратору и собственнику. Сотрудники входят через Telegram.';
      var submitLabel = setup ? 'Начать работу' : 'Войти';
      if (miniAppInitData) submitLabel += ' и привязать Telegram';
      root.innerHTML = frame(title, intro, '<form class="auth-form" id="authForm">' +
        (setup ? '<div class="field"><label class="f" for="authName">Ваше имя</label><input class="inp" id="authName" required minlength="2" maxlength="100" autocomplete="name"></div>' : '') + loginInput() +
        passwordInput('authPassword', 'Пароль', setup ? 'new-password' : 'current-password') +
        (miniAppInitData ? '<p class="help">Нажимая кнопку ниже, вы привяжете текущий аккаунт Telegram к своей учётной записи. Следующий вход из этого бота будет доступен без пароля.</p>' : '') +
        '<div class="auth-error" role="alert"></div><button class="btn red" type="submit">' + submitLabel + '</button></form>' +
        '<p class="auth-hint">' + (setup ? 'Сохраните логин и пароль в своём менеджере паролей.' : 'Забыли пароль? Обратитесь к собственнику компании.') + '</p>' + (!setup ? '<button type="button" class="btn line" id="authBack" style="margin-top:16px">Назад к Telegram</button>' : ''));
      if (!setup) root.querySelector('#authBack').addEventListener('click', function () { show(root, Object.assign({}, options, { admin: false })); });
      var form = root.querySelector('#authForm');
      bindSubmit(form, function () {
        var login = form.querySelector('#authLogin').value.trim(), password = form.querySelector('#authPassword').value;
        if (!validCredentials(login, password)) throw new Error('Проверьте формат логина и длину пароля');
        var body = { login: login, password: password };
        if (setup) { body.token = setupToken; body.name = form.querySelector('#authName').value.trim(); }
        if (miniAppInitData) body.initData = miniAppInitData;
        return request('/api/auth/' + (setup ? 'setup' : 'login'), body).then(function () {
          setupToken = ''; miniAppInitData = ''; form.reset(); ++generation;
          if (options.onSuccess) return options.onSuccess();
        });
      });
      form.querySelector('input').focus();
    }).catch(function () { if (seq === generation) unavailable(root, options.onRetry || function () { show(root, options); }); });
  }
  function credentials(options) {
    options.openModal('<h2>Доступ сотрудника</h2><p>' + esc(options.userName) + '</p><form class="auth-form" id="credentialsForm">' + loginInput() + passwordInput('authPassword', 'Новый пароль', 'new-password') +
      '<p class="help">Передайте данные сотруднику лично. При сохранении прежние сеансы сотрудника завершатся.</p><div class="auth-error" role="alert"></div><div class="row" style="justify-content:flex-end"><button class="btn line" type="button" data-act="closeModal">Отмена</button><button class="btn red" type="submit">Сохранить доступ</button></div></form>');
    var form = document.getElementById('credentialsForm');
    bindSubmit(form, function () {
      var login = form.querySelector('#authLogin').value.trim(), password = form.querySelector('#authPassword').value;
      if (!validCredentials(login, password)) throw new Error('Проверьте логин и длину пароля');
      return request('/api/admin/users/' + encodeURIComponent(options.userId) + '/credentials', { login: login, password: password }, options.headers).then(function () { form.reset(); options.onSuccess(); });
    });
  }
  function password(options) {
    options.openModal('<h2>Сменить пароль</h2><form class="auth-form" id="passwordForm">' + passwordInput('authCurrent', 'Текущий пароль', 'current-password') + passwordInput('authPassword', 'Новый пароль', 'new-password') +
      '<div class="auth-error" role="alert"></div><div class="row" style="justify-content:flex-end"><button class="btn line" type="button" data-act="closeModal">Отмена</button><button class="btn red" type="submit">Сохранить пароль</button></div></form>');
    var form = document.getElementById('passwordForm');
    bindSubmit(form, function () {
      return request('/api/auth/password', { currentPassword: form.querySelector('#authCurrent').value, password: form.querySelector('#authPassword').value }, options.headers).then(function () { form.reset(); options.onSuccess(); });
    });
  }
  addStyles();
  window.ModusAuth = { show: show, unavailable: unavailable, credentials: credentials, password: password, request: request, hasSetup: function () { return !!setupToken; } };
})();
