/*!
 * МОДУС · СИГНАЛ — ядро бизнес-логики
 * Система обратной связи и предложений сотрудников ГК «Модус Трейд».
 * Один и тот же модуль работает в браузере (автономный режим / Telegram Mini App)
 * и на сервере (Node.js), поэтому правила маршрутизации, статусов, SLA, прав
 * и начисления баллов определены в одном месте.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ModusCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HOUR = 3600 * 1000, DAY = 24 * HOUR;

  /* ───────────────────────── Справочники ───────────────────────── */

  var TYPES = {
    problem: { label: 'Проблема', short: 'Проблема', icon: '⚠' },
    idea:    { label: 'Предложение', short: 'Идея', icon: '✦' },
    praise:  { label: 'Положительный отзыв', short: 'Отзыв', icon: '♥' }
  };

  var STATUSES = {
    new:      { label: 'Новое',             tone: 'blue',   open: true  },
    review:   { label: 'На рассмотрении',   tone: 'navy',   open: true  },
    clarify:  { label: 'Ожидает уточнения', tone: 'amber',  open: true  },
    work:     { label: 'В работе',          tone: 'red',    open: true  },
    done:     { label: 'Реализовано',       tone: 'green',  open: false },
    rejected: { label: 'Отклонено',         tone: 'grey',   open: false },
    closed:   { label: 'Закрыто',           tone: 'green',  open: false },
    trash:    { label: 'В корзине',         tone: 'grey',   open: false }
  };
  var STATUS_ORDER = ['new', 'review', 'clarify', 'work', 'done', 'rejected', 'closed'];

  // Допустимые переходы статусов (сквозной процесс «сигнал → решение → результат»)
  var FLOW = {
    new:      ['review', 'clarify', 'work', 'rejected', 'closed', 'trash'],
    review:   ['clarify', 'work', 'rejected', 'done', 'closed'],
    clarify:  ['review', 'work', 'rejected'],
    work:     ['done', 'clarify', 'rejected'],
    done:     ['work', 'closed'],       // переоткрытие (например, эффект не подтвердился на аудите)
    rejected: ['review'],     // пересмотр мотивированного отказа
    closed:   ['review'],
    trash:    ['new']      // возврат из корзины во входящие собственника
  };

  var PRIORITIES = {
    low:    { label: 'Низкий',  respondH: 72, resolveD: 20 },
    medium: { label: 'Средний', respondH: 48, resolveD: 10 },
    high:   { label: 'Высокий', respondH: 24, resolveD: 5 }
  };

  var ROLES = {
    employee: 'Сотрудник',
    manager:  'Руководитель / ответственный',
    admin:    'Администратор системы',
    owner:    'Собственник'
  };

  // Баллы начисляются за ценность, а не за количество: после валидации, принятия и внедрения
  var POINTS = {
    signal:      { amount: 5,  label: 'Сигнал подтверждён ответственным' },
    solution:    { amount: 15, label: 'Предложенное решение принято в работу' },
    implemented: { amount: 30, label: 'Улучшение внедрено' },
    impact:      { amount: 20, label: 'Подтверждён измеримый эффект «Было → Стало»' },
    praise:      { amount: 3,  label: 'Положительный отзыв передан команде' },
    fast:        { amount: 5,  label: 'Быстрый ответ на обращение' },
    mentor:      { amount: 10, label: 'Помог автору доработать идею до решения' },
    delivered:   { amount: 10, label: 'Довёл улучшение до результата' },
    executor:    { amount: 20, label: 'Сам взялся и решил проблему' },
    bonus:       { amount: 0,  label: 'Поощрение собственника' },
    kudos:       { amount: 2,  label: 'Благодарность коллеги' },
    optionProposed: { amount: 5,  label: 'Предложили способ решить проблему' },
    optionVoted: { amount: 2,  label: 'Проголосовали за решение' },
    quest:       { amount: 0,  label: 'Задание недели' },
    chest:       { amount: 0,  label: 'Сундук' },
    streak:      { amount: 20, label: 'Серия 4+ недель' },
    welcome:     { amount: 10, label: 'Стартовый бонус' },
    optionChosen:{ amount: 15, label: 'Ваш вариант решения выбран' },
    step:        { amount: 5,  label: 'Выполнен шаг плана решения' },
    verified:    { amount: 15, label: 'Эффект решения подтверждён проверкой' }
  };

  var LEVELS = [
    { min: 0,   name: 'Наблюдатель' },
    { min: 20,  name: 'Сигнальщик' },
    { min: 60,  name: 'Соавтор улучшений' },
    { min: 150, name: 'Эксперт процессов' },
    { min: 300, name: 'Архитектор изменений' }
  ];

  var ACHIEVEMENTS = [
    { id: 'first',    icon: '◉', name: 'Первый сигнал',       desc: 'Отправлено первое обращение' },
    { id: 'coauthor', icon: '✦', name: 'Соавтор',             desc: 'Решение принято в работу' },
    { id: 'changer',  icon: '★', name: 'Изменил процесс',     desc: 'Улучшение внедрено' },
    { id: 'systemic', icon: '▣', name: 'Системный мыслитель', desc: '3 обращения с вариантом решения' },
    { id: 'measured', icon: '↗', name: 'Цифры говорят',       desc: 'Подтверждён эффект «Было → Стало»' },
    { id: 'voice',    icon: '+', name: 'Голос команды',       desc: 'Поддержано 3 чужих обращения' },
    { id: 'fast',     icon: '⏱', name: 'Быстрый ответ',       desc: '3 первых ответа в пределах SLA' },
    { id: 'mentor',   icon: '◆', name: 'Ментор',              desc: 'Доработал «сырую» идею с автором' },
    { id: 'leader',   icon: '▲', name: 'Лидер изменений',     desc: '2 внедрённых улучшения в зоне ответственности' }
  ];

  // Магазин мотивации. cost — в монетах; stock — сколько штук на квартал (null — без лимита);
  // perUser — сколько раз один человек может получить за квартал (null — без лимита)
  var REWARDS = [
    { id: 'merch',   icon: '👕', name: 'Мерч «Модус Трейд»',              cost: 50,   stock: null, perUser: null, desc: 'Худи, термокружка или рюкзак с логотипом' },
    { id: 'cert',    icon: '🎁', name: 'Подарочный сертификат',           cost: 80,   stock: null, perUser: 2,    desc: 'Книжный, маркетплейс или кафе — на выбор' },
    { id: 'lunch',   icon: '🍽', name: 'Обед с собственником',            cost: 120,  stock: 4,    perUser: 1,    desc: 'Обсудить свою идею напрямую, без посредников' },
    { id: 'gym',     icon: '🏋', name: 'Абонемент в спортзал на месяц',   cost: 150,  stock: 10,   perUser: 3,    desc: 'Фитнес-клуб или бассейн рядом с офисом' },
    { id: 'course',  icon: '🎓', name: 'Обучение или сертификация у вендора', cost: 250, stock: 6, perUser: 1,  desc: 'Курс по системам безопасности за счёт компании' },
    { id: 'dayoff',  icon: '🌴', name: 'Заслуженный выходной',            cost: 300,  stock: null, perUser: 1,    desc: 'Дата согласуется с руководителем' },
    { id: 'vacday',  icon: '📅', name: '+1 день к отпуску',               cost: 400,  stock: null, perUser: 1,    desc: 'Добавляется к ежегодному отпуску' },
    { id: 'bonus',   icon: '💰', name: 'Денежная премия 5 000 ₽',         cost: 500,  stock: 5,    perUser: 1,    desc: 'Выплачивается с ближайшей зарплатой' },
    { id: 'trip',    icon: '✈', name: 'Вклад в путёвку к отпуску',       cost: 1500, stock: 2,    perUser: 1,    desc: 'Компания оплачивает часть путёвки — сумму утверждает собственник' }
  ];

  /* ───────────────────────── Утилиты ───────────────────────── */

  function iso(t) { return new Date(t).toISOString(); }
  function ts(s) { return s ? new Date(s).getTime() : 0; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function err(code, message) { var e = new Error(message); e.code = code; e.status = code === 'forbidden' ? 403 : code === 'not_found' ? 404 : 400; return e; }
  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function trim(s) { return (s == null ? '' : String(s)).trim(); }
  function nextId(state, key, prefix, pad) {
    state.seq[key] = (state.seq[key] || 0) + 1;
    var n = String(state.seq[key]);
    while (n.length < (pad || 0)) n = '0' + n;
    return (prefix || '') + n;
  }

  var STOP = ' и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это предлагаю нужно нужен нужна хотелось бы было полезно можно ли также очень '.split(' ');
  var STOPSET = {}; STOP.forEach(function (w) { if (w) STOPSET[w] = 1; });
  function tokens(text) {
    return trim(text).toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).filter(function (w) {
      return w.length > 3 && !STOPSET[w];
    }).map(function (w) { return w.slice(0, 6); }); // грубый стемминг: корень до 6 символов
  }

  /* ───────────────────────── Справочные данные ───────────────────────── */

  var DEPARTMENTS = ['Закупки', 'Проектирование', 'Бухгалтерия', 'Продажи', 'Проектный офис', 'Администрация', 'IT-разработка', 'HR и коммуникации', 'Сервис и ПНР', 'Управление'];

  function demoUsers() {
    // Условные роли из демонстрационного набора — без имён реальных людей
    return [
      { id: 'u1',  name: 'Сотрудник закупок',            role: 'employee', dept: 'Закупки' },
      { id: 'u2',  name: 'Сотрудник проектирования',     role: 'employee', dept: 'Проектирование' },
      { id: 'u3',  name: 'Сотрудник бухгалтерии',        role: 'employee', dept: 'Бухгалтерия' },
      { id: 'u4',  name: 'Менеджер по продажам',         role: 'employee', dept: 'Продажи' },
      { id: 'u5',  name: 'Координатор проекта',          role: 'employee', dept: 'Проектный офис' },
      { id: 'u6',  name: 'Руководитель проекта',         role: 'employee', dept: 'Проектный офис' },
      { id: 'u7',  name: 'Сотрудник офиса',              role: 'employee', dept: 'Администрация' },
      { id: 'u8',  name: 'Инженер сервиса',              role: 'employee', dept: 'Сервис и ПНР' },
      { id: 'm1',  name: 'Руководитель закупок',         role: 'manager',  dept: 'Закупки' },
      { id: 'm2',  name: 'Руководитель направления',     role: 'manager',  dept: 'Управление' },
      { id: 'm3',  name: 'Ответственный за номенклатуру',role: 'manager',  dept: 'Закупки', absent: true, absentNote: 'В отпуске' },
      { id: 'm4',  name: 'Ответственный за обучение',    role: 'manager',  dept: 'HR и коммуникации' },
      { id: 'm5',  name: 'Руководитель бухгалтерии',     role: 'manager',  dept: 'Бухгалтерия' },
      { id: 'm6',  name: 'Ответственный за процессы',    role: 'manager',  dept: 'Управление' },
      { id: 'm7',  name: 'IT-специалист',                role: 'manager',  dept: 'IT-разработка' },
      { id: 'm8',  name: 'Руководитель подразделения',   role: 'manager',  dept: 'Управление' },
      { id: 'm9',  name: 'Ответственный за договоры',    role: 'manager',  dept: 'Продажи' },
      { id: 'm10', name: 'Руководитель продаж',          role: 'manager',  dept: 'Продажи' },
      { id: 'm11', name: 'Руководитель проектов',        role: 'manager',  dept: 'Проектный офис' },
      { id: 'm12', name: 'Руководитель проектирования',  role: 'manager',  dept: 'Проектирование' },
      { id: 'm13', name: 'Административный руководитель',role: 'manager',  dept: 'Администрация' },
      { id: 'm14', name: 'HR / внутренние коммуникации', role: 'manager',  dept: 'HR и коммуникации' },
      { id: 'm15', name: 'Администратор документов',     role: 'manager',  dept: 'Администрация' },
      { id: 'a1',  name: 'Администратор системы',        role: 'admin',    dept: 'IT-разработка' },
      { id: 'o1',  name: 'Собственник',                  role: 'owner',    dept: 'Управление' }
    ];
  }

  function demoCategories() {
    // owner — основной ответственный, backup — замещающий при отсутствии
    return [
      { id: 'c01', name: 'Межотдельное взаимодействие', owner: 'm1',  backup: 'm2' },
      { id: 'c02', name: 'Информационная прозрачность', owner: 'm2',  backup: 'm8' },
      { id: 'c03', name: 'Каталог и данные',            owner: 'm3',  backup: 'm1' },
      { id: 'c04', name: 'Обучение',                    owner: 'm4',  backup: 'm14' },
      { id: 'c05', name: 'Документооборот',             owner: 'm5',  backup: 'm6' },
      { id: 'c06', name: 'Регламенты',                  owner: 'm6',  backup: 'm2' },
      { id: 'c07', name: 'Интеграции и IT',             owner: 'm7',  backup: 'a1' },
      { id: 'c08', name: 'Знания и наставничество',     owner: 'm8',  backup: 'm4' },
      { id: 'c09', name: 'Договорная работа',           owner: 'm9',  backup: 'm10' },
      { id: 'c10', name: 'Задачи и коммуникации',       owner: 'm10', backup: 'm2' },
      { id: 'c11', name: 'Оперативность',               owner: 'm2',  backup: 'm8' },
      { id: 'c12', name: 'Коммуникации',                owner: 'm7',  backup: 'm14' },
      { id: 'c13', name: 'Проектная деятельность',      owner: 'm11', backup: 'm2' },
      { id: 'c14', name: 'Планирование ресурсов',       owner: 'm12', backup: 'm11' },
      { id: 'c15', name: 'Постановка задач',            owner: 'm2',  backup: 'm8' },
      { id: 'c16', name: 'Корпоративная среда',         owner: 'm13', backup: 'm14', praiseOwner: 'm14' },
      { id: 'c17', name: 'Хранение документов',         owner: 'm15', backup: 'm6' },
      { id: 'c18', name: 'Прозрачность результатов',    owner: 'm8',  backup: 'm2' }
    ];
  }

  function emptyState() {
    return {
      version: 1,
      seq: {},
      users: demoUsers(),
      departments: DEPARTMENTS.slice(),
      categories: demoCategories(),
      tickets: [],
      events: [],
      ledger: [],
      notifications: [],
      redemptions: [],
      chat: [],
      reports: [],
      chests: [],
      rewards: REWARDS.slice(),
      entries: [],
      settings: { anonymousAllowed: true, solutionRequiredForIdeas: true, escalateAfterFactor: 2, fallbackUser: 'a1', ownerTriage: true, deputyId: '', trashDays: 30, triageRemindH: 24 }
    };
  }

  /* ───────────────────────── Права доступа ───────────────────────── */

  function user(state, id) { return byId(state.users, id); }
  function isStaff(u) { return !!u && (u.role === 'manager' || u.role === 'admin' || u.role === 'owner'); }
  function isAdmin(u) { return !!u && (u.role === 'admin' || u.role === 'owner'); }
  // Фильтр собственника: новое обращение сначала разбирает собственник (или его заместитель)
  function triageOn(state) { return !!(state.settings && state.settings.ownerTriage); }
  function isTriager(state, u) { return !!u && (u.role === 'owner' || (!!state.settings.deputyId && state.settings.deputyId === u.id)); }
  function triagers(state) { return state.users.filter(function (x) { return isTriager(state, x); }); }
  function pending(state, t) { return triageOn(state) && (t.status === 'new' || t.status === 'trash'); }
  function canSee(state, u, t) { return !pending(state, t) || isTriager(state, u) || isAuthor(u, t); }
  function canManage(state, u, t) {
    if (!u || u.disabled === true || u.active === false || !t) return false;
    if (pending(state, t)) return isTriager(state, u);
    if (isAdmin(u) || isTriager(state, u)) return true;
    if (t.assigneeId === u.id) return true;
    if (u.role !== 'manager') return false;
    var c = byId(state.categories, t.categoryId);
    return !!(c && (c.owner === u.id || c.backup === u.id));
  }
  function canSeeInternal(state, u, t) { return isStaff(u) || canManage(state, u, t); }
  function isAuthor(u, t) { return !!(u && t && t.authorId === u.id); }

  // Что видит конкретный пользователь: автор анонимного обращения скрыт от всех,
  // внутренние комментарии ответственных скрыты от сотрудников
  function sanitize(state, viewerId, t, withEvents) {
    var u = user(state, viewerId);
    var o = clone(t);
    if (t.team) o.team = teamView(state, viewerId, t);
    var author = user(state, t.authorId);
    o.mine = isAuthor(u, t);
    o.canManage = canManage(state, u, t);
    o.authorName = t.anonymous ? 'Анонимно' : (author ? author.name : (t.external ? ((t.contact && t.contact.name) || 'Внешний автор') : '—'));
    var seeContact = o.canManage || isTriager(state, u);
    if (!seeContact) { delete o.contact; if (t.external && !t.anonymous) o.authorName = 'Внешний автор'; }
    if (!seeContact && !o.mine) delete o.trackCode;
    o.pending = pending(state, t); o.canTriage = o.pending && isTriager(state, u); o.canConfirm = t.status === 'done' && (triageOn(state) ? isTriager(state, u) : o.canManage);
    var en = t.entryId ? byId(state.entries || [], t.entryId) : null;
    o.entryName = en ? en.name : (t.source === 'bot' || t.source === 'tma' ? 'Telegram' : 'Приложение'); o.entryKind = en ? en.kind : 'app';
    o.board = boardOf(t); o.next = nextOf(state, t);
    var sg = user(state, t.suggestAssigneeId || suggestAssignee(state, t)); o.suggestAssigneeId = sg ? sg.id : null; o.suggestAssigneeName = sg ? sg.name : '';
    o.authorDept = t.anonymous ? '—' : (t.dept || (author && author.dept) || '—');
    o.mine = isAuthor(u, t);
    if (t.anonymous) o.authorId = o.mine ? t.authorId : null;
    var a = user(state, t.assigneeId);
    o.assigneeName = a ? a.name : 'Не назначен';
    var ex = user(state, t.executorId); o.executorName = ex ? ex.name : '';
    o.stage = stageOf(t, Date.now()); o.stageLabel = STAGES[o.stage].label; o.planProgress = planProgress(t);
    o.options = (t.options || []).map(function (x) { var y = clone(x), au = user(state, x.userId); y.userName = t.anonymous && x.userId === t.authorId ? 'Автор (анонимно)' : (au ? au.name : '—'); if (t.anonymous && x.userId === t.authorId && !o.mine) y.userId = null; y.votesCount = x.votes.length; y.voted = !!(u && x.votes.indexOf(u.id) >= 0); y.chosen = !!(t.decision && t.decision.optionId === x.id); delete y.votes; return y; });
    if (t.team) o.options.forEach(function (x) { x.votesCount = teamIds(state, t).filter(function (id) { return t.team.ballots[id] === x.id; }).length; x.voted = t.team.ballots[viewerId] === x.id; });
    o.plan = (t.plan || []).map(function (x) { var y = clone(x), au = user(state, x.assigneeId); y.assigneeName = au ? au.name : '—'; y.overdue = stepOverdue(x, Date.now()); y.mineStep = !!(u && x.assigneeId === u.id); return y; });
    if (t.decision) { o.decision = clone(t.decision); o.decision.byName = (user(state, t.decision.by) || {}).name; }
    o.canPlan = canPlan(state, u, t);
    o.paei = paeiOf(t); o.quadrant = t.type === 'praise' ? null : quadrant(t, Date.now()); o.importantAuto = t.important == null;
    var c = byId(state.categories, t.categoryId);
    o.categoryName = c ? c.name : '—';
    o.overdue = overdueInfo(t, Date.now());
    o.votesCount = (t.votes || []).length;
    o.voted = !!(u && (t.votes || []).indexOf(u.id) >= 0);
    delete o.votes; delete o.voteLog;
    if (withEvents) {
      o.events = state.events.filter(function (e) {
        if (e.ticketId !== t.id) return false;
        if (e.internal && !canSeeInternal(state, u, t)) return false;
        return true;
      }).map(function (e) {
        var x = clone(e), eu = user(state, e.userId);
        x.userName = e.userId === t.authorId && t.anonymous ? (o.mine ? 'Вы (анонимно)' : 'Автор (анонимно)') : (eu ? eu.name : 'Система');
        if (t.anonymous && e.userId === t.authorId && !o.mine) x.userId = null;
        return x;
      });
      o.similar = findSimilar(state, t.title + ' ' + t.text, t.id, 3, viewerId).map(function (s) {
        return { id: s.ticket.id, title: s.ticket.title, status: s.ticket.status, score: s.score };
      });
    }
    return o;
  }

  /* ───────────────────────── Маршрутизация ───────────────────────── */

  // Правило: тип «отзыв» → HR-коммуникации категории; иначе владелец категории;
  // если владелец отсутствует → замещающий; если и он отсутствует → администратор
  function route(state, categoryId, type) {
    var c = byId(state.categories, categoryId);
    var trail = [];
    if (!c) return { assigneeId: state.settings.fallbackUser, trail: ['Категория не найдена → администратор'] };
    var chain = [];
    if (type === 'praise' && c.praiseOwner) chain.push(c.praiseOwner);
    chain.push(c.owner, c.backup, state.settings.fallbackUser);
    for (var i = 0; i < chain.length; i++) {
      var u = user(state, chain[i]);
      if (!u) continue;
      if (u.absent) { trail.push(u.name + ' — ' + (u.absentNote || 'отсутствует')); continue; }
      return { assigneeId: u.id, trail: trail, fallback: trail.length > 0 };
    }
    return { assigneeId: state.settings.fallbackUser, trail: trail, fallback: true };
  }

  /* ───────────────────────── SLA ───────────────────────── */

  function computeDue(priority, createdAt) {
    var p = PRIORITIES[priority] || PRIORITIES.medium, c = ts(createdAt);
    return { respondDue: iso(c + p.respondH * HOUR), resolveDue: iso(c + p.resolveD * DAY) };
  }

  function overdueInfo(t, now) {
    now = now || Date.now();
    if (!STATUSES[t.status] || !STATUSES[t.status].open) return null;
    if (!t.firstResponseAt && now > ts(t.respondDue)) return { kind: 'response', hours: Math.round((now - ts(t.respondDue)) / HOUR), label: 'Нет первого ответа' };
    if (t.status !== 'clarify' && now > ts(t.resolveDue)) return { kind: 'resolve', hours: Math.round((now - ts(t.resolveDue)) / HOUR), label: 'Срок решения истёк' };
    return null;
  }

  /* ───────────────────────── События, уведомления, баллы ───────────────────────── */

  function addEvent(state, t, userId, kind, data, at) {
    var e = { id: nextId(state, 'event', 'e'), ticketId: t.id, userId: userId, kind: kind, at: at };
    for (var k in data) if (data.hasOwnProperty(k)) e[k] = data[k];
    state.events.push(e);
    return e;
  }

  function notify(state, userId, t, text, at) {
    if (!userId) return;
    state.notifications.push({ id: nextId(state, 'notif', 'n'), userId: userId, ticketId: t ? t.id : null, text: text, at: at, read: false, delivered: false });
  }

  function award(state, userId, t, kind, at) {
    if (!userId || !POINTS[kind]) return null;
    for (var i = 0; i < state.ledger.length; i++) {
      var l = state.ledger[i];
      if (l.userId === userId && l.ticketId === (t ? t.id : null) && l.kind === kind) return null; // один раз за обращение
    }
    var rec = { id: nextId(state, 'ledger', 'p'), userId: userId, ticketId: t ? t.id : null, kind: kind, amount: POINTS[kind].amount, label: POINTS[kind].label, at: at };
    state.ledger.push(rec);
    return rec;
  }

  function balance(state, userId) {
    var earned = 0, spent = 0;
    state.ledger.forEach(function (l) { if (l.userId === userId) earned += l.amount; });
    state.redemptions.forEach(function (r) { if (r.userId === userId && r.state !== 'rejected') spent += r.cost; });
    return { earned: earned, spent: spent, coins: earned - spent };
  }

  function level(points) {
    var cur = LEVELS[0], next = null;
    for (var i = 0; i < LEVELS.length; i++) { if (points >= LEVELS[i].min) { cur = LEVELS[i]; next = LEVELS[i + 1] || null; } }
    return { name: cur.name, min: cur.min, next: next, progress: next ? (points - cur.min) / (next.min - cur.min) : 1 };
  }

  /* ───────────────────────── Похожие обращения ───────────────────────── */

  function findSimilar(state, text, excludeId, limit, viewerId) {
    var a = tokens(text), set = {};
    a.forEach(function (w) { set[w] = 1; });
    var keys = Object.keys(set);
    if (keys.length < 2) return [];
    var res = [];
    state.tickets.forEach(function (t) {
      if (t.id === excludeId || t.type === 'praise' || (viewerId !== undefined && !canSee(state, user(state, viewerId), t))) return;
      var b = tokens(t.title + ' ' + t.text), bs = {}, inter = 0;
      b.forEach(function (w) { bs[w] = 1; });
      var bk = Object.keys(bs);
      keys.forEach(function (w) { if (bs[w]) inter++; });
      var union = keys.length + bk.length - inter;
      var score = union ? inter / union : 0;
      if (inter >= 2 && score >= 0.12) res.push({ ticket: t, score: Math.round(score * 100) / 100 });
    });
    res.sort(function (x, y) { return y.score - x.score; });
    return res.slice(0, limit || 3);
  }

  /* ───────────────────────── Операции ───────────────────────── */

  function createTicket(state, actorId, data, now) {
    var u = user(state, actorId), tri = triageOn(state), ext = !!(data && data._external);
    if (!u && !ext) throw err('forbidden', 'Пользователь не найден');
    var at = iso(now || Date.now());
    var type = TYPES[data.type] ? data.type : (tri ? 'problem' : null);
    if (!type) throw err('validation', 'Выберите тип обращения');
    var cat = byId(state.categories, data.categoryId);
    if (!cat && !tri) throw err('validation', 'Выберите категорию');
    if (!cat) cat = { id: null, name: '' };
    var text = trim(data.text), title = trim(data.title), solution = trim(data.solution);
    if (text.length < (tri ? 10 : 15)) throw err('validation', tri ? 'Опишите, что случилось или что вы предлагаете (не менее 10 символов)' : 'Опишите ситуацию подробнее (не менее 15 символов)');
    if (text.length > 6000) throw err('validation', 'Слишком длинный текст — сократите до 6000 символов');
    if (ext) u = { id: null, dept: '—' };
    if (type === 'idea' && !tri && state.settings.solutionRequiredForIdeas && solution.length < 10) throw err('validation', 'Для предложения укажите вариант решения');
    if (data.anonymous && !state.settings.anonymousAllowed) throw err('validation', 'Анонимная подача отключена администратором');
    var priority = PRIORITIES[data.priority] ? data.priority : 'medium';
    if (!title) title = text.split(/[.!?\n]/)[0].slice(0, 90);
    var r = route(state, cat.id, type);
    var due = computeDue(priority, at);
    var t = {
      id: nextId(state, 'ticket', 'A-', 3),
      type: type, categoryId: cat.id, title: title, text: text, solution: solution,
      effect: trim(data.effect),
      authorId: u.id, anonymous: !ext && !!data.anonymous, dept: data.dept || u.dept,
      priority: priority, status: 'new', assigneeId: tri ? null : r.assigneeId, suggestAssigneeId: tri && cat.id ? r.assigneeId : null,
      createdAt: at, updatedAt: at, firstResponseAt: null, closedAt: null,
      respondDue: due.respondDue, resolveDue: due.resolveDue,
      result: '', rejectReason: '', impact: null,
      attachments: cleanFiles(data.attachments),
      votes: [], escalated: false, source: ext ? 'public' : (data.source || 'web'),
      external: ext, entryId: data.entryId || null, contact: ext && data.contact ? data.contact : null, trackCode: ext ? randomCode(24) : null,
      paei: PAEI[data.paei] ? data.paei : (CAT_PAEI[cat.id] || null), zone: ZONES[data.zone] ? data.zone : null, important: null,
      executorId: data.zone === 'self' && type !== 'praise' ? u.id : null,
      options: [], decision: null, plan: [], verify: null
    };
    if (solution && type !== 'praise') t.options.push({ id: nextId(state, 'opt', 'o'), userId: u.id, text: solution, effect: trim(data.effect), cost: '', at: at, votes: [], ai: false });
    state.tickets.push(t);
    addEvent(state, t, u.id, 'created', { text: data.chatId ? 'Обращение создано из сообщения в общем чате' : ext ? 'Обращение получено по ссылке' + (data.entryName ? ' «' + data.entryName + '»' : '') : 'Обращение зарегистрировано' }, at);
    if (data.chatId) { var cm = byId(state.chat || [], data.chatId); if (cm) cm.ticketId = t.id; }
    if (tri) {
      triagers(state).forEach(function (o) { notifyTriage(state, o.id, t, '📥 Новое обращение ' + t.id + (data.entryName ? ' · ' + data.entryName : '') + ': ' + t.title, at); });
      if (t.executorId) addEvent(state, t, u.id, 'claimed', { text: 'Автор готов решить сам' }, at);
      notify(state, u.id, t, 'Обращение ' + t.id + ' получено. Собственник решит, брать ли его в работу', at);
      return t;
    }
    var assignee = user(state, r.assigneeId);
    addEvent(state, t, null, 'assigned', {
      text: 'Назначен ответственный: ' + (assignee ? assignee.name : '—') + (r.fallback ? ' (замещение: ' + r.trail.join('; ') + ')' : ' — по правилу категории «' + cat.name + '»'),
      to: r.assigneeId
    }, at);
    notify(state, r.assigneeId, t, 'Новое обращение ' + t.id + ': ' + t.title, at);
    if (t.zone === 'mgmt') state.users.filter(function (x) { return x.role === 'owner'; }).forEach(function (o) { notify(state, o.id, t, '⚖ ' + t.id + ' требует решения руководства: ' + t.title, at); });
    if (t.executorId) addEvent(state, t, u.id, 'claimed', { text: 'Автор решит сам (круг влияния) — ответственный подтвердит результат' }, at);
    notify(state, u.id, t, 'Обращение ' + t.id + ' зарегистрировано. Ответственный: ' + (assignee ? assignee.name : '—') + '. Первый ответ — до ' + fmtDate(t.respondDue), at);
    return t;
  }

  function markResponded(state, t, actor, at) {
    if (t.firstResponseAt || !actor || actor.id === t.authorId || !canManage(state, actor, t)) return;
    t.firstResponseAt = at;
    if (ts(at) <= ts(t.respondDue)) award(state, actor.id, t, 'fast', at);
  }

  function transition(state, actorId, id, to, opts, now) {
    opts = opts || {};
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!t) throw err('not_found', 'Обращение не найдено');
    if (!canManage(state, u, t)) throw err('forbidden', 'Изменять статус может только ответственный, руководитель направления или администратор');
    if (['work', 'done', 'closed'].indexOf(to) >= 0) requireTeamReady(t);
    if (!STATUSES[to]) throw err('validation', 'Неизвестный статус');
    if (t.status === to) throw err('validation', 'Обращение уже в этом статусе');
    if ((FLOW[t.status] || []).indexOf(to) < 0) throw err('validation', 'Переход «' + STATUSES[t.status].label + '» → «' + STATUSES[to].label + '» не предусмотрен процессом');
    var comment = trim(opts.comment);
    if (pending(state, t) && to !== 'review' && to !== 'trash' && to !== 'new') throw err('validation', 'Сначала собственник решает: «В работу» или «В корзину»');
    if (to === 'trash' && (!triageOn(state) || t.status !== 'new')) throw err('validation', 'В корзину отправляется только новое обращение');
    if (triageOn(state) && t.status === 'new' && to === 'review' && (!opts.accepted || !t.assigneeId)) throw err('validation', 'Примите обращение с ответственным и сроком');
    if (triageOn(state) && to === 'closed') throw err('forbidden', 'Результат подтверждает собственник через проверку результата');
    if (triageOn(state) && t.status === 'done' && to === 'work') throw err('validation', 'Верните карточку через проверку результата с комментарием');
    if (to === 'rejected' && trim(opts.rejectReason || comment).length < 10) throw err('validation', 'Отказ должен быть мотивированным — укажите причину');
    if (to === 'clarify' && comment.length < 5) throw err('validation', 'Сформулируйте, что нужно уточнить автору');
    if ((to === 'done' || to === 'closed') && trim(opts.result || comment).length < 5 && (triageOn(state) || t.type !== 'praise')) throw err('validation', 'Зафиксируйте итог: что сделано');
    var at = iso(now || Date.now()), from = t.status;
    if (to === 'clarify') t.clarifyFrom = from;
    else if (from === 'clarify') delete t.clarifyFrom;
    t.status = to; t.updatedAt = at;
    markResponded(state, t, u, at);
    if (to === 'rejected') t.rejectReason = trim(opts.rejectReason || comment);
    if (to === 'trash') { t.trashReason = comment || 'Не по теме'; t.trashedAt = at; t.trashedBy = u.id; }
    if (to === 'new') { t.trashReason = ''; t.trashedAt = null; t.triageRemindedAt = null; }
    if (to === 'done' || to === 'closed') {
      t.result = trim(opts.result || comment) || t.result || 'Отзыв зафиксирован и передан команде';
      t.closedAt = at;
      if (opts.impact && (trim(opts.impact.before) || trim(opts.impact.after))) {
        t.impact = { metric: trim(opts.impact.metric), before: trim(opts.impact.before), after: trim(opts.impact.after) };
      }
      if (to === 'done') t.verify = { dueAt: iso(ts(at) + (opts.verifyDays ? +opts.verifyDays : VERIFY_DAYS) * DAY), result: null, metric: t.impact ? t.impact.metric : '', baseline: t.impact ? t.impact.before : '', target: t.impact ? t.impact.after : '' };
    }
    if (to === 'work' || to === 'review') t.closedAt = null;
    addEvent(state, t, u.id, 'status', { from: from, to: to, text: comment || (to === 'rejected' ? t.rejectReason : to === 'done' ? t.result : '') }, at);

    // Начисление баллов — только за подтверждённую ценность
    if (!t.anonymous) {
      if (['review', 'work', 'done', 'clarify'].indexOf(to) >= 0 && from === 'new' && t.type !== 'praise') award(state, t.authorId, t, 'signal', at);
      if (to === 'work' && t.solution && !t.team) award(state, t.authorId, t, 'solution', at);
      if (to === 'done') {
        award(state, t.authorId, t, 'signal', at);
        award(state, t.authorId, t, 'implemented', at);
        if (t.impact) award(state, t.authorId, t, 'impact', at);
      }
      if (to === 'closed' && t.type === 'praise') award(state, t.authorId, t, 'praise', at);
    }
    if (to === 'work') {
      // План реализации: окно на внедрение отсчитывается от принятия в работу
      var pw = PRIORITIES[t.priority] || PRIORITIES.medium;
      if (!triageOn(state)) t.resolveDue = iso(Math.max(ts(t.resolveDue), ts(at) + pw.resolveD * 2 * DAY));
      t.esc_resolve = null;
      var wasClarified = state.events.some(function (e) { return e.ticketId === t.id && e.kind === 'status' && e.to === 'clarify'; });
      var replied = state.events.some(function (e) { return e.ticketId === t.id && e.kind === 'comment' && e.userId === t.authorId; });
      if (wasClarified && replied) award(state, u.id, t, 'mentor', at);
    }
    if (to === 'done' && !t.anonymous) { var au = user(state, t.authorId); systemPost(state, '🎉 Внедрено ' + t.id + ' «' + t.title + '». Спасибо, ' + (au ? au.name : 'автор') + ', за сигнал!' + (t.impact ? ' Эффект: ' + t.impact.before + ' → ' + t.impact.after + '.' : ''), t.id, at); }
    if (to === 'done') { award(state, t.assigneeId, t, 'delivered', at); if (t.executorId && t.executorId !== t.assigneeId) award(state, t.executorId, t, 'executor', at); }

    var msg = {
      review: 'взято на рассмотрение', clarify: 'требует уточнения: ' + comment, work: 'принято в работу',
      done: 'реализовано. Итог: ' + t.result, rejected: 'отклонено. Причина: ' + t.rejectReason, closed: 'закрыто', new: 'возвращено',
      trash: 'не принято. Причина: ' + (t.trashReason || '').toLowerCase()
    }[to];
    if (triageOn(state)) {
      if (to === 'review' && from === 'new') msg = 'принято в работу';
      if (to === 'done') { msg = 'выполнено, результат на проверке у собственника. Итог: ' + t.result; triagers(state).forEach(function (o) { if (o.id !== u.id) notify(state, o.id, t, '🔎 ' + t.id + ' ждёт вашей проверки: ' + t.result, at); }); }
      if (to === 'closed') msg = 'решено';
      if (to === 'new') msg = 'возвращено во входящие';
    }
    notify(state, t.authorId, t, 'Ваше обращение ' + t.id + ' ' + msg, at);
    return t;
  }

  function addComment(state, actorId, id, text, opts, now) {
    opts = opts || {};
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!t || !canSee(state, u, t)) throw err('not_found', 'Обращение не найдено');
    text = trim(text);
    if (text.length < 2) throw err('validation', 'Пустой комментарий');
    var manage = canManage(state, u, t), author = isAuthor(u, t);
    if (!u || (!manage && !author && !isStaff(u) && (!triageOn(state) || !boardOf(t)))) throw err('forbidden', 'Комментировать могут участники обращения');
    if (opts.internal && !canSeeInternal(state, u, t)) throw err('forbidden', 'Внутренние заметки доступны только ответственным');
    var at = iso(now || Date.now());
    if (opts.clarify) return transition(state, actorId, id, 'clarify', { comment: text }, now);
    addEvent(state, t, u.id, 'comment', { text: text, internal: !!opts.internal }, at);
    t.updatedAt = at;
    if (!opts.internal) markResponded(state, t, u, at);
    if (author && t.status === 'clarify') {
      t.status = triageOn(state) && t.clarifyFrom === 'work' ? 'work' : 'review';
      delete t.clarifyFrom;
      addEvent(state, t, null, 'status', { from: 'clarify', to: t.status, text: 'Автор ответил на уточнение — работа продолжается' }, at);
      notify(state, t.assigneeId, t, 'Автор ответил на уточнение по ' + t.id, at);
    } else if (author) {
      notify(state, t.assigneeId, t, 'Новый комментарий автора по ' + t.id, at);
    } else if (!opts.internal) {
      notify(state, t.authorId, t, 'Ответ по обращению ' + t.id + ': ' + text.slice(0, 120), at);
    }
    return t;
  }

  function assign(state, actorId, id, userId, now) {
    var u = user(state, actorId), t = byId(state.tickets, id), target = user(state, userId);
    if (!t) throw err('not_found', 'Обращение не найдено');
    if (!canManage(state, u, t)) throw err('forbidden', 'Переназначать может ответственный или администратор');
    if (!teamActive(target)) throw err('validation', 'Выберите активного сотрудника');
    if (target.absent) throw err('validation', target.name + ' сейчас отсутствует — выберите замещающего');
    var at = iso(now || Date.now()), prev = user(state, t.assigneeId);
    t.assigneeId = target.id; t.updatedAt = at;
    addEvent(state, t, u.id, 'assigned', { text: 'Переназначено: ' + (prev ? prev.name : '—') + ' → ' + target.name, to: target.id }, at);
    notify(state, target.id, t, 'Вам передано обращение ' + t.id + ': ' + t.title, at);
    return t;
  }

  function setPriority(state, actorId, id, priority, now) {
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!t) throw err('not_found', 'Обращение не найдено');
    if (!canManage(state, u, t)) throw err('forbidden', 'Недостаточно прав');
    if (!PRIORITIES[priority]) throw err('validation', 'Неизвестный приоритет');
    var at = iso(now || Date.now());
    var old = t.priority; t.priority = priority;
    var due = computeDue(priority, t.createdAt); t.respondDue = due.respondDue;
    if (t.status === 'work') {
      var acc = null; state.events.forEach(function (e) { if (e.ticketId === t.id && e.kind === 'status' && e.to === 'work') acc = e.at; });
      t.resolveDue = iso(ts(acc || at) + PRIORITIES[priority].resolveD * 2 * DAY);
    } else t.resolveDue = due.resolveDue;
    t.esc_response = null; t.esc_resolve = null;
    addEvent(state, t, u.id, 'priority', { text: 'Приоритет: ' + PRIORITIES[old].label + ' → ' + PRIORITIES[priority].label }, at);
    return t;
  }

  function vote(state, actorId, id, now) {
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!u) throw err('forbidden', 'Нет пользователя');
    if (!t || !canSee(state, u, t) || pending(state, t)) throw err('not_found', 'Обращение не найдено');
    if (t.authorId === actorId) throw err('validation', 'Нельзя поддержать собственное обращение');
    t.votes = t.votes || [];
    var i = t.votes.indexOf(actorId);
    t.voteLog = t.voteLog || [];
    if (i >= 0) { t.votes.splice(i, 1); t.voteLog = t.voteLog.filter(function (v) { return v.userId !== actorId; }); } else {
      t.votes.push(actorId); t.voteLog.push({ userId: actorId, at: iso(now || Date.now()) });
      if (t.votes.length === 3) notify(state, t.assigneeId, t, 'Обращение ' + t.id + ' поддержали 3 сотрудника — вероятно, это повторяющаяся проблема', iso(now || Date.now()));
    }
    return t;
  }

  function quarterStart(now) { var d = new Date(now); return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime(); }
  function redeem(state, actorId, rewardId, now) {
    now = now || Date.now();
    var u = user(state, actorId), r = byId(state.rewards, rewardId);
    if (!u) throw err('forbidden', 'Нет пользователя');
    if (!r || r.active === false) throw err('not_found', 'Награда не найдена');
    var b = balance(state, actorId);
    if (b.coins < r.cost) throw err('validation', 'Недостаточно монет: нужно ' + r.cost + ', доступно ' + b.coins);
    var q = quarterStart(now);
    var inQ = state.redemptions.filter(function (x) { return x.rewardId === r.id && x.state !== 'rejected' && ts(x.at) >= q; });
    if (r.stock != null && inQ.length >= r.stock) throw err('validation', 'Лимит на квартал исчерпан: «' + r.name + '» — ' + r.stock + ' шт.');
    if (r.perUser != null && inQ.filter(function (x) { return x.userId === actorId; }).length >= r.perUser) throw err('validation', 'Вы уже получали «' + r.name + '» в этом квартале (лимит ' + r.perUser + ')');
    var rec = { id: nextId(state, 'redeem', 'r'), userId: actorId, rewardId: r.id, name: r.name, icon: r.icon || '', cost: r.cost, at: iso(now), state: 'pending', status: 'Ждёт подтверждения', decidedBy: null, decidedAt: null, note: '' };
    state.redemptions.push(rec);
    state.users.filter(function (x) { return x.role === 'owner' || x.id === 'm14'; }).forEach(function (x) {
      notify(state, x.id, null, '🎁 ' + u.name + ' хочет обменять ' + r.cost + ' монет на «' + r.name + '» — подтвердите в кабинете', rec.at);
    });
    return rec;
  }
  function decideRedemption(state, actorId, id, approve, note, now) {
    var u = user(state, actorId);
    if (!u || !(isAdmin(u) || u.id === 'm14')) throw err('forbidden', 'Подтверждает собственник или HR');
    var r = byId(state.redemptions, id);
    if (!r) throw err('not_found', 'Заявка не найдена');
    if (r.state !== 'pending') throw err('validation', 'Заявка уже рассмотрена');
    note = trim(note);
    if (!approve && note.length < 5) throw err('validation', 'Укажите причину отказа — монеты вернутся сотруднику');
    var at = iso(now || Date.now());
    r.state = approve ? 'approved' : 'rejected'; r.status = approve ? 'Одобрено — выдаёт HR' : 'Отклонено, монеты возвращены';
    r.decidedBy = u.id; r.decidedAt = at; r.note = note;
    notify(state, r.userId, null, approve ? '🎉 Награда «' + r.name + '» одобрена! ' + note : 'Заявка на «' + r.name + '» отклонена: ' + note + '. ' + r.cost + ' монет возвращены', at);
    return r;
  }
  function listRedemptions(state, actorId) {
    var u = user(state, actorId);
    if (!u || !(isAdmin(u) || u.id === 'm14')) throw err('forbidden', 'Недостаточно прав');
    return state.redemptions.slice().reverse().map(function (r) { var x = clone(r); x.userName = (user(state, r.userId) || {}).name || '—'; x.coins = balance(state, r.userId).coins; return x; });
  }
  function updateReward(state, actorId, id, patch) {
    var u = user(state, actorId); if (!isAdmin(u)) throw err('forbidden', 'Только собственник или администратор');
    var r = id ? byId(state.rewards, id) : null;
    if (!r) { if (!trim(patch.name)) throw err('validation', 'Название награды'); r = { id: nextId(state, 'reward', 'rw'), icon: '🎁', name: '', cost: 100, stock: null, perUser: null, desc: '' }; state.rewards.push(r); }
    if (patch.name != null) r.name = trim(patch.name).slice(0, 80);
    if (patch.desc != null) r.desc = trim(patch.desc).slice(0, 200);
    if (patch.icon != null) r.icon = trim(patch.icon).slice(0, 4);
    if (patch.cost != null) { var c = Math.round(+patch.cost); if (!(c >= 1 && c <= 100000)) throw err('validation', 'Цена от 1 до 100 000 монет'); r.cost = c; }
    ['stock', 'perUser'].forEach(function (k) { if (patch[k] !== undefined) r[k] = patch[k] === '' || patch[k] == null ? null : Math.max(0, Math.round(+patch[k])); });
    if (patch.active != null) r.active = !!patch.active;
    return r;
  }
  function rewardsView(state, viewerId, now) {
    now = now || Date.now(); var q = quarterStart(now);
    return state.rewards.filter(function (r) { return r.active !== false; }).map(function (r) {
      var x = clone(r), inQ = state.redemptions.filter(function (z) { return z.rewardId === r.id && z.state !== 'rejected' && ts(z.at) >= q; });
      x.left = r.stock == null ? null : Math.max(0, r.stock - inQ.length);
      x.mineLeft = r.perUser == null ? null : Math.max(0, r.perUser - inQ.filter(function (z) { return z.userId === viewerId; }).length);
      return x;
    });
  }

  function markRead(state, actorId, ids) {
    state.notifications.forEach(function (n) { if (n.userId === actorId && (!ids || ids.indexOf(n.id) >= 0)) n.read = true; });
  }

  // Плановая проверка SLA: эскалация просроченных обращений (вызывается сервером раз в 10 минут)
  function tick(state, now) {
    now = now || Date.now();
    var at = iso(now), out = [];
    state.tickets.forEach(function (t) {
      if (t.team && STATUSES[t.status].open && !pending(state, t)) progressTeam(state, t, now);
      (t.plan || []).forEach(function (s) { if (stepOverdue(s, now) && !s.reminded && STATUSES[t.status].open) { s.reminded = at; notify(state, s.assigneeId, t, '⏰ Просрочен шаг по ' + t.id + ': ' + s.text, at); notify(state, t.assigneeId, t, 'Шаг плана по ' + t.id + ' просрочен: ' + s.text, at); } });
      if (t.status === 'done' && !triageOn(state) && t.verify && !t.verify.result && t.verify.dueAt && ts(t.verify.dueAt) < now && !t.verify.reminded) { t.verify.reminded = at; notify(state, t.assigneeId, t, '🔎 Пора проверить эффект решения по ' + t.id + ': «' + t.title + '»', at); }
    });
    if (triageOn(state)) {
      var remH = +state.settings.triageRemindH || 24, keep = (+state.settings.trashDays || 30) * DAY;
      state.tickets.forEach(function (t) {
        if (t.status !== 'new') return;
        var last = ts(t.triageRemindedAt || t.createdAt);
        if (now - last < remH * HOUR) return;
        t.triageRemindedAt = at;
        triagers(state).forEach(function (o) { notifyTriage(state, o.id, t, '⏰ ' + t.id + ' ждёт вашего решения дольше ' + remH + ' ч: ' + t.title, at); });
      });
      var dead = {};
      state.tickets.forEach(function (t) { if (t.status === 'trash' && t.trashedAt && now - ts(t.trashedAt) > keep) dead[t.id] = 1; });
      if (Object.keys(dead).length) {
        state.tickets = state.tickets.filter(function (t) { return !dead[t.id]; });
        state.events = state.events.filter(function (e) { return !dead[e.ticketId]; });
        state.notifications = state.notifications.filter(function (n) { return !dead[n.ticketId]; });
      }
    }
    state.tickets.forEach(function (t) {
      if (pending(state, t)) return;
      var left = ts(t.resolveDue) - now;
      if (triageOn(state) && STATUSES[t.status].open && left > 0 && left <= DAY && t.dueReminderFor !== t.resolveDue) {
        t.dueReminderFor = t.resolveDue;
        notify(state, t.assigneeId, t, '⏳ ' + t.id + ': срок решения в ближайшие 24 часа — ' + fmtShort(t.resolveDue), at);
      }
      var o = overdueInfo(t, now);
      if (!o) return;
      var key = 'esc_' + o.kind;
      if (t[key]) return;
      t[key] = at; t.escalated = true;
      var cat = byId(state.categories, t.categoryId);
      var head = cat && cat.backup !== t.assigneeId ? cat.backup : state.settings.fallbackUser;
      addEvent(state, t, null, 'escalated', { text: (o.kind === 'response' ? 'Просрочен первый ответ' : 'Просрочен срок решения') + ' — эскалация: ' + ((user(state, head) || {}).name || 'администратор') }, at);
      notify(state, t.assigneeId, t, '⏰ ' + t.id + ': ' + o.label.toLowerCase() + '. Обращение эскалировано', at);
      notify(state, head, t, 'Эскалация ' + t.id + ' («' + t.title + '»): ' + o.label.toLowerCase(), at);
      if (triageOn(state)) triagers(state).forEach(function (ow) { if (ow.id !== head && ow.id !== t.assigneeId) notify(state, ow.id, t, '⏰ Просрочено: ' + t.id + ' «' + t.title + '» — ' + o.label.toLowerCase(), at); });
      out.push(t.id);
    });
    return out;
  }

  /* ───────────────────────── Выборки ───────────────────────── */

  function listTickets(state, viewerId, f, now) {
    f = f || {}; now = now || Date.now();
    var u = user(state, viewerId);
    var q = trim(f.q).toLowerCase();
    var list = state.tickets.filter(function (t) {
      if (!canSee(state, u, t)) return false;
      if (f.box === 'inbox') { if (!(triageOn(state) && t.status === 'new' && isTriager(state, u))) return false; }
      else if (f.box === 'trash') { if (!(t.status === 'trash' && isTriager(state, u))) return false; }
      else if (t.status === 'trash' && f.status !== 'trash') return false;
      if (f.box === 'board' && !boardOf(t)) return false;
      if (f.entryId && (f.entryId === 'app' ? !!t.entryId : t.entryId !== f.entryId)) return false;
      if (f.assigneeId && t.assigneeId !== f.assigneeId) return false;
      if (f.my && !(t.assigneeId === viewerId || t.executorId === viewerId || t.authorId === viewerId || (t.plan || []).some(function (st) { return st.assigneeId === viewerId && st.state !== 'done'; }))) return false;
      if (f.scope === 'mine' && t.authorId !== viewerId) return false;
      if (f.scope === 'assigned' && t.assigneeId !== viewerId) return false;
      if (f.scope === 'manage' && !canManage(state, u, t)) return false;
      if (f.status && f.status !== 'all') {
        if (f.status === 'open') { if (!STATUSES[t.status].open) return false; }
        else if (t.status !== f.status) return false;
      }
      if (f.type && t.type !== f.type) return false;
      if (f.categoryId && t.categoryId !== f.categoryId) return false;
      if (f.dept && (t.anonymous || t.dept !== f.dept)) return false;
      if (f.priority && t.priority !== f.priority) return false;
      if (f.paei && paeiOf(t) !== f.paei) return false;
      if (f.stage && stageOf(t, now) !== f.stage) return false;
      if (f.zone && t.zone !== f.zone) return false;
      if (f.quadrant && (t.type === 'praise' || quadrant(t, now) !== f.quadrant)) return false;
      if (f.overdue && !overdueInfo(t, now)) return false;
      if (f.from && ts(t.createdAt) < ts(f.from)) return false;
      if (f.to && ts(t.createdAt) > ts(f.to) + DAY) return false;
      if (q && (t.id + ' ' + t.title + ' ' + t.text + ' ' + t.solution).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var sort = f.sort || 'updated';
    list.sort(function (a, b) {
      if (sort === 'votes') return (b.votes || []).length - (a.votes || []).length;
      if (sort === 'priority') { var PR = { high: 0, medium: 1, low: 2 }; return (PR[a.priority] - PR[b.priority]) || ((overdueInfo(b, now) ? 1 : 0) - (overdueInfo(a, now) ? 1 : 0)) || ((b.votes || []).length - (a.votes || []).length) || (ts(a.createdAt) - ts(b.createdAt)); }
      if (sort === 'due') return ts(a.respondDue) - ts(b.respondDue);
      if (sort === 'created') return ts(b.createdAt) - ts(a.createdAt);
      return ts(b.updatedAt) - ts(a.updatedAt);
    });
    return list.map(function (t) { return sanitize(state, viewerId, t, false); });
  }

  function getTicket(state, viewerId, id) {
    var t = byId(state.tickets, id);
    if (!t || !canSee(state, user(state, viewerId), t)) throw err('not_found', 'Обращение не найдено');
    return sanitize(state, viewerId, t, true);
  }

  function achievementsOf(state, userId) {
    var mine = state.tickets.filter(function (t) { return t.authorId === userId && !t.anonymous; });
    var led = state.ledger.filter(function (l) { return l.userId === userId; });
    var has = function (k) { return led.filter(function (l) { return l.kind === k; }).length; };
    var votesGiven = state.tickets.filter(function (t) { return (t.votes || []).indexOf(userId) >= 0; }).length;
    var got = {
      first: mine.length >= 1,
      coauthor: has('solution') >= 1,
      changer: has('implemented') >= 1,
      systemic: mine.filter(function (t) { return t.solution; }).length >= 3,
      measured: has('impact') >= 1,
      voice: votesGiven >= 3,
      fast: has('fast') >= 3,
      mentor: has('mentor') >= 1,
      leader: has('delivered') >= 2
    };
    return ACHIEVEMENTS.map(function (a) { var x = clone(a); x.earned = !!got[a.id]; return x; });
  }

  function profile(state, userId, viewerId) {
    var u = user(state, userId);
    var self = !viewerId || viewerId === userId;
    if (!u) throw err('not_found', 'Нет пользователя');
    var b = balance(state, userId);
    var mine = state.tickets.filter(function (t) { return t.authorId === userId && (self || !t.anonymous); });
    return {
      user: clone(u), balance: b, level: level(b.earned),
      achievements: achievementsOf(state, userId),
      ledger: self ? state.ledger.filter(function (l) { return l.userId === userId; }).slice().sort(function (a, b) { return ts(b.at) - ts(a.at); }) : [],
      redemptions: self ? state.redemptions.filter(function (r) { return r.userId === userId; }).slice().reverse() : [],
      rewards: self ? rewardsView(state, userId) : [],
      stats: {
        submitted: mine.length,
        implemented: mine.filter(function (t) { return t.status === 'done'; }).length,
        inWork: mine.filter(function (t) { return t.status === 'work'; }).length,
        withSolution: mine.filter(function (t) { return t.solution; }).length
      },
      unread: !self ? 0 : state.notifications.filter(function (n) { return n.userId === userId && !n.read; }).length
    };
  }

  function leaderboard(state) {
    var rows = state.users.map(function (u) {
      var b = balance(state, u.id);
      var mine = state.tickets.filter(function (t) { return t.authorId === u.id && !t.anonymous; });
      return {
        userId: u.id, name: u.name, dept: u.dept, role: u.role, points: b.earned,
        level: level(b.earned).name,
        implemented: mine.filter(function (t) { return t.status === 'done'; }).length,
        accepted: mine.filter(function (t) { return ['work', 'done'].indexOf(t.status) >= 0; }).length,
        submitted: mine.length
      };
    }).filter(function (r) { var uu = user(state, r.userId); return r.points > 0 && r.role !== 'owner' && !(uu && uu.hideRating); });
    rows.sort(function (a, b) { return b.points - a.points || b.implemented - a.implemented; });
    return rows;
  }

  function analytics(state, now) {
    now = now || Date.now();
    var T = state.tickets.filter(function (t) { return t.status !== 'trash'; });
    var byType = {}, byStatus = {}, byCat = {}, byDept = {};
    Object.keys(TYPES).forEach(function (k) { byType[k] = 0; });
    STATUS_ORDER.forEach(function (k) { byStatus[k] = 0; });
    var respSum = 0, respN = 0, closedN = 0, resultN = 0, overdue = [];
    T.forEach(function (t) {
      byType[t.type]++; byStatus[t.status]++;
      var cn = (byId(state.categories, t.categoryId) || {}).name || '—';
      byCat[cn] = byCat[cn] || { name: cn, total: 0, open: 0, done: 0, votes: 0 };
      byCat[cn].total++; byCat[cn].votes += (t.votes || []).length;
      if (STATUSES[t.status].open) byCat[cn].open++; if (t.status === 'done') byCat[cn].done++;
      var d = t.anonymous ? 'Анонимно' : t.dept;
      byDept[d] = (byDept[d] || 0) + 1;
      if (t.firstResponseAt) { respSum += ts(t.firstResponseAt) - ts(t.createdAt); respN++; }
      if (!STATUSES[t.status].open) closedN++;
      if (t.result || t.rejectReason) resultN++;
      if (overdueInfo(t, now)) overdue.push(t.id);
    });
    var managers = state.users.filter(isStaff).map(function (m) {
      var mine = T.filter(function (t) { return t.assigneeId === m.id; });
      var resp = mine.filter(function (t) { return t.firstResponseAt; });
      var avg = resp.length ? resp.reduce(function (s, t) { return s + ts(t.firstResponseAt) - ts(t.createdAt); }, 0) / resp.length / HOUR : null;
      var decided = mine.filter(function (t) { return ['work', 'done', 'rejected', 'closed'].indexOf(t.status) >= 0; });
      return {
        userId: m.id, name: m.name, absent: !!m.absent, total: mine.length,
        open: mine.filter(function (t) { return STATUSES[t.status].open; }).length,
        overdue: mine.filter(function (t) { return overdueInfo(t, now); }).length,
        avgResponseH: avg == null ? null : Math.round(avg * 10) / 10,
        implemented: mine.filter(function (t) { return t.status === 'done'; }).length,
        conversion: decided.length ? Math.round(mine.filter(function (t) { return t.status === 'done'; }).length / decided.length * 100) : null
      };
    }).filter(function (r) { return r.total > 0; }).sort(function (a, b) { return b.overdue - a.overdue || b.open - a.open; });

    // Повторяющиеся проблемы: кластеры похожих обращений + поддержка коллег
    var seen = {}, clusters = [];
    T.forEach(function (t) {
      if (seen[t.id] || t.type === 'praise') return;
      var sim = findSimilar(state, t.title + ' ' + t.text, t.id, 5).filter(function (s) { return !seen[s.ticket.id]; });
      var weight = (t.votes || []).length + sim.length;
      if (sim.length || (t.votes || []).length >= 2) {
        seen[t.id] = 1; sim.forEach(function (s) { seen[s.ticket.id] = 1; });
        clusters.push({ lead: t.id, title: t.title, ids: [t.id].concat(sim.map(function (s) { return s.ticket.id; })), votes: (t.votes || []).length, weight: weight });
      }
    });
    clusters.sort(function (a, b) { return b.weight - a.weight; });

    // Динамика по неделям (последние 8 недель)
    var weeks = [];
    for (var w = 7; w >= 0; w--) {
      var start = now - (w + 1) * 7 * DAY, end = now - w * 7 * DAY;
      weeks.push({
        label: fmtShort(iso(start + DAY)),
        created: T.filter(function (t) { return ts(t.createdAt) >= start && ts(t.createdAt) < end; }).length,
        closed: T.filter(function (t) { return t.closedAt && ts(t.closedAt) >= start && ts(t.closedAt) < end; }).length
      });
    }
    var categories = Object.keys(byCat).map(function (k) { return byCat[k]; }).sort(function (a, b) { return b.total - a.total; });
    return {
      total: T.length, byType: byType, byStatus: byStatus, categories: categories, byDept: byDept,
      closedShare: T.length ? Math.round(closedN / T.length * 100) : 0,
      resultShare: T.length ? Math.round(resultN / T.length * 100) : 0,
      reviewedShare: T.length ? Math.round(T.filter(function (t) { return t.status !== 'new'; }).length / T.length * 100) : 0,
      avgFirstResponseH: respN ? Math.round(respSum / respN / HOUR * 10) / 10 : null,
      implemented: byStatus.done, overdue: overdue, managers: managers, clusters: clusters.slice(0, 6), weeks: weeks,
      participation: state.users.filter(function (u) { return u.role === 'employee'; }).length ?
        Math.round(state.users.filter(function (u) { return u.role === 'employee' && T.some(function (t) { return t.authorId === u.id; }); }).length / state.users.filter(function (u) { return u.role === 'employee'; }).length * 100) : 0
    };
  }

  function bootstrap(state, viewerId) {
    var u = user(state, viewerId);
    return {
      me: u ? clone(u) : null,
      triage: triageOn(state), canTriage: isTriager(state, u),
      inboxCount: isTriager(state, u) && triageOn(state) ? state.tickets.filter(function (t) { return t.status === 'new'; }).length : 0,
      entries: (state.entries || []).map(function (e) { return { id: e.id, name: e.name, kind: e.kind, active: e.active }; }),
      board: BOARD, entryKinds: ENTRY_KINDS,
      users: state.users.map(function (x) { return { id: x.id, name: x.name, role: x.role, dept: x.dept, jobTitle: x.jobTitle || '', active: x.active !== false, disabled: x.disabled === true, absent: !!x.absent, absentNote: x.absentNote || '' }; }),
      categories: clone(state.categories), departments: state.departments.slice(), rewards: clone(state.rewards),
      settings: clone(state.settings),
      leaderId: (leaderboard(state)[0] || {}).userId || null,
      dict: { TYPES: TYPES, STATUSES: triageOn(state) ? boardStatuses() : STATUSES, STATUS_ORDER: STATUS_ORDER, FLOW: FLOW, PRIORITIES: PRIORITIES, ROLES: ROLES, POINTS: POINTS, LEVELS: LEVELS, PAEI: PAEI, ZONES: ZONES, QUADRANTS: QUADRANTS }
    };
  }

  function notificationsOf(state, userId) {
    return state.notifications.filter(function (n) { return n.userId === userId; }).slice(-60).reverse();
  }

  // Администрирование: правила маршрутизации, присутствие, настройки
  function updateCategory(state, actorId, id, patch) {
    var u = user(state, actorId); if (!isAdmin(u)) throw err('forbidden', 'Только администратор');
    var c = byId(state.categories, id);
    if (!c && patch.name) { c = { id: nextId(state, 'cat', 'cx'), name: '', owner: '', backup: '' }; state.categories.push(c); }
    if (!c) throw err('not_found', 'Категория не найдена');
    ['name', 'owner', 'backup'].forEach(function (k) { if (patch[k] != null) c[k] = trim(patch[k]); });
    return c;
  }
  function createUser(state, actorId, data) {
    if (!isAdmin(user(state, actorId))) throw err('forbidden', 'Только администратор');
    data = data || {};
    var name = typeof data.name === 'string' ? trim(data.name) : '', dept = typeof data.dept === 'string' ? trim(data.dept) : '';
    var jobTitle = data.jobTitle == null ? '' : validJobTitle(data.jobTitle);
    var role = data.role || 'employee';
    if (name.length < 2 || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw err('validation', 'Имя должно содержать от 2 до 100 символов');
    if (dept.length > 100 || /[\x00-\x1f\x7f]/.test(dept)) throw err('validation', 'Некорректное прежнее название подразделения');
    if (['employee', 'manager', 'admin'].indexOf(role) < 0) throw err('validation', 'Недопустимая роль');
    if (data.tgId != null || data.telegramId != null) throw err('validation', 'Привяжите Telegram после создания сотрудника');
    var id; do { id = nextId(state, 'user', 'u'); } while (user(state, id));
    var result = { id: id, name: name, jobTitle: jobTitle, dept: dept, role: role };
    state.users.push(result);
    return clone(result);
  }
  function updateUser(state, actorId, id, patch) {
    var u = user(state, actorId); if (!u || (!isAdmin(u) && actorId !== id)) throw err('forbidden', 'Только администратор');
    var x = user(state, id); if (!x) throw err('not_found', 'Нет пользователя');
    var jobTitle = patch.jobTitle != null ? validJobTitle(patch.jobTitle) : x.jobTitle;
    if (patch.tgId != null) {
      if (!isAdmin(u)) throw err('forbidden', 'Привязку Telegram выполняет администратор');
      var tg = trim(patch.tgId);
      if (tg && !/^[1-9][0-9]{0,19}$/.test(tg)) throw err('validation', 'Telegram ID должен быть положительным целым числом');
      if (tg && state.users.some(function (o) { return o.id !== x.id && String(o.tgId || '') === tg; })) throw err('validation', 'Telegram ID уже привязан к другому сотруднику');
      x.tgId = tg;
    }
    if (patch.jobTitle != null) x.jobTitle = jobTitle;
    if (patch.absent != null) { x.absent = !!patch.absent; x.absentNote = x.absent ? (trim(patch.absentNote) || 'Отсутствует') : ''; }
    if (patch.role && isAdmin(u) && ROLES[patch.role]) x.role = patch.role;
    return x;
  }
  function validJobTitle(value) {
    var title = typeof value === 'string' ? trim(value) : '';
    if (title.length < 2 || title.length > 100 || /[\x00-\x1f\x7f]/.test(title)) throw err('validation', 'Укажите должность от 2 до 100 символов');
    return title;
  }
  function updateSettings(state, actorId, patch) {
    var u = user(state, actorId); if (!isAdmin(u)) throw err('forbidden', 'Только администратор');
    ['anonymousAllowed', 'solutionRequiredForIdeas'].forEach(function (k) { if (patch[k] != null) state.settings[k] = !!patch[k]; });
    if (patch.deputyId != null) {
      if (u.role !== 'owner') throw err('forbidden', 'Заместителя назначает собственник');
      var d = patch.deputyId ? user(state, patch.deputyId) : null;
      if (patch.deputyId && (!d || !isStaff(d))) throw err('validation', 'Заместителем может быть руководитель или администратор');
      state.settings.deputyId = d ? d.id : '';
    }
    if (patch.trashDays != null) state.settings.trashDays = Math.max(1, Math.min(365, +patch.trashDays || 30));
    if (patch.triageRemindH != null) state.settings.triageRemindH = Math.max(1, Math.min(240, +patch.triageRemindH || 24));
    return state.settings;
  }

  /* ───────────────────────── Решение: варианты → выбор → план → внедрение → проверка эффекта ───────────────────────── */
  function teamActive(u) { return !!u && u.disabled !== true && u.active !== false && !u.absent; }
  function teamIds(state, t) { return t.team.participants.filter(function (id) { return teamActive(user(state, id)); }); }
  function teamCoordinator(state, u, t) { return teamActive(u) && (isAdmin(u) || isTriager(state, u) || t.assigneeId === u.id); }
  function requireTeamReady(t) { if (t.team && (t.team.phase !== 'ready' || !t.decision)) throw err('validation', 'Сначала соберите предложения команды и завершите голосование'); }
  function teamMember(state, actorId, t) {
    var u = user(state, actorId);
    if (!teamActive(u) || !canSee(state, u, t) || pending(state, t)) throw err('forbidden', 'Обращение недоступно');
    if (teamIds(state, t).indexOf(actorId) < 0) throw err('forbidden', 'Вы не входите в состав этого обсуждения');
    return u;
  }
  function teamBroadcast(state, t, text, at) { teamIds(state, t).forEach(function (id) { notify(state, id, t, text, at); }); }
  function teamDeadlines(data, now, resolveDue, voting) {
    data = data || {}; now = now || Date.now();
    var explicit = /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/;
    if (typeof data.collectUntil !== 'string' || typeof data.voteUntil !== 'string' || !explicit.test(data.collectUntil) || !explicit.test(data.voteUntil)) throw err('validation', 'Укажите сроки сбора предложений и голосования с часовым поясом');
    var collect = ts(data.collectUntil), vote = ts(data.voteUntil);
    if (!Number.isFinite(collect) || !Number.isFinite(vote) || (!voting && collect <= now) || vote <= Math.max(collect, now)) throw err('validation', 'Срок предложений должен быть в будущем, а голосование — завершаться позже');
    if (resolveDue && vote > ts(resolveDue)) throw err('validation', 'Голосование должно закончиться не позже срока решения проблемы');
    return { collectUntil: iso(collect), voteUntil: iso(vote) };
  }
  function startTeam(state, t, now, migrating, schedule) {
    if (t.team || t.type === 'praise') return;
    var at = iso(now || Date.now());
    t.team = { phase: migrating ? 'setup' : 'collect', participants: state.users.filter(teamActive).map(function (u) { return u.id; }), responses: {}, ballots: {}, collectUntil: schedule ? schedule.collectUntil : null, voteUntil: schedule ? schedule.voteUntil : null, startedAt: at };
    (t.options || []).forEach(function (o) {
      if (t.team.participants.indexOf(o.userId) >= 0) {
        t.team.responses[o.userId] = { kind: 'proposal', at: o.at };
        if (!migrating && (!t.anonymous || o.userId !== t.authorId)) award(state, o.userId, t, 'optionProposed', at);
      }
    });
    addEvent(state, t, null, 'team', { text: migrating ? 'Для командного обсуждения нужно назначить сроки предложений и голосования.' : 'Команда собирает предложения. Каждый участник предлагает решение или отмечает, что пока нет предложения.' }, at);
    if (migrating) notify(state, t.assigneeId, t, '📅 ' + t.id + ': укажите сроки сбора предложений и голосования команды.', at);
    else teamBroadcast(state, t, '💡 ' + t.id + ': предложите, как решить проблему. Сбор предложений до ' + fmtDate(t.team.collectUntil), at);
  }
  function teamCounts(state, t) {
    var ids = teamIds(state, t), team = t.team;
    return { ids: ids, total: ids.length, responded: ids.filter(function (id) { return !!team.responses[id]; }).length, voted: ids.filter(function (id) { return !!team.ballots[id]; }).length };
  }
  function teamLeaders(state, t) {
    var ids = teamIds(state, t), scores = {}, max = 0;
    (t.options || []).forEach(function (o) { scores[o.id] = 0; });
    ids.forEach(function (id) { var choice = t.team.ballots[id]; if (Object.prototype.hasOwnProperty.call(scores, choice)) max = Math.max(max, ++scores[choice]); });
    return max ? Object.keys(scores).filter(function (id) { return scores[id] === max; }) : [];
  }
  function teamVotingEnded(state, t, now) { var c = teamCounts(state, t); return (c.total > 0 && c.voted === c.total) || (t.team.voteUntil && (now || Date.now()) >= ts(t.team.voteUntil)); }
  function finishTeam(state, t, option, actorId, reason, now) {
    var at = iso(now || Date.now());
    t.team.phase = 'ready'; t.team.finishedAt = at;
    t.decision = { optionId: option.id, by: actorId || null, at: at, reason: reason };
    t.solution = option.text; t.updatedAt = at;
    addEvent(state, t, actorId || null, 'decision', { text: 'Команда выбрала решение: «' + option.text.slice(0, 160) + '». ' + reason }, at);
    if (!t.anonymous || option.userId !== t.authorId) award(state, option.userId, t, 'optionChosen', at);
    teamBroadcast(state, t, '🏆 ' + t.id + ': решение выбрано голосованием. Ответственный приступает к выполнению.', at);
  }
  function progressTeam(state, t, now) {
    var team = t.team; if (!team || team.phase === 'setup' || team.phase === 'ready' || pending(state, t) || !STATUSES[t.status].open) return;
    now = now || Date.now(); var at = iso(now), c = teamCounts(state, t);
    if (team.phase === 'collect') {
      if ((c.total > 0 && c.responded === c.total) || now >= ts(team.collectUntil)) {
        if (!(t.options || []).length) {
          if (!team.emptyRemindedAt) { team.emptyRemindedAt = at; notify(state, t.assigneeId, t, '💡 ' + t.id + ': предложений пока нет. Помогите команде сформулировать первый вариант.', at); }
          return;
        }
        team.phase = 'vote'; t.updatedAt = at;
        addEvent(state, t, null, 'team', { text: 'Сбор предложений завершён. Голосуем за лучшее решение.' }, at);
        teamBroadcast(state, t, '🗳 ' + t.id + ': выберите лучшее решение. Один голос на участника. Голосование до ' + fmtDate(team.voteUntil), at);
      }
    } else if (team.phase === 'vote' && teamVotingEnded(state, t, now)) {
      var leaders = teamLeaders(state, t);
      if (leaders.length === 1) finishTeam(state, t, byId(t.options, leaders[0]), null, 'Больше всего голосов команды', now);
      else if (!team.resultRemindedAt) {
        team.resultRemindedAt = at;
        notify(state, t.assigneeId, t, leaders.length ? '🗳 ' + t.id + ': равенство голосов. Выберите один из лидирующих вариантов и объясните выбор.' : '🗳 ' + t.id + ': голосов нет. Голосование остаётся открытым до первого голоса.', at);
      }
    }
  }
  function teamView(state, viewerId, t) {
    var team = t.team, c = teamCounts(state, t), now = Date.now(), leaders = teamLeaders(state, t);
    var ended = team.phase === 'vote' && teamVotingEnded(state, t, now);
    return { phase: team.phase, total: c.total, respondedCount: c.responded, votedCount: c.voted, collectUntil: team.collectUntil, voteUntil: team.voteUntil,
      myResponded: !!team.responses[viewerId], myVoted: !!team.ballots[viewerId], myVoteId: team.ballots[viewerId] || null,
      canParticipate: c.ids.indexOf(viewerId) >= 0, votingEnded: !!ended,
      canSchedule: teamCoordinator(state, user(state, viewerId), t) && team.phase !== 'ready' && STATUSES[t.status].open,
      canAdvance: teamCoordinator(state, user(state, viewerId), t) && ((team.phase === 'collect' && t.options.length > 0 && ((c.total > 0 && c.responded === c.total) || now >= ts(team.collectUntil))) || (team.phase === 'vote' && ended && leaders.length === 1)),
      canChoose: teamCoordinator(state, user(state, viewerId), t) && ended && leaders.length > 1, topIds: ended ? leaders : [],
      participants: c.ids.map(function (id) { var u = user(state, id); return { id: id, name: u.name, responded: !!team.responses[id], voted: !!team.ballots[id] }; }) };
  }
  function teamPass(state, actorId, id, note, now) {
    var t = byId(state.tickets, id); if (!t || !t.team) throw err('not_found', 'Командное обсуждение не найдено');
    teamMember(state, actorId, t); openForSolving(t);
    if (t.team.phase !== 'collect') throw err('validation', 'Сбор предложений уже завершён');
    note = trim(note); if (note.length < 5) throw err('validation', 'Коротко поясните, почему пока нет предложения');
    if (!t.team.responses[actorId]) { var at = iso(now || Date.now()); t.team.responses[actorId] = { kind: 'pass', note: note.slice(0, 300), at: at }; t.updatedAt = at; addEvent(state, t, actorId, 'team', { text: 'Ознакомился с проблемой. Пока нет предложения: ' + note.slice(0, 300) }, at); }
    progressTeam(state, t, now); return t;
  }
  function advanceTeam(state, actorId, id, now) {
    var t = byId(state.tickets, id), u = user(state, actorId);
    if (!t || !t.team || !canSee(state, u, t) || pending(state, t)) throw err('not_found', 'Командное обсуждение не найдено');
    if (!teamCoordinator(state, u, t)) throw err('forbidden', 'Этап завершает ответственный или собственник');
    openForSolving(t); if (t.team.phase === 'ready') return t;
    if (t.team.phase === 'setup') throw err('validation', 'Сначала укажите сроки предложений и голосования');
    var c = teamCounts(state, t); now = now || Date.now();
    if (t.team.phase === 'collect' && !((c.total > 0 && c.responded === c.total) || now >= ts(t.team.collectUntil))) throw err('validation', 'Дождитесь ответов команды или окончания срока');
    if (t.team.phase === 'collect' && !t.options.length) throw err('validation', 'Нужен хотя бы один вариант решения');
    if (t.team.phase === 'vote' && !teamVotingEnded(state, t, now)) throw err('validation', 'Дождитесь голосов команды или окончания срока');
    progressTeam(state, t, now); return t;
  }
  function setTeamDeadlines(state, actorId, id, data, now) {
    data = data || {};
    var t = byId(state.tickets, id), u = user(state, actorId);
    if (!t || !t.team || !canSee(state, u, t) || pending(state, t)) throw err('not_found', 'Командное обсуждение не найдено');
    if (!teamCoordinator(state, u, t)) throw err('forbidden', 'Сроки задаёт ответственный или собственник');
    openForSolving(t);
    if (t.team.phase === 'ready') throw err('validation', 'Решение уже выбрано, голосование завершено');
    if (t.team.phase === 'vote' && teamVotingEnded(state, t, now) && teamLeaders(state, t).length === 1) throw err('validation', 'Голосование уже определило победителя. Подведите итоги');
    if (t.team.phase === 'vote' && ts(data.collectUntil) !== ts(t.team.collectUntil)) throw err('validation', 'Этап предложений уже завершён. Можно изменить только срок голосования');
    var resolveDue = t.resolveDue;
    if (data.resolveDue != null) {
      if (typeof data.resolveDue !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(data.resolveDue) || !Number.isFinite(ts(data.resolveDue)) || ts(data.resolveDue) <= (now || Date.now())) throw err('validation', 'Укажите новый срок решения в будущем с часовым поясом');
      resolveDue = iso(ts(data.resolveDue));
    }
    var schedule = teamDeadlines(data, now, resolveDue, t.team.phase === 'vote'), at = iso(now || Date.now());
    var starting = t.team.phase === 'setup';
    if (starting) t.team.participants = state.users.filter(teamActive).map(function (person) { return person.id; });
    t.team.collectUntil = schedule.collectUntil; t.team.voteUntil = schedule.voteUntil;
    if (resolveDue !== t.resolveDue) { t.resolveDue = resolveDue; t.esc_resolve = null; delete t.dueReminderFor; }
    if (starting) t.team.phase = 'collect';
    delete t.team.emptyRemindedAt; delete t.team.resultRemindedAt; t.updatedAt = at;
    addEvent(state, t, actorId, 'team', { text: 'Срок предложений: ' + fmtDate(schedule.collectUntil) + '. Голосование до ' + fmtDate(schedule.voteUntil) + '. Решить до ' + fmtDate(resolveDue) }, at);
    teamBroadcast(state, t, '📅 ' + t.id + ': ' + (starting ? 'предложите решение проблемы' : 'обновлены сроки обсуждения') + '. Предложения до ' + fmtDate(schedule.collectUntil) + ', голосование до ' + fmtDate(schedule.voteUntil), at);
    progressTeam(state, t, now); return t;
  }
  var STAGES = {
    problem:  { label: 'Собираем предложения', step: 0, hint: 'Каждый участник предлагает решение' },
    options:  { label: 'Голосуем',         step: 1, hint: 'Команда выбирает лучшее предложение' },
    plan:     { label: 'План действий',    step: 2, hint: 'Решение выбрано — составьте шаги' },
    doing:    { label: 'Внедрение',        step: 3, hint: 'Шаги плана выполняются' },
    verify:   { label: 'Проверка эффекта', step: 4, hint: 'Внедрено — подтвердите эффект' },
    solved:   { label: 'Решено',           step: 5, hint: 'Эффект подтверждён' },
    closed:   { label: 'Закрыто',          step: 5, hint: '' }
  };
  var VERIFY_DAYS = 30;
  function stageOf(t, now) {
    if (t.type === 'praise') return 'closed';
    if (t.status === 'closed' && t.verify && t.verify.result === 'confirmed') return 'solved';
    if (t.status === 'rejected' || t.status === 'closed' || t.status === 'trash') return 'closed';
    if (t.status === 'done') return t.verify && t.verify.result === 'confirmed' ? 'solved' : t.verify && t.verify.result === 'failed' ? 'doing' : 'verify';
    if (t.team) { if (t.team.phase === 'setup' || t.team.phase === 'collect') return 'problem'; if (t.team.phase === 'vote') return 'options'; if (t.status === 'work') return 'doing'; }
    var opts = (t.options || []).length;
    if (!t.decision) return opts ? 'options' : 'problem';
    var plan = t.plan || [];
    if (!plan.length) return 'plan';
    return 'doing';
  }
  function planProgress(t) { var p = t.plan || []; if (!p.length) return null; var d = p.filter(function (s) { return s.state === 'done'; }).length; return { done: d, total: p.length, pct: Math.round(d / p.length * 100) }; }
  function stepOverdue(s, now) { return s.state !== 'done' && s.due && ts(s.due) + DAY < (now || Date.now()); }

  function openForSolving(t) { if (!t) throw err('not_found', 'Обращение не найдено'); if (t.type === 'praise') throw err('validation', 'Отзыв не требует решения'); if (!STATUSES[t.status].open && t.status !== 'done') throw err('validation', 'Обращение закрыто'); }

  function proposeOption(state, actorId, id, data, now) {
    var u = user(state, actorId), t = byId(state.tickets, id); if (!u) throw err('forbidden', 'Нет пользователя');
    if (t && pending(state, t)) throw err('validation', 'Обращение ещё не принято в работу');
    openForSolving(t);
    if (!canSee(state, u, t)) throw err('forbidden', 'Обращение недоступно');
    if (t.team) {
      teamMember(state, actorId, t);
      if (t.team.phase !== 'collect' || ((now || Date.now()) >= ts(t.team.collectUntil) && t.options.length)) throw err('validation', 'Сбор предложений завершён — пора голосовать');
      if (t.options.some(function (o) { return o.userId === actorId; })) throw err('validation', 'Ваш вариант уже добавлен. У каждого участника один вариант');
    }
    if (t.decision) throw err('validation', 'Решение уже выбрано — предложите шаг в план или напишите комментарий');
    var text = trim(data.text); if (text.length < 10) throw err('validation', 'Опишите вариант решения подробнее (от 10 символов)');
    var at = iso(now || Date.now());
    t.options = t.options || [];
    if (!t.team && t.options.length >= 12) throw err('validation', 'Слишком много вариантов — проголосуйте за существующие');
    if (t.team && t.options.some(function (o) { return trim(o.text).replace(/\s+/g, ' ').toLocaleLowerCase() === text.replace(/\s+/g, ' ').toLocaleLowerCase(); })) throw err('validation', 'Такой вариант уже предложен. Предложите другой способ');
    var o = { id: nextId(state, 'opt', 'o'), userId: u.id, text: text.slice(0, 1500), effect: trim(data.effect).slice(0, 300), cost: trim(data.cost).slice(0, 120), at: at, votes: [], ai: !!data.ai };
    t.options.push(o); t.updatedAt = at;
    if (t.team) { t.team.responses[actorId] = { kind: 'proposal', at: at }; if (!t.anonymous || actorId !== t.authorId) award(state, actorId, t, 'optionProposed', at); }
    addEvent(state, t, u.id, 'option', { text: 'Предложен вариант решения: ' + text.slice(0, 200) }, at);
    if (u.id !== t.authorId) notify(state, t.authorId, t, u.name + ' предложил(а) вариант решения для ' + t.id, at);
    notify(state, t.assigneeId, t, 'Новый вариант решения для ' + t.id + (t.team ? ' — команда собирает предложения' : ' — пора выбирать'), at);
    if (t.team) progressTeam(state, t, now);
    return o;
  }
  function voteOption(state, actorId, id, optId, now) {
    var t = byId(state.tickets, id); if (!t || !user(state, actorId)) throw err('not_found', 'Обращение не найдено');
    if (!canSee(state, user(state, actorId), t) || pending(state, t)) throw err('forbidden', 'Обращение недоступно');
    var o = byId(t.options || [], optId); if (!o) throw err('not_found', 'Вариант не найден');
    if (t.team) {
      teamMember(state, actorId, t); openForSolving(t);
      if (t.team.ballots[actorId] === optId) return o;
      if (t.team.phase !== 'vote') throw err('validation', 'Голосование сейчас закрыто');
      if (teamVotingEnded(state, t, now) && teamLeaders(state, t).length) throw err('validation', 'Голосование завершено. Ожидается подведение итогов');
      t.options.forEach(function (option) { option.votes = option.votes.filter(function (uid) { return uid !== actorId; }); });
      o.votes.push(actorId); t.team.ballots[actorId] = optId;
      var at = iso(now || Date.now()); t.updatedAt = at;
      if (!t.anonymous || actorId !== t.authorId) award(state, actorId, t, 'optionVoted', at);
      progressTeam(state, t, now); return o;
    }
    if (t.decision) throw err('validation', 'Решение уже выбрано');
    var i = o.votes.indexOf(actorId); if (i >= 0) o.votes.splice(i, 1); else o.votes.push(actorId);
    return o;
  }
  function chooseOption(state, actorId, id, optId, reason, now) {
    var u = user(state, actorId), t = byId(state.tickets, id); openForSolving(t);
    if (!canManage(state, u, t)) throw err('forbidden', 'Выбрать решение может ответственный');
    var o = byId(t.options || [], optId); if (!o) throw err('not_found', 'Вариант не найден');
    if (t.team) {
      if (!teamCoordinator(state, u, t)) throw err('forbidden', 'Равенство голосов разрешает ответственный или собственник');
      if (t.decision) { if (t.decision.optionId === optId) return t; throw err('validation', 'Решение уже выбрано командой'); }
      if (t.team.phase !== 'vote' || !teamVotingEnded(state, t, now)) throw err('validation', 'Сначала дождитесь завершения голосования');
      if (teamLeaders(state, t).indexOf(optId) < 0) throw err('validation', 'Можно выбрать только вариант с наибольшим числом голосов');
      reason = trim(reason); if (reason.length < 5) throw err('validation', 'Объясните выбор одного из лидирующих вариантов');
      finishTeam(state, t, o, actorId, reason.slice(0, 500), now); return t;
    }
    reason = trim(reason); if (reason.length < 5) throw err('validation', 'Коротко объясните, почему выбран этот вариант');
    var at = iso(now || Date.now());
    t.decision = { optionId: o.id, by: u.id, at: at, reason: reason.slice(0, 500) };
    t.solution = t.solution || o.text;
    addEvent(state, t, u.id, 'decision', { text: 'Выбрано решение: «' + o.text.slice(0, 160) + '». Почему: ' + reason }, at);
    if (['new', 'review', 'clarify'].indexOf(t.status) >= 0) transition(state, actorId, id, 'work', { comment: 'Решение выбрано — составляем план действий' }, now);
    if (!t.anonymous || o.userId !== t.authorId) award(state, o.userId, t, 'optionChosen', at);
    notify(state, o.userId, t, '🏆 Ваш вариант решения выбран для ' + t.id + '!', at);
    return t;
  }
  function canPlan(state, u, t) { return canManage(state, u, t) || (isStaff(u) && t.executorId === u.id); }
  function addStep(state, actorId, id, data, now) {
    var u = user(state, actorId), t = byId(state.tickets, id); openForSolving(t);
    requireTeamReady(t);
    if (!canSee(state, u, t) || pending(state, t)) throw err('not_found', 'Обращение не найдено');
    if (!canPlan(state, u, t)) throw err('forbidden', 'План составляют ответственный или исполнитель');
    if (!t.decision && !triageOn(state)) throw err('validation', 'Сначала выберите решение из вариантов');
    var text = trim(data.text); if (text.length < 3) throw err('validation', 'Опишите шаг');
    var unassigned = data.assigneeId === '', as = unassigned ? null : user(state, data.assigneeId || t.executorId || t.assigneeId);
    if (!as && !unassigned) throw err('validation', 'Выберите исполнителя шага');
    if (data.due && !Number.isFinite(ts(data.due))) throw err('validation', 'Некорректный срок шага');
    var at = iso(now || Date.now());
    t.plan = t.plan || [];
    if (t.plan.length >= 20) throw err('validation', 'Не больше 20 шагов');
    var s = { id: nextId(state, 'step', 's'), text: text.slice(0, 300), assigneeId: as ? as.id : null, due: data.due ? iso(ts(data.due)) : null, state: 'todo', createdAt: at, doneAt: null };
    t.plan.push(s); t.updatedAt = at;
    if (canManage(state, u, t) && t.status !== 'work' && STATUSES[t.status].open) transition(state, actorId, id, 'work', { comment: 'План действий составлен' }, now);
    addEvent(state, t, u.id, 'plan', { text: 'Шаг плана: ' + s.text + ' → ' + (as ? as.name : 'Свободный шаг') + (s.due ? ' до ' + fmtShort(s.due) : '') }, at);
    if (as && as.id !== u.id) notify(state, as.id, t, '📌 Вам шаг по ' + t.id + ': ' + s.text + (s.due ? ' (до ' + fmtShort(s.due) + ')' : ''), at);
    return s;
  }
  function setStep(state, actorId, id, stepId, patch, now) {
    var u = user(state, actorId), t = byId(state.tickets, id); openForSolving(t);
    requireTeamReady(t);
    if (!u || !canSee(state, u, t) || pending(state, t)) throw err('not_found', 'Обращение не найдено');
    var s = byId(t.plan || [], stepId); if (!s) throw err('not_found', 'Шаг не найден');
    if (patch.claim === true) {
      if (Object.keys(patch).some(function (k) { return k !== 'claim'; })) throw err('validation', 'Взятие шага не совмещается с другими изменениями');
      if (!STATUSES[t.status].open || s.state === 'done') throw err('validation', 'Шаг уже завершён');
      if (s.assigneeId && s.assigneeId !== actorId) throw err('forbidden', 'Шаг уже назначен другому сотруднику');
      if (s.assigneeId === actorId) return t;
      s.assigneeId = actorId; t.updatedAt = iso(now || Date.now());
      addEvent(state, t, actorId, 'plan', { text: 'Взял(а) шаг: ' + s.text }, t.updatedAt);
      notify(state, t.assigneeId, t, u.name + ' взял(а) шаг: ' + s.text, t.updatedAt);
      return t;
    }
    if (!(canPlan(state, u, t) || s.assigneeId === actorId)) throw err('forbidden', 'Шаг отмечает исполнитель или ответственный');
    var at = iso(now || Date.now());
    if (patch.remove) { if (!canPlan(state, u, t)) throw err('forbidden', 'Удалять шаги может ответственный'); t.plan = t.plan.filter(function (x) { return x.id !== stepId; }); addEvent(state, t, u.id, 'plan', { text: 'Шаг удалён: ' + s.text }, at); return t; }
    if (patch.state && ['todo', 'doing', 'done'].indexOf(patch.state) >= 0 && patch.state !== s.state) {
      s.state = patch.state; s.doneAt = patch.state === 'done' ? at : null;
      addEvent(state, t, u.id, 'plan', { text: (patch.state === 'done' ? '✓ Выполнен шаг: ' : patch.state === 'doing' ? '▶ В работе шаг: ' : '↺ Шаг возвращён: ') + s.text }, at);
      if (patch.state === 'done') {
        if (!state.ledger.some(function (l) { return l.kind === 'step' && l.stepId === s.id; })) state.ledger.push({ id: nextId(state, 'ledger', 'p'), userId: s.assigneeId, ticketId: t.id, stepId: s.id, kind: 'step', amount: POINTS.step.amount, label: 'Выполнен шаг плана · ' + t.id, at: at });
        var pp = planProgress(t);
        if (pp && pp.done === pp.total) notify(state, t.assigneeId, t, '✅ План по ' + t.id + ' выполнен полностью — зафиксируйте результат и эффект', at);
      }
    }
    if (patch.due !== undefined && canPlan(state, u, t)) s.due = patch.due ? iso(ts(patch.due)) : null;
    if (patch.assigneeId && canPlan(state, u, t) && user(state, patch.assigneeId)) { s.assigneeId = patch.assigneeId; notify(state, patch.assigneeId, t, '📌 Вам передан шаг по ' + t.id + ': ' + s.text, at); }
    t.updatedAt = at;
    return t;
  }
  function verifyEffect(state, actorId, id, data, now) {
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!t) throw err('not_found', 'Обращение не найдено');
    requireTeamReady(t);
    if (triageOn(state) ? !isTriager(state, u) : !canManage(state, u, t)) throw err('forbidden', triageOn(state) ? 'Результат подтверждает собственник' : 'Эффект подтверждает ответственный или собственник');
    if (t.status !== 'done') throw err('validation', 'Эффект проверяется после внедрения');
    var at = iso(now || Date.now()), ok = !!data.ok, note = trim(data.note);
    if (!ok && note.length < 5) throw err('validation', 'Опишите, что не сработало');
    t.verify = t.verify || {};
    t.verify.result = ok ? 'confirmed' : 'failed'; t.verify.at = at; t.verify.by = u.id; t.verify.after = trim(data.after) || t.verify.after || (t.impact && t.impact.after) || ''; t.verify.note = note;
    addEvent(state, t, u.id, 'verify', { text: ok ? '✔ Эффект подтверждён' + (t.verify.after ? ': ' + t.verify.after : '') : '✖ Эффект не подтвердился: ' + note }, at);
    if (ok) {
      if (!t.anonymous) award(state, t.authorId, t, 'verified', at);
      notify(state, t.authorId, t, '🏁 Решение по ' + t.id + ' подтверждено проверкой эффекта. Спасибо!', at);
      if (triageOn(state)) {
        t.status = 'closed'; t.updatedAt = at;
        addEvent(state, t, u.id, 'status', { from: 'done', to: 'closed', text: 'Результат подтверждён — решено' }, at);
        notify(state, t.assigneeId, t, '✔ ' + t.id + ': собственник подтвердил результат', at);
      }
    } else {
      t.status = 'work'; t.closedAt = null; t.updatedAt = at;
      addEvent(state, t, null, 'status', { from: 'done', to: 'work', text: 'Эффект не подтвердился — решение дорабатывается' }, at);
      notify(state, t.assigneeId, t, 'Эффект по ' + t.id + ' не подтвердился — нужна доработка', at);
    }
    return t;
  }
  function myTasks(state, userId, now) {
    now = now || Date.now(); var u = user(state, userId); if (!u) throw err('forbidden', 'Нет пользователя');
    var steps = [], decide = [], verify = [], planNeed = [], executing = [];
    state.tickets.forEach(function (t) {
      (t.plan || []).forEach(function (s) { if (s.assigneeId === userId && s.state !== 'done' && STATUSES[t.status].open) steps.push({ ticketId: t.id, title: t.title, step: clone(s), overdue: stepOverdue(s, now) }); });
      if (!canManage(state, u, t) || !STATUSES[t.status].open && t.status !== 'done') return;
      var st = stageOf(t, now);
      if (u.role === 'manager' || t.assigneeId === userId || ((u.role === 'owner' || u.role === 'admin') && t.zone === 'mgmt')) {
        if (st === 'options' && (t.assigneeId === userId || t.zone === 'mgmt')) decide.push({ ticketId: t.id, title: t.title, options: t.options.length, topVotes: Math.max.apply(null, t.options.map(function (o) { return o.votes.length; })) });
        if (st === 'plan' && t.assigneeId === userId) planNeed.push({ ticketId: t.id, title: t.title });
        if (st === 'verify' && t.assigneeId === userId) verify.push({ ticketId: t.id, title: t.title, due: t.verify && t.verify.dueAt, overdue: t.verify && t.verify.dueAt && ts(t.verify.dueAt) < now });
      }
    });
    state.tickets.forEach(function (t) { if (t.executorId === userId && STATUSES[t.status].open) executing.push({ ticketId: t.id, title: t.title, stage: stageOf(t, now) }); });
    steps.sort(function (a, b) { return (b.overdue - a.overdue) || (ts(a.step.due || '2100-01-01') - ts(b.step.due || '2100-01-01')); });
    return { steps: steps, decide: decide, plan: planNeed, verify: verify, executing: executing, total: steps.length + decide.length + planNeed.length + verify.filter(function (v) { return v.overdue; }).length };
  }
  function solutionStats(state, now) {
    now = now || Date.now();
    var T = state.tickets.filter(function (t) { return t.type !== 'praise'; });
    var by = {}; Object.keys(STAGES).forEach(function (k) { by[k] = []; });
    T.forEach(function (t) { by[stageOf(t, now)].push(t.id); });
    var overdueSteps = [];
    T.forEach(function (t) { (t.plan || []).forEach(function (s) { if (stepOverdue(s, now) && STATUSES[t.status].open) overdueSteps.push({ ticketId: t.id, step: s.text, assignee: (user(state, s.assigneeId) || {}).name, due: s.due }); }); });
    var stuckDecisions = T.filter(function (t) { return stageOf(t, now) === 'options' && t.options.length && now - ts(t.options[t.options.length - 1].at) > 3 * DAY; }).map(function (t) { return { id: t.id, title: t.title, options: t.options.length, assignee: (user(state, t.assigneeId) || {}).name }; });
    var verifyDue = T.filter(function (t) { return t.status === 'done' && t.verify && !t.verify.result && t.verify.dueAt && ts(t.verify.dueAt) < now; }).map(function (t) { return t.id; });
    var solvedTimes = T.filter(function (t) { return t.status === 'done' && t.closedAt; }).map(function (t) { return (ts(t.closedAt) - ts(t.createdAt)) / DAY; });
    var withOptions = T.filter(function (t) { return (t.options || []).length; }).length;
    return {
      stages: Object.keys(by).map(function (k) { return { id: k, label: STAGES[k].label, ids: by[k], n: by[k].length }; }),
      overdueSteps: overdueSteps, stuckDecisions: stuckDecisions, verifyDue: verifyDue,
      solvedShare: T.length ? Math.round((by.solved.length + by.verify.length) / T.length * 100) : 0,
      confirmed: by.solved.length,
      avgDaysToSolve: solvedTimes.length ? Math.round(solvedTimes.reduce(function (a, b) { return a + b; }, 0) / solvedTimes.length * 10) / 10 : null,
      optionsCoverage: T.length ? Math.round(withOptions / T.length * 100) : 0,
      altCoverage: T.length ? Math.round(T.filter(function (t) { return (t.options || []).length >= 2; }).length / T.length * 100) : 0
    };
  }
  function solutionPrompt(t, similarSolved) {
    return 'Ты — эксперт по улучшению процессов в компании-дистрибьюторе систем безопасности (ГК «Модус Трейд»: проектирование, закупки, продажи, ПНР, сервис). ' +
      'Предложи 3 РАЗНЫХ варианта решения проблемы сотрудника: быстрый (за неделю, без затрат), системный (меняет процесс или регламент), технологический (автоматизация/инструмент). ' +
      'Для каждого: суть в 1–2 предложениях, ожидаемый эффект с измеримым показателем, примерные затраты. Учитывай, как похожие проблемы решали раньше (если есть).\n\n' +
      'ПРОБЛЕМА ' + t.id + ' «' + t.title + '»: ' + t.text + (t.solution ? '\nВариант автора: ' + t.solution : '') +
      (similarSolved && similarSolved.length ? '\n\nКАК РЕШАЛИ ПОХОЖЕЕ:\n' + similarSolved.map(function (s) { return '- ' + s.title + ': ' + s.result; }).join('\n') : '') +
      '\n\nОтветь ТОЛЬКО JSON-массивом из 3 объектов: [{"text": "...", "effect": "...", "cost": "..."}]';
  }
  function similarSolved(state, t) {
    return findSimilar(state, t.title + ' ' + t.text, t.id, 5).map(function (s) { return s.ticket; }).filter(function (x) { return x.status === 'done' && x.result; }).slice(0, 3).map(function (x) { return { id: x.id, title: x.title, result: x.result }; });
  }

  /* ───────────────────────── Игра: задания, сундуки, серии, сезоны, лиги, команда ───────────────────────── */
  // Octalysis / Hooked: короткие задания (действие) → монеты (награда) → сундук (переменная награда) → серия и лига (вложение)
  var QUESTS = [
    { id: 'q_solution', icon: '💡', name: 'Предложи решение',            desc: 'Предложи вариант решения к любой проблеме',        goal: 1, reward: 10, roles: ['employee', 'manager'] },
    { id: 'q_step',     icon: '📌', name: 'Сделай шаг',                   desc: 'Выполни шаг плана решения',                        goal: 1, reward: 10, roles: ['employee', 'manager'] },
    { id: 'q_support',  icon: '👍', name: 'Поддержи коллег',              desc: 'Нажми «+ У меня тоже» на 2 чужих обращениях',     goal: 2, reward: 5,  roles: ['employee', 'manager'] },
    { id: 'q_kudos',    icon: '🙏', name: 'Скажи спасибо',                desc: 'Поблагодари коллегу за конкретное дело',          goal: 1, reward: 5,  roles: ['employee', 'manager', 'admin'] },
    { id: 'q_chat',     icon: '💬', name: 'Будь на связи',                desc: 'Напиши в общий чат или ответь на уточнение',      goal: 1, reward: 3,  roles: ['employee'] },
    { id: 'q_claim',    icon: '✋', name: 'Возьмись сам',                  desc: 'Возьми проблему из общего списка на себя',        goal: 1, reward: 10, roles: ['employee'] },
    { id: 'q_fast',     icon: '⏱', name: 'Ответь вовремя',               desc: 'Дай 3 первых ответа в пределах SLA',              goal: 3, reward: 10, roles: ['manager', 'admin'] },
    { id: 'q_close',    icon: '✅', name: 'Доведи до результата',          desc: 'Закрой обращение с итогом или мотивированным отказом', goal: 1, reward: 10, roles: ['manager', 'admin'] }
  ];
  var LEAGUES = [
    { id: 'bronze',   name: 'Бронзовая лига',   icon: '🥉', min: 0 },
    { id: 'silver',   name: 'Серебряная лига',  icon: '🥈', min: 30 },
    { id: 'gold',     name: 'Золотая лига',     icon: '🥇', min: 80 },
    { id: 'platinum', name: 'Платиновая лига',  icon: '💎', min: 150 }
  ];
  var CHEST = [ // вес, монеты, редкий значок
    { w: 40, coins: 5 }, { w: 28, coins: 10 }, { w: 17, coins: 20 }, { w: 9, coins: 30 }, { w: 4, coins: 50, rare: 'Счастливчик' }, { w: 2, coins: 0, prize: 'lunch', rare: 'Джекпот: обед с собственником' }
  ];
  var COVEY7 = [
    { id: 'h1', name: 'Будь проактивен',              desc: 'Взялся решить проблему сам' },
    { id: 'h2', name: 'Начинай, представляя цель',     desc: '3 обращения с ожидаемым результатом' },
    { id: 'h3', name: 'Сначала главное',               desc: 'Поднял важную несрочную проблему (квадрант II)' },
    { id: 'h4', name: 'Думай win-win',                 desc: 'Поддержал 3 чужих обращения' },
    { id: 'h5', name: 'Сначала пойми',                 desc: 'Ответил на уточнение ответственного' },
    { id: 'h6', name: 'Синергия',                      desc: 'Твоё решение приняли в работу' },
    { id: 'h7', name: 'Затачивай пилу',                desc: '4 недели активности подряд или обучение из магазина' }
  ];
  var ARCHETYPES = {
    P: { name: 'Производитель (P)', desc: 'Видишь, что мешает результату для клиента — сроки, качество, поставка.' },
    A: { name: 'Администратор (A)', desc: 'Наводишь порядок: регламенты, документы, ясные роли.' },
    E: { name: 'Предприниматель (E)', desc: 'Генерируешь новое: идеи, изменения, развитие.' },
    I: { name: 'Интегратор (I)', desc: 'Соединяешь людей и отделы, лечишь взаимодействие.' }
  };

  function weekStart(now) { var d = new Date(now); var day = (d.getDay() + 6) % 7; return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime(); }
  function monthStart(now) { var d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
  var MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

  function activityTimes(state, userId) {
    var out = [];
    state.tickets.forEach(function (t) {
      if (t.authorId === userId) out.push(ts(t.createdAt));
      (t.voteLog || []).forEach(function (v) { if (v.userId === userId) out.push(ts(v.at)); });
    });
    state.events.forEach(function (e) { if (e.userId === userId && (e.kind === 'comment' || e.kind === 'status' || e.kind === 'claimed')) out.push(ts(e.at)); });
    (state.chat || []).forEach(function (m) { if (m.userId === userId) out.push(ts(m.at)); });
    return out;
  }

  function questProgress(state, u, q, now) {
    var w = weekStart(now), id = u.id;
    var inW = function (s) { return ts(s) >= w; };
    switch (q.id) {
      case 'q_solution': return state.tickets.reduce(function (n, t) { return n + (t.options || []).filter(function (o) { return o.userId === id && inW(o.at); }).length; }, 0);
      case 'q_step': return state.ledger.filter(function (l) { return l.userId === id && l.kind === 'step' && inW(l.at); }).length;
      case 'q_support': return state.tickets.reduce(function (n, t) { return n + (t.voteLog || []).filter(function (v) { return v.userId === id && inW(v.at); }).length; }, 0);
      case 'q_kudos': return (state.chat || []).filter(function (m) { return m.kind === 'kudos' && m.userId === id && inW(m.at); }).length;
      case 'q_chat': return (state.chat || []).filter(function (m) { return m.userId === id && m.kind !== 'kudos' && inW(m.at); }).length + state.events.filter(function (e) { return e.userId === id && e.kind === 'comment' && inW(e.at); }).length;
      case 'q_claim': return state.events.filter(function (e) { return e.userId === id && e.kind === 'claimed' && /Вызвался|решит сам/.test(e.text || '') && inW(e.at); }).length;
      case 'q_fast': return state.ledger.filter(function (l) { return l.userId === id && l.kind === 'fast' && inW(l.at); }).length;
      case 'q_close': return state.events.filter(function (e) { return e.userId === id && e.kind === 'status' && ['done', 'rejected', 'closed'].indexOf(e.to) >= 0 && inW(e.at); }).length;
    }
    return 0;
  }

  function weekKey(now) { return localDay(iso(weekStart(now))); }
  function streakOf(state, userId, now) {
    now = now || Date.now();
    var times = activityTimes(state, userId), weeks = {};
    times.forEach(function (t) { weeks[weekStart(t)] = 1; });
    var w = weekStart(now), n = 0;
    if (!weeks[w]) w -= 7 * DAY; // текущая неделя ещё не начата — серия не потеряна до её конца
    while (weeks[w]) { n++; w -= 7 * DAY; }
    return { weeks: n, activeThisWeek: !!weeks[weekStart(now)] };
  }

  function seasonBoard(state, now) {
    now = now || Date.now(); var m = monthStart(now);
    var rows = state.users.filter(function (u) { return u.role !== 'owner' && !u.hideRating; }).map(function (u) {
      var pts = state.ledger.filter(function (l) { return l.userId === u.id && ts(l.at) >= m; }).reduce(function (s, l) { return s + l.amount; }, 0);
      return { userId: u.id, name: u.name, dept: u.dept, role: u.role, points: pts };
    }).sort(function (a, b) { return b.points - a.points; });
    rows.forEach(function (r, i) { r.place = i + 1; r.league = leagueOf(r.points); });
    return rows;
  }
  function leagueOf(p) { var cur = LEAGUES[0]; LEAGUES.forEach(function (l) { if (p >= l.min) cur = l; }); var i = LEAGUES.indexOf(cur); return { id: cur.id, name: cur.name, icon: cur.icon, min: cur.min, next: LEAGUES[i + 1] || null }; }

  function teamGoal(state, now) {
    now = now || Date.now(); var m = monthStart(now), g = state.settings.teamGoal || { target: 10, prize: 'Пицца-пятница для всего офиса' };
    var done = state.tickets.filter(function (t) { return t.status === 'done' && t.closedAt && ts(t.closedAt) >= m; }).length;
    var depts = {};
    state.ledger.forEach(function (l) { if (ts(l.at) < m) return; var u = user(state, l.userId); if (!u || u.role === 'owner') return; depts[u.dept] = (depts[u.dept] || 0) + l.amount; });
    var deptRows = Object.keys(depts).map(function (d) { return { dept: d, points: depts[d] }; }).sort(function (a, b) { return b.points - a.points; });
    return { month: MONTHS[new Date(now).getMonth()], target: g.target, prize: g.prize, done: done, progress: Math.min(1, done / Math.max(1, g.target)), depts: deptRows, daysLeft: Math.ceil((new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 1).getTime() - now) / DAY) };
  }

  function archetypeOf(state, userId) {
    var c = { P: 0, A: 0, E: 0, I: 0 }, n = 0;
    state.tickets.forEach(function (t) { if (t.authorId === userId && t.type !== 'praise') { c[paeiOf(t)] += 1; n++; } });
    (state.tickets).forEach(function (t) { if ((t.voteLog || []).some(function (v) { return v.userId === userId; })) { c[paeiOf(t)] += 0.5; n++; } });
    if (!n) return null;
    var top = Object.keys(c).sort(function (a, b) { return c[b] - c[a]; })[0];
    return { code: top, name: ARCHETYPES[top].name, desc: ARCHETYPES[top].desc, mix: c };
  }

  function coveyHabits(state, userId, now) {
    var mine = state.tickets.filter(function (t) { return t.authorId === userId; });
    var st = streakOf(state, userId, now);
    var got = {
      h1: state.tickets.some(function (t) { return t.executorId === userId; }),
      h2: mine.filter(function (t) { return t.effect; }).length >= 3,
      h3: mine.some(function (t) { return t.type !== 'praise' && quadrant(t, now) === 'Q2'; }) || mine.some(function (t) { return t.important === true; }),
      h4: state.tickets.filter(function (t) { return (t.votes || []).indexOf(userId) >= 0; }).length >= 3,
      h5: state.events.some(function (e) { return e.userId === userId && e.kind === 'comment' && mine.some(function (t) { return t.id === e.ticketId && state.events.some(function (x) { return x.ticketId === t.id && x.kind === 'status' && x.to === 'clarify' && ts(x.at) < ts(e.at); }); }); }),
      h6: state.ledger.some(function (l) { return l.userId === userId && l.kind === 'solution'; }),
      h7: st.weeks >= 4 || state.redemptions.some(function (r) { return r.userId === userId && r.rewardId === 'course' && r.state !== 'rejected'; })
    };
    return COVEY7.map(function (h) { var x = clone(h); x.earned = !!got[h.id]; return x; });
  }

  function gameState(state, userId, now) {
    now = now || Date.now();
    var u = user(state, userId); if (!u) throw err('forbidden', 'Нет пользователя');
    var wk = weekKey(now), role = u.role === 'owner' ? 'admin' : u.role;
    var quests = QUESTS.filter(function (q) { return q.roles.indexOf(role) >= 0; }).map(function (q) {
      var x = clone(q); x.progress = Math.min(q.goal, questProgress(state, u, q, now));
      x.claimed = state.ledger.some(function (l) { return l.userId === userId && l.kind === 'quest' && l.questId === q.id && l.week === wk; });
      x.ready = x.progress >= q.goal && !x.claimed; return x;
    });
    var claimedTotal = state.ledger.filter(function (l) { return l.userId === userId && l.kind === 'quest'; }).length;
    var opened = (state.chests || []).filter(function (c) { return c.userId === userId; }).length;
    var chests = Math.floor(claimedTotal / 3) - opened;
    var st = streakOf(state, userId, now);
    var season = seasonBoard(state, now), me = season.filter(function (r) { return r.userId === userId; })[0] || { points: 0, place: null, league: leagueOf(0) };
    var idx = season.indexOf(me);
    var neighbors = idx >= 0 ? season.slice(Math.max(0, idx - 2), idx + 3) : [];
    var today = new Date(now); today.setHours(0, 0, 0, 0);
    var social = {
      signalsToday: state.tickets.filter(function (t) { return ts(t.createdAt) >= today.getTime(); }).length,
      supportsToday: state.tickets.reduce(function (n, t) { return n + (t.voteLog || []).filter(function (v) { return ts(v.at) >= today.getTime(); }).length; }, 0),
      activeWeek: state.users.filter(function (x) { return streakOf(state, x.id, now).activeThisWeek; }).length
    };
    var bal = balance(state, userId);
    var nextReward = state.rewards.filter(function (r) { return r.active !== false && r.cost > bal.coins; }).sort(function (a, b) { return a.cost - b.cost; })[0] || null;
    var streakBonus = st.weeks >= 4 && !state.ledger.some(function (l) { return l.userId === userId && l.kind === 'streak' && l.week === wk; });
    return {
      week: wk, quests: quests, questsDone: quests.filter(function (q) { return q.claimed; }).length, chests: Math.max(0, chests), toNextChest: 3 - (claimedTotal % 3),
      streak: st, streakBonus: streakBonus, season: { name: MONTHS[today.getMonth()], me: me, neighbors: neighbors, top: season.slice(0, 3), size: season.length },
      team: teamGoal(state, now), social: social, archetype: archetypeOf(state, userId), habits: coveyHabits(state, userId, now),
      nextReward: nextReward ? { name: nextReward.name, icon: nextReward.icon, cost: nextReward.cost, need: nextReward.cost - bal.coins } : null,
      hideRating: !!u.hideRating, coins: bal.coins
    };
  }

  function claimQuest(state, userId, questId, now) {
    now = now || Date.now();
    var g = gameState(state, userId, now), q = g.quests.filter(function (x) { return x.id === questId; })[0];
    if (!q) throw err('not_found', 'Задание не найдено');
    if (q.claimed) throw err('validation', 'Награда за задание уже получена на этой неделе');
    if (!q.ready) throw err('validation', 'Задание ещё не выполнено: ' + q.progress + ' из ' + q.goal);
    var rec = { id: nextId(state, 'ledger', 'p'), userId: userId, ticketId: null, kind: 'quest', questId: q.id, week: g.week, amount: q.reward, label: 'Задание недели: ' + q.name, at: iso(now) };
    state.ledger.push(rec);
    var after = gameState(state, userId, now);
    return { reward: q.reward, chestUnlocked: after.chests > g.chests, game: after };
  }
  function claimStreak(state, userId, now) {
    now = now || Date.now(); var g = gameState(state, userId, now);
    if (!g.streakBonus) throw err('validation', 'Бонус за серию пока недоступен');
    state.ledger.push({ id: nextId(state, 'ledger', 'p'), userId: userId, ticketId: null, kind: 'streak', week: g.week, amount: 20, label: 'Серия ' + g.streak.weeks + ' нед. подряд 🔥', at: iso(now) });
    return gameState(state, userId, now);
  }
  function openChest(state, userId, now, rnd) {
    now = now || Date.now(); rnd = rnd == null ? Math.random() : rnd;
    var g = gameState(state, userId, now);
    if (g.chests < 1) throw err('validation', 'Сундук откроется после ещё ' + g.toNextChest + ' заданий');
    var total = CHEST.reduce(function (s, c) { return s + c.w; }, 0), x = rnd * total, pick = CHEST[0];
    for (var i = 0; i < CHEST.length; i++) { if (x < CHEST[i].w) { pick = CHEST[i]; break; } x -= CHEST[i].w; }
    var at = iso(now), u = user(state, userId);
    state.chests = state.chests || [];
    var c = { id: nextId(state, 'chest', 'c'), userId: userId, at: at, coins: pick.coins, rare: pick.rare || null, prize: pick.prize || null };
    state.chests.push(c);
    if (pick.coins) state.ledger.push({ id: nextId(state, 'ledger', 'p'), userId: userId, ticketId: null, kind: 'chest', amount: pick.coins, label: 'Сундук' + (pick.rare ? ': ' + pick.rare : ''), at: at });
    if (pick.prize === 'lunch') {
      state.redemptions.push({ id: nextId(state, 'redeem', 'r'), userId: userId, rewardId: 'lunch', name: 'Обед с собственником (джекпот из сундука)', icon: '🍽', cost: 0, at: at, state: 'approved', status: 'Выиграно в сундуке — HR свяжется', decidedBy: null, decidedAt: at, note: '' });
      state.users.filter(function (x) { return x.role === 'owner' || x.id === 'm14'; }).forEach(function (x) { notify(state, x.id, null, '🎰 ' + u.name + ' выиграл(а) джекпот — обед с собственником!', at); });
    }
    if (pick.rare) systemPost(state, '🎰 ' + u.name + ' открыл(а) сундук и получил(а): ' + pick.rare + (pick.coins ? ' (+' + pick.coins + ' монет)' : '') + '!', null, at);
    return { chest: c, game: gameState(state, userId, now) };
  }
  function setHideRating(state, userId, hide) { var u = user(state, userId); if (!u) throw err('forbidden', 'Нет пользователя'); u.hideRating = !!hide; return { hideRating: u.hideRating }; }
  function setTeamGoal(state, actorId, target, prize) {
    if (!isAdmin(user(state, actorId))) throw err('forbidden', 'Только собственник');
    var t = Math.round(+target); if (!(t >= 1 && t <= 1000)) throw err('validation', 'Цель от 1 до 1000');
    state.settings.teamGoal = { target: t, prize: trim(prize).slice(0, 120) || 'Командный праздник' };
    return state.settings.teamGoal;
  }
  function heroOfWeek(state, now) {
    now = now || Date.now(); var w = weekStart(now) - 7 * DAY, e = weekStart(now);
    var pts = {};
    state.ledger.forEach(function (l) { var t = ts(l.at); if (t >= w && t < e) { var u = user(state, l.userId); if (u && u.role !== 'owner' && !u.hideRating) pts[l.userId] = (pts[l.userId] || 0) + l.amount; } });
    var best = Object.keys(pts).sort(function (a, b) { return pts[b] - pts[a]; })[0];
    return best ? { userId: best, name: user(state, best).name, points: pts[best] } : null;
  }

  /* ───────────────────────── Методологии: Адизес · Кови · Карнеги ───────────────────────── */

  // Адизес: какую функцию организации затрагивает проблема (PAEI)
  var PAEI = {
    P: { label: 'P · Результат', short: 'P', name: 'Производство результата', desc: 'Клиенты, сроки, качество поставки и ПНР — «что мы делаем»', color: '#E40000' },
    A: { label: 'A · Порядок', short: 'A', name: 'Администрирование', desc: 'Регламенты, документы, контроль, учёт — «как мы делаем»', color: '#082742' },
    E: { label: 'E · Развитие', short: 'E', name: 'Предпринимательство', desc: 'Новые идеи, продукты, изменения — «что и зачем делать завтра»', color: '#C77A00' },
    I: { label: 'I · Команда', short: 'I', name: 'Интеграция', desc: 'Взаимодействие, коммуникации, культура — «кто и вместе ли»', color: '#1E9E5A' }
  };
  var CAT_PAEI = { c01: 'I', c02: 'I', c03: 'A', c04: 'E', c05: 'A', c06: 'A', c07: 'A', c08: 'I', c09: 'A', c10: 'I', c11: 'P', c12: 'I', c13: 'P', c14: 'P', c15: 'A', c16: 'I', c17: 'A', c18: 'E' };

  // Кови (круг влияния) + Адизес (CAPI: у кого полномочия, власть и влияние решить)
  var ZONES = {
    self:    { label: 'Могу решить сам',           hint: 'Кови: проактивность — действуйте в своём круге влияния. Вы станете исполнителем.', capi: 'Полномочия у автора' },
    team:    { label: 'Решаем в подразделении',     hint: 'Нужны силы команды, но решение в руках подразделения.', capi: 'Полномочия у руководителя подразделения' },
    mgmt:    { label: 'Нужно решение руководства',  hint: 'Адизес: без полномочий и ресурсов сверху проблему не решить — обращение увидит собственник.', capi: 'Нужна коалиция CAPI: собственник/руководство' },
    outside: { label: 'Вне контроля компании',      hint: 'Кови: это круг забот. Подумайте, что в нём всё-таки можем изменить мы — так и сформулируйте.', capi: 'Вне CAPI компании — ищем, на что влияем' }
  };

  // Кови: матрица важное/срочное
  var QUADRANTS = {
    Q1: { label: 'I · Важно и срочно',     action: 'Делать сейчас',              tone: 'red',   desc: 'Кризисы и горящие сроки' },
    Q2: { label: 'II · Важно, не срочно',   action: 'Планировать — здесь развитие', tone: 'green', desc: 'Системные улучшения, профилактика, развитие' },
    Q3: { label: 'III · Срочно, не важно',  action: 'Делегировать',               tone: 'amber', desc: 'Отвлекающие срочности' },
    Q4: { label: 'IV · Не важно, не срочно', action: 'Отложить или отказаться',    tone: 'grey',  desc: 'Можно мотивированно отклонить' }
  };
  function paeiOf(t) { return t.paei || CAT_PAEI[t.categoryId] || 'A'; }
  function isUrgent(t, now) {
    now = now || Date.now();
    if (!STATUSES[t.status].open) return false;
    if (t.priority === 'high' || overdueInfo(t, now)) return true;
    var due = t.firstResponseAt ? ts(t.resolveDue) : ts(t.respondDue);
    return due - now < 48 * HOUR;
  }
  function isImportant(t) {
    if (t.important === true || t.important === false) return t.important;
    return (t.votes || []).length >= 2 || t.priority === 'high' || paeiOf(t) === 'E' || !!(t.solution && t.effect) || t.zone === 'mgmt';
  }
  function quadrant(t, now) { var u = isUrgent(t, now), i = isImportant(t); return i && u ? 'Q1' : i ? 'Q2' : u ? 'Q3' : 'Q4'; }

  function classify(state, actorId, id, patch, now) {
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!t) throw err('not_found', 'Обращение не найдено');
    var author = t.authorId === actorId;
    if (!canManage(state, u, t) && !(author && t.status === 'new')) throw err('forbidden', 'Классифицировать может ответственный');
    var at = iso(now || Date.now()), changes = [];
    if (patch.paei !== undefined && PAEI[patch.paei] && patch.paei !== paeiOf(t)) { changes.push('PAEI: ' + PAEI[paeiOf(t)].short + ' → ' + PAEI[patch.paei].short); t.paei = patch.paei; }
    if (patch.zone !== undefined && ZONES[patch.zone] && patch.zone !== t.zone) {
      changes.push('Круг влияния: ' + (ZONES[t.zone] ? ZONES[t.zone].label : '—') + ' → ' + ZONES[patch.zone].label); t.zone = patch.zone;
      if (patch.zone === 'mgmt') state.users.filter(function (x) { return x.role === 'owner'; }).forEach(function (o) { notify(state, o.id, t, '⚖ ' + t.id + ' требует решения руководства: ' + t.title, at); });
    }
    if (patch.important !== undefined && canManage(state, u, t)) {
      var v = patch.important === null ? null : !!patch.important;
      if (v !== (t.important == null ? null : t.important)) { changes.push('Важность: ' + (v === null ? 'авто' : v ? 'важно' : 'не важно')); t.important = v; }
    }
    if (changes.length) { t.updatedAt = at; addEvent(state, t, u.id, 'classified', { text: changes.join('; ') }, at); }
    return t;
  }

  // Карнеги: подсказки по тону ответа (хвалите, говорите о ситуации, дайте сохранить лицо, предложите путь)
  var HARSH = ['бред', 'ерунд', 'чушь', 'глупо', 'бессмысл', 'не ваше дело', 'не нужно', 'нелеп', 'вы не понимаете', 'опять вы', 'сколько можно', 'очевидно же', 'не выдумывайте', 'отстань', 'некогда', 'не до этого'];
  function carnegieCheck(text, kind) {
    var x = trim(text).toLowerCase(), tips = [], score = 100;
    if (x.length < 5) return { score: 0, tips: [] };
    var thanks = /спасиб|благодар|ценю|ценим|хорошо, что|отличн|здорово|правильно, что|важное наблюдение|полезн/.test(x);
    HARSH.forEach(function (w) { if (x.indexOf(w) >= 0) { tips.push({ k: 'harsh', t: 'Смягчите «' + w + '…»: критикуйте идею, а не человека' }); score -= 30; } });
    if (/(^|\s)вы (не|опять|снова|всегда|никогда)\b/.test(x)) { tips.push({ k: 'blame', t: 'Говорите о ситуации, а не «вы не…» — дайте человеку сохранить лицо' }); score -= 20; }
    if ((kind === 'rejected' || kind === 'clarify' || kind === 'done') && !thanks) { tips.push({ k: 'thanks', t: 'Начните с искренней благодарности за сигнал — так человек продолжит сообщать о сбоях' }); score -= 25; }
    if (kind === 'rejected' && !/предлага|можно|вернёмся|вернемся|если|когда|давайте|вместо|альтернатив|попробу/.test(x)) { tips.push({ k: 'path', t: 'Предложите альтернативу или условие, при котором вернётесь к идее' }); score -= 20; }
    if (kind === 'rejected' && !/потому|так как|из-за|поскольку|причин|сейчас нет|не позволя/.test(x)) { tips.push({ k: 'why', t: 'Объясните причину — без неё отказ звучит как отмахивание' }); score -= 15; }
    if (kind === 'clarify' && !/пожалуйста|подскажите|уточните|могли бы|расскажите/.test(x)) { tips.push({ k: 'ask', t: 'Сформулируйте как просьбу: «уточните, пожалуйста…»' }); score -= 10; }
    if (x.length > 30 && x === x.toUpperCase() && /[А-ЯA-Z]/.test(text)) { tips.push({ k: 'caps', t: 'Не пишите капслоком — это воспринимается как крик' }); score -= 15; }
    return { score: Math.max(0, score), tips: tips };
  }
  function carnegieTemplates(t, kind, authorName) {
    var who = authorName && authorName !== 'Анонимно' ? authorName.split(' ')[0] : '';
    var title = '«' + (t.title || '').slice(0, 70) + '»';
    if (kind === 'rejected') return [
      'Спасибо, что подняли вопрос ' + title + ' — это важное наблюдение. Сейчас мы не можем это внедрить, потому что [причина]. Предлагаю [альтернатива]; вернёмся к вопросу [когда/при каком условии].',
      'Ценю, что вы предложили решение, а не просто описали проблему. Мы обсудили его и пока не берём в работу, так как [причина]. Если [условие изменится], давайте вернёмся — буду рад вашей помощи.',
      'Благодарю за сигнал! Эта задача уже решается в рамках [A-xxx] — присоединяйтесь туда, ваш опыт там пригодится.'
    ];
    if (kind === 'clarify') return [
      'Спасибо за сигнал! Чтобы быстрее помочь, уточните, пожалуйста: [вопрос]?',
      'Хорошо, что вы об этом написали. Подскажите, пожалуйста, пример: где и когда это было последний раз?',
      'Благодарю! Чтобы предложить решение, мне не хватает [данных]. Могли бы вы приложить фото или документ?'
    ];
    if (kind === 'done' || kind === 'closed') return [
      'Спасибо' + (who ? ', ' + who : '') + '! Благодаря вашему сигналу [что сделано]. Эффект: [было → стало].',
      'Готово: [что сделано]. Отдельное спасибо автору — без вашего сигнала мы бы это не заметили.'
    ];
    return ['Спасибо за сигнал! Приняли в работу: [план и срок].', 'Хорошая идея — берём. Ответственный [кто], срок [когда]. Будем держать в курсе.'];
  }

  // Карнеги: публичное признание коллег
  function kudos(state, actorId, toId, text, now) {
    var u = user(state, actorId), to = user(state, toId);
    if (!u) throw err('forbidden', 'Нет пользователя');
    if (!to) throw err('not_found', 'Коллега не найден');
    if (toId === actorId) throw err('validation', 'Себя поблагодарить нельзя — попросите коллег 😉');
    text = trim(text);
    if (text.length < 5) throw err('validation', 'Напишите, за что именно — конкретная похвала ценится больше');
    now = now || Date.now();
    var week = (state.chat || []).filter(function (m) { return m.kind === 'kudos' && m.userId === actorId && now - ts(m.at) < 7 * DAY; }).length;
    if (week >= 5) throw err('validation', 'Не больше 5 благодарностей в неделю — пусть каждая будет весомой');
    var at = iso(now);
    state.chat = state.chat || [];
    var m = { id: nextId(state, 'chat', 'm'), userId: actorId, kind: 'kudos', toUserId: toId, text: text.slice(0, 500), files: [], at: at, replyTo: null, ticketId: null, suggestTicket: false };
    state.chat.push(m);
    var dup = state.ledger.filter(function (l) { return l.kind === 'kudos' && l.userId === toId && l.fromId === actorId && now - ts(l.at) < 7 * DAY; }).length;
    if (!dup) state.ledger.push({ id: nextId(state, 'ledger', 'p'), userId: toId, ticketId: null, kind: 'kudos', fromId: actorId, amount: POINTS.kudos.amount, label: 'Спасибо от: ' + u.name, at: at });
    notify(state, toId, null, '🙏 ' + u.name + ' благодарит вас: ' + text.slice(0, 140), at);
    return m;
  }

  function systemPost(state, text, ticketId, at) {
    state.chat = state.chat || [];
    var m = { id: nextId(state, 'chat', 'm'), userId: null, kind: 'celebrate', text: text, files: [], at: at, replyTo: null, ticketId: null, refTicket: ticketId, suggestTicket: false };
    state.chat.push(m);
    return m;
  }

  function methodStats(state, now) {
    now = now || Date.now();
    var open = state.tickets.filter(function (t) { return STATUSES[t.status].open && t.type !== 'praise'; });
    var paei = { P: 0, A: 0, E: 0, I: 0 }, paeiAll = { P: 0, A: 0, E: 0, I: 0 }, quad = { Q1: [], Q2: [], Q3: [], Q4: [] }, zones = { self: [], team: [], mgmt: [], outside: [], none: [] };
    state.tickets.forEach(function (t) { if (t.type !== 'praise') paeiAll[paeiOf(t)]++; });
    open.forEach(function (t) { paei[paeiOf(t)]++; quad[quadrant(t, now)].push(t.id); (zones[t.zone] || zones.none).push(t.id); });
    var top = Object.keys(paei).sort(function (a, b) { return paei[b] - paei[a]; })[0];
    var interp = {
      P: 'Больше всего открытых проблем в P (результат): страдают сроки и качество для клиента. По Адизесу — сначала стабилизировать «производство результата».',
      A: 'Больше всего открытых проблем в A (порядок): не хватает регламентов, ясных ролей и контроля. По Адизесу это риск «бюрократизации наоборот» — хаоса; нужен минимальный порядок без лишней бумаги.',
      E: 'Больше всего открытых вопросов в E (развитие): идей много, а внедрять их некому. Назначьте владельцев идей и сроки.',
      I: 'Больше всего открытых проблем в I (команда): буксует взаимодействие между отделами. По Адизесу интеграция — ключ к переходу в «Расцвет»: общие правила, доверие, совместные разборы.'
    }[top];
    var focus = quad.Q1.length + quad.Q2.length + quad.Q3.length + quad.Q4.length;
    var month = now - 30 * DAY;
    var kd = (state.chat || []).filter(function (m) { return m.kind === 'kudos' && ts(m.at) >= month; });
    var givers = {}; kd.forEach(function (m) { givers[m.userId] = (givers[m.userId] || 0) + 1; });
    var rejected = state.events.filter(function (e) { return e.kind === 'status' && e.to === 'rejected'; });
    var polite = rejected.filter(function (e) { return carnegieCheck(e.text, 'rejected').score >= 70; }).length;
    return {
      paei: paei, paeiAll: paeiAll, paeiTop: top, paeiInsight: interp,
      quadrants: quad, q2Share: focus ? Math.round(quad.Q2.length / focus * 100) : 0, q1Share: focus ? Math.round(quad.Q1.length / focus * 100) : 0,
      zones: zones,
      kudos30: kd.length, kudosGivers: Object.keys(givers).map(function (id) { return { userId: id, name: (user(state, id) || {}).name, n: givers[id] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 5),
      kudosFeed: kd.slice(-6).reverse().map(function (m) { return { from: (user(state, m.userId) || {}).name, fromId: m.userId, to: (user(state, m.toUserId) || {}).name, toId: m.toUserId, text: m.text, at: m.at }; }),
      rejectTone: rejected.length ? Math.round(polite / rejected.length * 100) : null
    };
  }

  /* ───────────────────────── Файлы ───────────────────────── */
  var FILE_URL = /^(\/_blob\/[A-Za-z0-9_-]{8,64}|\/api\/files\/[A-Za-z0-9_-]{8,64}|idb:[A-Za-z0-9_-]{4,64})$/;
  function fileKind(type) { type = String(type || ''); return type.indexOf('image/') === 0 ? 'image' : type.indexOf('video/') === 0 ? 'video' : 'doc'; }
  function cleanFiles(list) {
    return (list || []).slice(0, 10).map(function (f) {
      var url = String(f.url || '');
      return {
        id: String(f.id || '').slice(0, 64), name: String(f.name || 'файл').slice(0, 140), size: +f.size || 0,
        type: String(f.type || '').slice(0, 80), kind: fileKind(f.type), url: FILE_URL.test(url) ? url : ''
      };
    });
  }

  /* ───────────────────────── «Взять в работу», поощрения, напоминания ───────────────────────── */
  function claim(state, actorId, id, now) {
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!teamActive(u)) throw err('forbidden', 'Нет активного пользователя');
    if (!t) throw err('not_found', 'Обращение не найдено');
    requireTeamReady(t);
    if (pending(state, t)) throw err('validation', 'Сначала собственник решает: «В работу» или «В корзину»');
    if (!STATUSES[t.status].open) throw err('validation', 'Обращение уже закрыто');
    if (t.type === 'praise') throw err('validation', 'Отзыв не требует работы');
    if (u.role === 'employee' && t.assigneeId !== u.id) throw err('forbidden', 'Приступить к выполнению может назначенный ответственный');
    var at = iso(now || Date.now());
    if (isStaff(u) || t.assigneeId === u.id) {
      if (t.status === 'work' && t.assigneeId === u.id) throw err('validation', 'Обращение уже у вас в работе');
      if (t.assigneeId !== u.id) {
        var prev = user(state, t.assigneeId);
        t.assigneeId = u.id;
        addEvent(state, t, u.id, 'assigned', { text: 'Забрал(а) себе' + (prev ? ' (было: ' + prev.name + ')' : ''), to: u.id }, at);
        if (prev && prev.id !== u.id) notify(state, prev.id, t, u.name + ' забрал(а) обращение ' + t.id + ' в работу', at);
      }
      if (t.status !== 'work') {
        var origin = t.status;
        if (origin === 'new' || origin === 'review' || origin === 'clarify') {
          t.status = 'work'; t.updatedAt = at; markResponded(state, t, u, at);
          var pw = PRIORITIES[t.priority] || PRIORITIES.medium;
          if (!triageOn(state)) t.resolveDue = iso(Math.max(ts(t.resolveDue), ts(at) + pw.resolveD * 2 * DAY)); t.esc_resolve = null;
          addEvent(state, t, u.id, 'status', { from: origin, to: 'work', text: 'Взято в работу из общего списка' }, at);
          if (!t.anonymous) { if (origin === 'new') award(state, t.authorId, t, 'signal', at); if (t.solution && !t.team) award(state, t.authorId, t, 'solution', at); }
          notify(state, t.authorId, t, 'Ваше обращение ' + t.id + ' взято в работу: ' + u.name, at);
        }
      }
      return t;
    }
    if (t.executorId && t.executorId !== u.id) throw err('validation', 'Уже взял(а): ' + (user(state, t.executorId) || {}).name);
    if (t.executorId === u.id) { t.executorId = null; addEvent(state, t, u.id, 'claimed', { text: 'Отказался(ась) от выполнения' }, at); return t; }
    t.executorId = u.id; t.updatedAt = at;
    addEvent(state, t, u.id, 'claimed', { text: 'Вызвался(ась) решить сам(а). Ответственный подтверждает результат' }, at);
    notify(state, t.assigneeId, t, u.name + ' готов(а) решить ' + t.id + ' сам(а)', at);
    return t;
  }

  function bonus(state, actorId, userId, amount, reason, now) {
    var u = user(state, actorId), x = user(state, userId);
    if (!isAdmin(u)) throw err('forbidden', 'Поощрять может собственник или администратор');
    if (!x) throw err('not_found', 'Нет пользователя');
    amount = Math.round(+amount);
    if (!(amount >= 5 && amount <= 500)) throw err('validation', 'Размер поощрения: от 5 до 500 баллов');
    reason = trim(reason) || 'За вклад в улучшения';
    var at = iso(now || Date.now());
    var rec = { id: nextId(state, 'ledger', 'p'), userId: x.id, ticketId: null, kind: 'bonus', amount: amount, label: 'Поощрение: ' + reason.slice(0, 140), at: at };
    state.ledger.push(rec);
    notify(state, x.id, null, '🏆 ' + u.name + ' поощрил(а) вас: +' + amount + ' баллов. ' + reason, at);
    return rec;
  }

  function nudge(state, actorId, id, now) {
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!isStaff(u)) throw err('forbidden', 'Недостаточно прав');
    if (!t) throw err('not_found', 'Обращение не найдено');
    var at = iso(now || Date.now());
    var target = t.status === 'clarify' ? t.authorId : t.assigneeId;
    addEvent(state, t, u.id, 'nudge', { text: u.name + ' напомнил(а) ' + (t.status === 'clarify' ? 'автору об уточнении' : 'ответственному о сроке') }, at);
    notify(state, target, t, '🔔 ' + u.name + ' просит ускорить ' + t.id + ': ' + t.title, at);
    return t;
  }

  /* ───────────────────────── Общий чат ───────────────────────── */
  var PROBLEM_WORDS = ['не работает', 'проблем', 'опять', 'снова', 'сломал', 'мешает', 'долго', 'потерял', 'не могу', 'никто не', 'жалоб', 'ошибк', 'завис', 'не приш', 'не отвеча', 'бардак', 'теряется', 'задерж'];
  function looksLikeProblem(text) {
    var x = trim(text).toLowerCase(); if (x.length < 25) return false;
    return PROBLEM_WORDS.some(function (w) { return x.indexOf(w) >= 0; });
  }
  function postChat(state, actorId, data, now) {
    var u = user(state, actorId);
    if (!u) throw err('forbidden', 'Нет пользователя');
    var text = trim(data.text), files = cleanFiles(data.files);
    if (!text && !files.length) throw err('validation', 'Пустое сообщение');
    if (text.length > 4000) throw err('validation', 'Слишком длинное сообщение');
    state.chat = state.chat || [];
    var m = { id: nextId(state, 'chat', 'm'), userId: u.id, text: text, files: files, at: iso(now || Date.now()), replyTo: data.replyTo || null, ticketId: null };
    m.suggestTicket = u.role === 'employee' && looksLikeProblem(text);
    state.chat.push(m);
    if (state.chat.length > 2000) state.chat.splice(0, state.chat.length - 2000);
    return m;
  }
  function listChat(state, viewerId, opts) {
    opts = opts || {};
    var list = (state.chat || []).slice().sort(function (a, b) { return ts(a.at) - ts(b.at); });
    if (opts.after) list = list.filter(function (m) { return ts(m.at) > ts(opts.after); });
    return list.slice(-(opts.limit || 200)).map(function (m) {
      var x = clone(m), a = user(state, m.userId);
      x.userName = a ? a.name : 'МОДУС · СИГНАЛ'; x.userRole = a ? a.role : 'system'; x.mine = !!m.userId && m.userId === viewerId;
      if (m.kind === 'kudos') { var tu = user(state, m.toUserId); x.toName = tu ? tu.name : '—'; }
      var refs = (m.text.match(/A-\d{3,}/g) || []).filter(function (id, i, arr) { return arr.indexOf(id) === i && byId(state.tickets, id) && canSee(state, user(state, viewerId), byId(state.tickets, id)); });
      x.refs = refs.map(function (id) { var t = byId(state.tickets, id); return { id: id, title: t.title, status: t.status }; });
      return x;
    });
  }

  /* ───────────────────────── Люди: активность и зона ответственности ───────────────────────── */
  function peopleStats(state, now) {
    now = now || Date.now();
    var month = now - 30 * DAY;
    return state.users.filter(function (u) { return u.role !== 'owner'; }).map(function (u) {
      var mine = state.tickets.filter(function (t) { return t.authorId === u.id && !t.anonymous; });
      var acts = [];
      mine.forEach(function (t) { acts.push(ts(t.createdAt)); });
      state.events.forEach(function (e) { if (e.userId === u.id) acts.push(ts(e.at)); });
      (state.chat || []).forEach(function (m) { if (m.userId === u.id) acts.push(ts(m.at)); });
      var last = acts.length ? Math.max.apply(null, acts) : 0;
      var recent = acts.filter(function (x) { return x >= month; }).length;
      var votes = state.tickets.filter(function (t) { return (t.votes || []).indexOf(u.id) >= 0; }).length;
      var chatN = (state.chat || []).filter(function (m) { return m.userId === u.id; }).length;
      var b = balance(state, u.id);
      var r = {
        userId: u.id, name: u.name, role: u.role, dept: u.dept, absent: !!u.absent,
        submitted: mine.length, withSolution: mine.filter(function (t) { return t.solution; }).length,
        accepted: mine.filter(function (t) { return ['work', 'done'].indexOf(t.status) >= 0; }).length,
        implemented: mine.filter(function (t) { return t.status === 'done'; }).length,
        rejected: mine.filter(function (t) { return t.status === 'rejected'; }).length,
        waitingMe: mine.filter(function (t) { return t.status === 'clarify'; }).map(function (t) { return t.id; }),
        executing: state.tickets.filter(function (t) { return t.executorId === u.id && STATUSES[t.status].open; }).map(function (t) { return t.id; }),
        votes: votes, chat: chatN, points: b.earned, lastActive: last ? iso(last) : null,
        daysSilent: last ? Math.floor((now - last) / DAY) : null, activity30: recent
      };
      r.activityScore = r.activity30 + r.implemented * 5 + r.accepted * 3 + r.withSolution * 2 + Math.min(r.votes, 5);
      if (isStaff(u)) {
        var asg = state.tickets.filter(function (t) { return t.assigneeId === u.id; });
        var resp = asg.filter(function (t) { return t.firstResponseAt; });
        var inSla = resp.filter(function (t) { return ts(t.firstResponseAt) <= ts(t.respondDue); }).length;
        r.assigned = asg.length;
        r.open = asg.filter(function (t) { return STATUSES[t.status].open; }).length;
        r.overdue = asg.filter(function (t) { return overdueInfo(t, now); }).map(function (t) { return t.id; });
        r.noResponse = asg.filter(function (t) { return !t.firstResponseAt && STATUSES[t.status].open; }).map(function (t) { return t.id; });
        r.avgResponseH = resp.length ? Math.round(resp.reduce(function (s, t) { return s + ts(t.firstResponseAt) - ts(t.createdAt); }, 0) / resp.length / HOUR * 10) / 10 : null;
        r.slaRate = asg.length ? Math.round(inSla / asg.length * 100) : null;
        r.delivered = asg.filter(function (t) { return t.status === 'done'; }).length;
        r.escalations = state.events.filter(function (e) { return e.kind === 'escalated' && asg.some(function (t) { return t.id === e.ticketId; }); }).length;
      }
      return r;
    });
  }

  /* ───────────────────────── Ежедневный разбор для собственника ───────────────────────── */
  function ownerDigest(state, now) {
    now = now || Date.now();
    var T = state.tickets, people = peopleStats(state, now), an = analytics(state, now);
    var name = function (id) { return (user(state, id) || {}).name || '—'; };
    var open = T.filter(function (t) { return STATUSES[t.status].open; });
    // Входящие собственника: обращения, которые ждут решения «В работу» / «В корзину»
    var waiting = triageOn(state) ? T.filter(function (t) { return t.status === 'new'; }) : [];
    var inbox = { count: waiting.length, oldestH: waiting.length ? Math.round(Math.max.apply(null, waiting.map(function (t) { return now - ts(t.createdAt); })) / HOUR) : 0 };

    // Висящие вопросы
    var hanging = open.map(function (t) {
      if (pending(state, t)) return null;
      var o = overdueInfo(t, now), age = Math.floor((now - ts(t.createdAt)) / DAY), idle = Math.floor((now - ts(t.updatedAt)) / DAY);
      var reason = o ? o.label : (t.status === 'clarify' && idle >= 3) ? 'Автор не отвечает на уточнение ' + idle + ' дн.' : idle >= 7 ? 'Нет движения ' + idle + ' дн.' : null;
      return reason ? { id: t.id, title: t.title, status: t.status, priority: t.priority, assigneeId: t.assigneeId, assignee: name(t.assigneeId), ageDays: age, idleDays: idle, reason: reason, overdue: !!o, votes: (t.votes || []).length } : null;
    }).filter(Boolean).sort(function (a, b) { return (b.overdue - a.overdue) || ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]) || b.ageDays - a.ageDays; });

    // Активные
    var active = people.filter(function (p) { return p.activityScore > 0; }).sort(function (a, b) { return b.activityScore - a.activityScore; }).slice(0, 5)
      .map(function (p) { return { userId: p.userId, name: p.name, dept: p.dept, role: p.role, score: p.activityScore, points: p.points, note: [p.submitted ? p.submitted + ' обращ.' : '', p.implemented ? 'внедрено ' + p.implemented : '', p.delivered ? 'довёл до результата ' + p.delivered : '', p.votes ? 'поддержал ' + p.votes : '', p.chat ? 'в чате ' + p.chat : ''].filter(Boolean).join(', ') }; });

    // Требуют внимания
    var attention = [];
    people.forEach(function (p) {
      var reasons = [], todo = '';
      if (p.role === 'employee') {
        if (p.waitingMe.length) { reasons.push('не ответил(а) на уточнение: ' + p.waitingMe.join(', ')); todo = 'Напомнить и помочь сформулировать — иначе идея потеряется'; }
        if (p.rejected >= 1 && p.accepted === 0 && p.implemented === 0) { reasons.push('получил(а) отказ и пока ни одного принятого решения'); todo = todo || 'Короткий разговор: объяснить причину отказа, помочь доработать следующую идею'; }
        if (p.submitted === 0 && p.votes === 0 && p.chat === 0) { reasons.push('ни одного сигнала, голоса или сообщения'); todo = todo || 'Проверить вовлечённость: возможно, не знает о системе или не верит, что её услышат'; }
        else if (p.daysSilent != null && p.daysSilent >= 21) { reasons.push('молчит ' + p.daysSilent + ' дн.'); todo = todo || 'Спросить, что мешает делиться проблемами'; }
      } else if (isStaff(user(state, p.userId)) && p.role !== 'owner') {
        if (p.overdue && p.overdue.length === 1) { reasons.push('просрочено: ' + p.overdue.join(', ')); todo = 'Напомнить о сроке, при повторении — разговор'; }
        if (p.absent && an.managers.some(function (m) { return m.userId === p.userId && m.open > 0; })) { reasons.push('отсутствует, но на нём открытые обращения'); todo = 'Передать замещающему'; }
      }
      if (reasons.length) attention.push({ userId: p.userId, name: p.name, role: p.role, dept: p.dept, reasons: reasons, todo: todo });
    });

    // К поощрению
    var reward = people.filter(function (p) { return p.role !== 'admin'; }).map(function (p) {
      var why = [];
      var impact = T.filter(function (t) { return t.authorId === p.userId && !t.anonymous && t.status === 'done' && t.impact; });
      if (impact.length) why.push('измеримый эффект: ' + impact.map(function (t) { return t.id + ' (' + t.impact.before + ' → ' + t.impact.after + ')'; }).join(', '));
      else if (p.implemented) why.push('внедрено улучшений: ' + p.implemented);
      if (p.withSolution >= 3) why.push('системно приходит с решениями (' + p.withSolution + ')');
      if (p.delivered >= 1 && p.slaRate != null && p.slaRate >= 80) why.push('довёл до результата ' + p.delivered + ', ответ в срок ' + p.slaRate + '%');
      if (p.executing && p.executing.length) why.push('сам взялся решить: ' + p.executing.join(', '));
      return why.length ? { userId: p.userId, name: p.name, role: p.role, dept: p.dept, reasons: why, suggest: impact.length ? 50 : 30 } : null;
    }).filter(Boolean).sort(function (a, b) { return b.suggest - a.suggest || b.reasons.length - a.reasons.length; }).slice(0, 5);

    // Зона риска (решение — за собственником)
    var risk = people.filter(function (p) { return p.role === 'manager' || p.role === 'admin'; }).map(function (p) {
      var ev = [];
      if (p.overdue && p.overdue.length >= 2) ev.push('просрочено ' + p.overdue.length + ' обращ.: ' + p.overdue.join(', '));
      if (p.assigned >= 2 && p.slaRate != null && p.slaRate < 50) ev.push('отвечает в срок лишь на ' + p.slaRate + '% обращений');
      if (p.noResponse && p.noResponse.length >= 2) ev.push('без единого ответа: ' + p.noResponse.join(', '));
      if (p.escalations >= 2) ev.push('эскалаций: ' + p.escalations);
      if (p.assigned >= 3 && p.delivered === 0) ev.push('из ' + p.assigned + ' обращений ни одно не доведено до результата');
      return ev.length >= 2 ? { userId: p.userId, name: p.name, role: p.role, dept: p.dept, evidence: ev, level: ev.length >= 3 ? 'high' : 'medium',
        recommendation: 'Разговор 1:1 на этой неделе и план на 2 недели: ответ в срок ≥ 90%, ноль просрочек. Временно передать часть категорий замещающему. Если через 2 недели без изменений — решение о замене ответственного или о расставании.' } : null;
    }).filter(Boolean);

    // Корректировки: что и где поменять
    var corrections = [];
    an.clusters.forEach(function (c) {
      var t = byId(T, c.lead);
      if (t && STATUSES[t.status].open && c.weight >= 3 && t.priority !== 'high') corrections.push({ title: 'Поднять приоритет ' + t.id, detail: '«' + t.title + '» поддержали ' + c.votes + ' сотрудника — это системная проблема, а не частный случай.', where: { label: 'Карточка ' + t.id, href: '#/t/' + t.id }, action: { kind: 'priority', ticketId: t.id, value: 'high', label: 'Сделать высоким' } });
    });
    hanging.filter(function (h) { return h.overdue; }).forEach(function (h) {
      corrections.push({ title: 'Ускорить ' + h.id, detail: h.reason + ' у «' + h.assignee + '». Автор ждёт ' + h.ageDays + ' дн.', where: { label: 'Карточка ' + h.id, href: '#/t/' + h.id }, action: { kind: 'nudge', ticketId: h.id, label: 'Напомнить' } });
    });
    state.users.filter(function (u) { return u.absent; }).forEach(function (u) {
      var cats = state.categories.filter(function (c) { return c.owner === u.id; });
      if (cats.length) corrections.push({ title: 'Временный владелец для «' + cats.map(function (c) { return c.name; }).join('», «') + '»', detail: u.name + ' — ' + (u.absentNote || 'отсутствует') + '. Обращения уходят замещающему; убедитесь, что он не перегружен.', where: { label: 'Настройки и маршруты', href: '#/admin' } });
    });
    var loaded = people.filter(function (p) { return isStaff(user(state, p.userId)) && (p.open >= 3 || (p.overdue || []).length >= 2); });
    var freeMgr = people.filter(function (p) { return p.role === 'manager' && !p.absent && (p.open || 0) <= 1 && !(p.overdue || []).length; }).sort(function (a, b) { return (a.open || 0) - (b.open || 0); })[0];
    loaded.forEach(function (p) {
      var cats = state.categories.filter(function (c) { return c.owner === p.userId; }).map(function (c) { return c.name; });
      if (cats.length > 1) corrections.push({ title: 'Разгрузить: ' + p.name, detail: 'Открыто ' + p.open + ', просрочено ' + (p.overdue || []).length + '. Категории: ' + cats.join(', ') + (freeMgr ? '. Предложение: передать «' + cats[cats.length - 1] + '» → ' + freeMgr.name + ' (открыто ' + (freeMgr.open || 0) + ').' : '.'), where: { label: 'Настройки и маршруты', href: '#/admin' } });
    });
    T.filter(function (t) { return t.status === 'done' && !t.impact; }).forEach(function (t) {
      corrections.push({ title: 'Нет эффекта по ' + t.id, detail: 'Улучшение внедрено, но не измерено. Попросите «Было → Стало» — иначе непонятно, окупилось ли.', where: { label: 'Карточка ' + t.id, href: '#/t/' + t.id } });
    });
    var newOld = T.filter(function (t) { return t.status === 'new' && !overdueInfo(t, now) && now - ts(t.createdAt) > DAY; });
    if (newOld.length) corrections.push({ title: 'Разобрать новые: ' + newOld.map(function (t) { return t.id; }).join(', '), detail: 'Обращения старше суток без первого ответа — пока в пределах SLA, но скоро «загорятся».', where: { label: 'Общий список', href: '#/problems' } });

    var silent = people.filter(function (p) { return p.role === 'employee' && p.submitted === 0; }).length;
    var leader = leaderboard(state)[0] || null;

    // Здоровье процесса
    var score = 100 - an.overdue.length * 8 - hanging.filter(function (h) { return !h.overdue; }).length * 3 - risk.length * 8;
    if (an.avgFirstResponseH != null && an.avgFirstResponseH > 24) score -= 5;
    score += Math.min(12, an.implemented * 4);
    score = Math.max(0, Math.min(100, Math.round(score)));
    var health = { score: score, label: score >= 80 ? 'Всё под контролем' : score >= 60 ? 'Есть риски' : 'Горит', tone: score >= 80 ? 'green' : score >= 60 ? 'amber' : 'red' };

    var next = [];
    if (an.overdue.length) next.push('Сегодня: добиться первого ответа по ' + an.overdue.join(', ') + ' — кнопка «Напомнить» в списке висящих.');
    if (risk.length) next.push('На этой неделе: разговор 1:1 с ' + risk.map(function (r) { return r.name; }).join(', ') + ' и план исправления на 2 недели.');
    if (reward.length) next.push('Поощрить публично: ' + reward.slice(0, 3).map(function (r) { return r.name; }).join(', ') + ' — это главный сигнал команде, что предлагать выгодно.');
    if (corrections.some(function (c) { return c.action && c.action.kind === 'priority'; })) next.push('Поднять приоритет повторяющихся проблем и назначить срок системного решения.');
    var pend = state.redemptions.filter(function (r) { return r.state === 'pending'; });
    if (pend.length) next.push('Подтвердить заявки на награды (' + pend.length + '): ' + pend.map(function (r) { return name(r.userId) + ' — «' + r.name + '»'; }).join(', ') + '. Быстрое подтверждение — лучшая мотивация.');
    if (silent) next.push('Вовлечь «молчащих» (' + silent + ' чел.): короткий пример на планёрке, как превратить жалобу в сигнал с решением.');
    var ss = solutionStats(state, now);
    if (ss.stuckDecisions.length) next.push('Решения: варианты есть, но выбор не сделан — ' + ss.stuckDecisions.map(function (x) { return x.id + ' (' + x.assignee + ')'; }).join(', ') + '. Попросите выбрать вариант до конца недели.');
    if (ss.overdueSteps.length) next.push('План: сорвано шагов — ' + ss.overdueSteps.length + ' (' + ss.overdueSteps.slice(0, 3).map(function (x) { return x.ticketId + ' — ' + x.assignee; }).join('; ') + ').');
    if (ss.verifyDue.length) next.push('Проверить эффект внедрённых решений: ' + ss.verifyDue.join(', ') + ' — иначе непонятно, решена ли проблема на самом деле.');
    var ms = methodStats(state, now);
    if (ms.q1Share >= 40) next.push('Кови: ' + ms.q1Share + '% открытых вопросов — «пожары» (квадрант I), на развитие (II) — ' + ms.q2Share + '%. Выделите на неделе время под квадрант II, иначе пожары не кончатся.');
    var mg = open.filter(function (t) { return t.zone === 'mgmt'; });
    if (mg.length) next.push('Адизес (CAPI): решения на уровне руководства ждут ' + mg.map(function (t) { return t.id; }).join(', ') + ' — без ваших полномочий их не закрыть.');
    if (ms.rejectTone != null && ms.rejectTone < 70) next.push('Карнеги: только ' + ms.rejectTone + '% отказов звучат уважительно (благодарность + причина + путь). Попросите руководителей пользоваться шаблонами.');
    next.push('Через неделю сравнить: время первого ответа (сейчас ' + (an.avgFirstResponseH == null ? '—' : an.avgFirstResponseH + ' ч') + '), просрочки (сейчас ' + an.overdue.length + '), внедрения (сейчас ' + an.implemented + ').');

    return {
      date: iso(now), health: health,
      kpi: { total: an.total, open: open.length, overdue: an.overdue.length, implemented: an.implemented, avgFirstResponseH: an.avgFirstResponseH, closedShare: an.closedShare, participation: an.participation, newToday: T.filter(function (t) { return now - ts(t.createdAt) < DAY; }).length },
      inbox: inbox, hanging: hanging, active: active, attention: attention, reward: reward, risk: risk, corrections: corrections.slice(0, 10), nextSteps: next,
      leader: leader ? { userId: leader.userId, name: leader.name, points: leader.points } : null,
      solutions: solutionStats(state, now),
      method: methodStats(state, now),
      game: { hero: heroOfWeek(state, now), team: teamGoal(state, now), streaks: state.users.filter(function (u) { return u.role !== 'owner'; }).map(function (u) { return { name: u.name, weeks: streakOf(state, u.id, now).weeks }; }).filter(function (x) { return x.weeks >= 2; }).sort(function (a, b) { return b.weeks - a.weeks; }).slice(0, 5) },
      mgmtDecisions: open.filter(function (t) { return t.zone === 'mgmt'; }).map(function (t) { return { id: t.id, title: t.title, assignee: name(t.assigneeId) }; }),
      pendingRewards: state.redemptions.filter(function (r) { return r.state === 'pending'; }).map(function (r) { return { id: r.id, user: name(r.userId), reward: r.name, cost: r.cost }; }),
      clusters: an.clusters.slice(0, 4).map(function (c) { return { lead: c.lead, title: c.title, weight: c.weight }; })
    };
  }

  function digestText(d) {
    var L = [];
    L.push('Пульс: ' + d.health.score + '/100 — ' + d.health.label + '. Открыто ' + d.kpi.open + ', просрочено ' + d.kpi.overdue + ', внедрено ' + d.kpi.implemented + ', средний первый ответ ' + (d.kpi.avgFirstResponseH == null ? '—' : d.kpi.avgFirstResponseH + ' ч') + '.');
    if (d.inbox && d.inbox.count) L.push('\nВо входящих: ' + d.inbox.count + ' обращ. ждут вашего решения «В работу» или «В корзину»; самое старое — ' + d.inbox.oldestH + ' ч.');
    if (d.hanging.length) L.push('\nВисит:\n' + d.hanging.slice(0, 6).map(function (h) { return '• ' + h.id + ' «' + h.title + '» — ' + h.reason + ' (' + h.assignee + ')'; }).join('\n'));
    if (d.active.length) L.push('\nАктивные: ' + d.active.map(function (a) { return a.name; }).join(', ') + '.');
    if (d.attention.length) L.push('\nТребуют внимания:\n' + d.attention.map(function (a) { return '• ' + a.name + ': ' + a.reasons.join('; ') + '. → ' + a.todo; }).join('\n'));
    if (d.reward.length) L.push('\nК поощрению:\n' + d.reward.map(function (r) { return '• ' + r.name + ': ' + r.reasons.join('; ') + ' (предлагаю +' + r.suggest + ')'; }).join('\n'));
    if (d.risk.length) L.push('\nЗона риска (решение за вами после разговора):\n' + d.risk.map(function (r) { return '• ' + r.name + ': ' + r.evidence.join('; '); }).join('\n'));
    if (d.corrections.length) L.push('\nКорректировки:\n' + d.corrections.slice(0, 6).map(function (c) { return '• ' + c.title + ' — ' + c.detail; }).join('\n'));
    if (d.solutions) L.push('\nРешения: решено и внедрено ' + d.solutions.solvedShare + '%, эффект подтверждён у ' + d.solutions.confirmed + '; ждут выбора варианта: ' + (d.solutions.stuckDecisions.map(function (x) { return x.id; }).join(', ') || 'нет') + '; сорванных шагов плана: ' + d.solutions.overdueSteps.length + '.');
    if (d.method) L.push('\nМетодики: PAEI — ' + Object.keys(d.method.paei).map(function (k) { return k + ' ' + d.method.paei[k]; }).join(', ') + '. ' + d.method.paeiInsight + ' Кови: пожары (I) ' + d.method.q1Share + '%, развитие (II) ' + d.method.q2Share + '%. Карнеги: благодарностей за 30 дней — ' + d.method.kudos30 + '.');
    L.push('\nЧто дальше:\n' + d.nextSteps.map(function (s, i) { return (i + 1) + '. ' + s; }).join('\n'));
    return L.join('\n');
  }

  function localDay(s) { var d = new Date(s); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function saveReport(state, actorId, rep, now) {
    var u = actorId ? user(state, actorId) : null;
    if (actorId && !isAdmin(u)) throw err('forbidden', 'Отчёты доступны собственнику');
    var at = iso(now || Date.now()), d = rep.digest || ownerDigest(state, now);
    state.reports = state.reports || [];
    var r = { id: nextId(state, 'report', 'R'), at: at, day: localDay(at), source: rep.source === 'ai' ? 'ai' : 'rules', model: trim(rep.model).slice(0, 60), text: trim(rep.text) || digestText(d), health: d.health, kpi: d.kpi };
    state.reports.push(r);
    if (state.reports.length > 120) state.reports.splice(0, state.reports.length - 120);
    return r;
  }
  function ensureDailyReport(state, now) {
    now = now || Date.now();
    var day = localDay(iso(now));
    if ((state.reports || []).some(function (r) { return localDay(r.at) === day; })) return null;
    var r = saveReport(state, null, {}, now);
    state.users.filter(function (u) { return u.role === 'owner'; }).forEach(function (o) { notify(state, o.id, null, '📋 Ежедневный отчёт агента готов: пульс ' + r.health.score + '/100 — ' + r.health.label, r.at); });
    return r;
  }
  function listReports(state, actorId) {
    if (!isAdmin(user(state, actorId))) throw err('forbidden', 'Отчёты доступны собственнику');
    return (state.reports || []).slice(-30).reverse();
  }

  // Промпт для LLM-агента: данные + роль + формат (одинаков для сервера и браузера)
  function agentPrompt(digest, question) {
    var rules = 'Ты — ИИ-агент собственника ГК «Модус Трейд» (проектный дистрибьютор систем безопасности). ' +
      'Ты анализируешь систему обращений сотрудников «МОДУС · СИГНАЛ». Пиши по-русски, коротко, по делу, без воды, деловым тоном партнёра. ' +
      'Опирайся ТОЛЬКО на данные ниже, не выдумывай людей и цифры, всегда указывай номера обращений (A-xxx) и имена из данных. ' +
      'Применяй управленческие методики там, где они помогают решению: Адизес (PAEI — какая функция P/A/E/I проседает, CAPI — у кого полномочия решить, этап жизненного цикла — осторожно, как гипотезу), Кови (матрица важное/срочное — доля квадранта II, круг влияния, «начинай с конечной цели»), Карнеги (признание и публичная похвала, уважительный отказ, дать человеку сохранить лицо). Не пересказывай теорию — давай конкретные действия. ' +
      'Оценки людей давай на фактах из системы и помни, что она видит не всю работу человека: по «зоне риска» рекомендуй разговор и план, окончательное кадровое решение — за собственником.';
    var data = 'ДАННЫЕ НА ' + digest.date.slice(0, 10) + ' (JSON):\n' + JSON.stringify(digest);
    if (question) return rules + '\n\n' + data + '\n\nВОПРОС СОБСТВЕННИКА: ' + question + '\n\nОтветь конкретно, со ссылками на A-xxx и имена, и закончи 1–3 действиями.';
    return rules + '\n\n' + data + '\n\nСоставь ЕЖЕДНЕВНЫЙ ДОКЛАД собственнику в Markdown со следующими разделами (заголовки ##): ' +
      '«Главное за сутки» (3 строки), «Что висит» (по каждому: что, у кого, сколько ждёт, что сделать), «Где застряли решения» (варианты без выбора, сорванные шаги плана, непроверенный эффект), «Кто активен», «Кто требует внимания», «Кого поощрить» (с суммой баллов), ' +
      '«Зона риска» (факты и рекомендация; если пусто — так и напиши), «Где внести корректировки» (что, где в системе, как), «Методики» (2–4 строки: вывод по PAEI, по матрице Кови, по культуре признания), «Что делать дальше» (нумерованный план: сегодня / на неделе / процесс). Не более 520 слов.';
  }

  /* ───────────────────────── Формат дат ───────────────────────── */
  var MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDate(s) { var d = new Date(s); return d.getDate() + ' ' + MON[d.getMonth()] + ', ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function fmtShort(s) { var d = new Date(s); return d.getDate() + ' ' + MON[d.getMonth()]; }

  /* ───────────────────────── Тестовые данные (20 обращений из набора хакатона) ───────────────────────── */

  var SEED = [
    ['problem', 'c01', 'u1', 'medium', 'new', 'Нет назначения и параметров в заявках на оборудование',
      'В заявках на приобретение оборудования иногда не хватает назначения изделия и требуемых параметров.',
      'Добавить обязательные поля «назначение» и «требуемые параметры» в шаблон заявки, чтобы сократить число уточнений.', 1, null, 'Запросить пример корректно заполненной заявки; оценить изменение шаблона.'],
    ['idea', 'c02', 'u1', 'medium', 'review', 'Краткий статус проекта для работы с поставщиками',
      'При общении с поставщиками полезно видеть общую стадию проекта без доступа к коммерческим деталям.',
      'Показывать краткий статус и ориентировочные контрольные даты без коммерческой информации.', 6, 'Определить перечень доступных статусов и источник их обновления.'],
    ['problem', 'c03', 'u2', 'high', 'work', 'Разные обозначения одного изделия в спецификациях',
      'В рабочих материалах иногда встречаются разные обозначения одного изделия. Это увеличивает время проверки спецификации.',
      'Нужен понятный способ находить актуальную карточку позиции.', 9, 'Подготовить правило проверки и корректировки номенклатуры.'],
    ['idea', 'c04', 'u1', 'low', 'done', 'Короткие занятия по новым товарным линейкам',
      'Было бы полезно проводить короткие занятия по новым товарным линейкам с разбором типовых запросов.',
      'Составить календарь коротких обучающих встреч по новым линейкам.', 38, 'Запланирован пробный обучающий семинар.', { metric: 'Вопросов к техподдержке по новым линейкам в неделю', before: '14', after: '6' }],
    ['problem', 'c05', 'u3', 'medium', 'clarify', 'Непонятен этап обработки пакета документов',
      'При обработке документов между подразделениями возникают дополнительные вопросы о том, на каком этапе находится пакет.',
      'Видеть ответственного и текущий статус пакета документов.', 12, 'Уточните, пожалуйста, виды документов и ключевые этапы согласования, где чаще всего теряется статус.'],
    ['idea', 'c06', 'u3', 'medium', 'review', 'Пошаговая памятка для межотдельных операций',
      'Для операций, в которых последовательно участвуют несколько подразделений, нет единой короткой инструкции.',
      'Собрать короткую пошаговую памятку и определить порядок её актуализации.', 7, 'Назначить владельца процесса и согласовать черновик инструкции.'],
    ['problem', 'c07', 'u3', 'high', 'new', 'Повторный ввод одних и тех же сведений в разных системах',
      'Иногда повторный ввод одних и тех же сведений в разных рабочих системах занимает много времени.',
      'Оценить, какие операции можно синхронизировать безопасно.', 3, null],
    ['idea', 'c08', 'u3', 'low', 'done', 'Памятка по типовым ошибкам при передаче задачи новичку',
      'При передаче сложной задачи новому сотруднику не хватает разбора типовых ошибок и контактов для помощи.',
      'Сделать памятку с типовыми ошибками и контактами, к которым можно обратиться за помощью.', 30, 'Создана учебная инструкция.', { metric: 'Срок самостоятельной работы новичка, дней', before: '15', after: '9' }],
    ['problem', 'c09', 'u4', 'high', 'work', 'Неясно, кто готовит и проверяет приложение к договору',
      'Не всегда понятно, кто готовит очередную версию приложения к договору и кто должен проверить её перед отправкой. Это приводит к повторным согласованиям.',
      'Разграничить этапы подготовки, проверки и утверждения.', 10, 'Разграничить этапы подготовки, проверки и утверждения.'],
    ['idea', 'c10', 'u4', 'medium', 'review', 'Не закрывать задачу до подтверждения заказчиком',
      'Рабочие задачи закрываются раньше, чем заказчик внутри компании подтверждает результат, и связанные вопросы теряются.',
      'Не закрывать рабочую задачу до подтверждения заказчиком результата внутри компании, чтобы связанные вопросы оставались в общей истории.', 5, 'Проверить, подходит ли правило для разных типов задач.'],
    ['problem', 'c11', 'u4', 'high', 'new', 'Непрогнозируемые сроки ответа смежных подразделений',
      'При срочной подготовке клиентского предложения сложно прогнозировать сроки ответа от смежных подразделений.',
      'Видеть ожидаемый срок ответа и получать уведомление при задержке.', 2.2, null],
    ['idea', 'c12', 'u4', 'low', 'review', 'Единое место для итоговых решений по задаче',
      'Рабочие обсуждения распределены по нескольким каналам, из-за чего теряется контекст.',
      'Выбрать единое место для итоговых решений по задаче.', 8, 'Сравнить варианты и предложить правила фиксации итогов.'],
    ['problem', 'c13', 'u5', 'medium', 'clarify', 'Не видно, какие строки спецификации пересмотрены',
      'Когда изменяется состав оборудования в проекте, не всегда ясно, какие строки спецификации были пересмотрены.',
      'Нужна более заметная история изменений спецификации.', 11, 'Уточните формат исходных файлов спецификаций и как сейчас сравниваете версии.'],
    ['idea', 'c14', 'u5', 'medium', 'review', 'Укрупнённая загрузка проектной группы на ближайшие недели',
      'Сроки запуска новых задач согласуются вслепую: не видно загруженности проектной группы.',
      'Показывать загруженность проектной группы на ближайшие недели в укрупнённом виде.', 9, 'Согласовать показатели загрузки и права просмотра.'],
    ['problem', 'c15', 'u6', 'medium', 'work', 'Поручения без ожидаемого результата и даты завершения',
      'Некоторые поручения поступают без ожидаемого результата и даты завершения.',
      'Договориться о минимальном наборе данных при постановке задачи: цель, срок, приоритет, ответственный.', 14, 'Подготовить шаблон с целью, сроком, приоритетом и ответственным.'],
    ['idea', 'c04', 'u6', 'low', 'new', 'Практические демонстрации оборудования для новичков',
      'Новым сотрудникам показывают только презентации — не хватает работы с реальным оборудованием.',
      'Провести пилотное занятие с учебными образцами оборудования.', 1.5, null],
    ['idea', 'c16', 'u7', 'low', 'rejected', 'Зона для коротких перерывов рядом с рабочими помещениями',
      'Рядом с рабочими помещениями нет места для коротких перерывов.',
      'Организовать отдельную небольшую зону для коротких перерывов.', 20, 'Сейчас нет подходящего помещения; вернёмся к вопросу при перепланировке офиса.'],
    ['praise', 'c16', 'u7', 'low', 'closed', 'Польза внутренних учебных встреч',
      'Хочу отметить пользу внутренних учебных встреч: после них стало легче обращаться к коллегам за консультацией. Было бы хорошо сохранить этот формат.',
      '', 16, 'Положительный отзыв зафиксирован и передан организаторам обучения.'],
    ['problem', 'c17', 'u5', 'medium', 'review', 'Трудно определить актуальную редакцию инструкции',
      'В общих папках трудно быстро определить актуальную редакцию инструкции.',
      'Закрепить единые правила именования и архивирования старых версий.', 6, 'Согласовать порядок хранения и владельцев папок.'],
    ['idea', 'c18', 'u1', 'low', 'new', 'Обзор завершённых внутренних улучшений',
      'Сотрудники не видят, к чему привели направленные предложения.',
      'Публиковать краткий квартальный обзор завершённых улучшений без конфиденциальных сведений.', 0.6, null]
  ];

  // Ответственный по набору для конкретного обращения (условные роли)
  var SEED_ASSIGNEE = { 'A-003': 'm1', 'A-013': 'm11', 'A-018': 'm14' };

  function createSeedState(now, opts) {
    now = now || Date.now();
    var s = emptyState(), triage = !(opts && opts.triage === false);
    s.settings.ownerTriage = false; // история строится по прежним правилам, фильтр включается в конце
    SEED.forEach(function (row, i) {
      var type = row[0], cat = row[1], author = row[2], pr = row[3], status = row[4];
      var created = now - row[8] * DAY;
      var t = createTicket(s, author, { type: type, categoryId: cat, title: row[5], text: row[6], solution: row[7], priority: pr }, created);
      if (SEED_ASSIGNEE[t.id] && t.assigneeId !== SEED_ASSIGNEE[t.id]) t.assigneeId = SEED_ASSIGNEE[t.id];
      var mgr = t.assigneeId;
      var step = function (h) { return created + h * HOUR; };
      var note = row[9];
      if (status === 'new') return;
      if (status === 'review') { transition(s, mgr, t.id, 'review', { comment: 'Взято на рассмотрение. Следующий шаг: ' + note }, step(pr === 'high' ? 6 : 20)); return; }
      if (status === 'clarify') { transition(s, mgr, t.id, 'clarify', { comment: note }, step(18)); return; }
      if (status === 'work') {
        transition(s, mgr, t.id, 'review', { comment: 'Проблема подтверждена, разбираемся.' }, step(pr === 'high' ? 5 : 30));
        transition(s, mgr, t.id, 'work', { comment: 'Принято в работу: ' + note }, step(pr === 'high' ? 30 : 70));
        return;
      }
      if (status === 'done') {
        transition(s, mgr, t.id, 'review', { comment: 'Идея интересная, оцениваем ресурсы.' }, step(10));
        transition(s, mgr, t.id, 'work', { comment: 'Принято в работу.' }, step(50));
        transition(s, mgr, t.id, 'done', { result: note, impact: row[10] }, step(24 * 12));
        return;
      }
      if (status === 'rejected') { transition(s, mgr, t.id, 'rejected', { rejectReason: note }, step(40)); return; }
      if (status === 'closed') { transition(s, mgr, t.id, 'closed', { result: note }, step(20)); return; }
    });
    // Уточнение автора и поддержка коллег для демонстрации повторяющихся проблем
    var votes = { 'A-011': ['u1', 'u5', 'u6', 'u2'], 'A-005': ['u4', 'u1'], 'A-007': ['u1', 'u4', 'u8'], 'A-019': ['u2', 'u3', 'u6'], 'A-012': ['u5', 'u3'], 'A-003': ['u5'] };
    Object.keys(votes).forEach(function (id) { var t = byId(s.tickets, id); if (t) { t.votes = votes[id].slice(); t.voteLog = votes[id].map(function (u, k) { return { userId: u, at: iso(now - (1 + k * 1.7) * DAY) }; }); } });
    // Одно обращение просрочено по сроку решения (есть ответ, но работа затянулась)
    var a15 = byId(s.tickets, 'A-015'); if (a15) { a15.resolveDue = iso(now - 2 * DAY); }
    var CH = [
      ['m2', 'Коллеги, напоминаю: все рабочие проблемы — через «Сигнал», а не в коридоре. Так ничего не потеряется.', 6.2],
      ['u4', 'Опять жду ответ от проектировщиков по срокам для клиента второй день, КП стоит. Это уже не первый раз.', 4.1],
      ['u5', 'Поддерживаю A-011 — у нас та же история с ответами смежников.', 3.9],
      ['m4', 'По итогам A-004: семинар по новым линейкам прошёл, вопросов в техподдержку стало в 2 раза меньше 👍', 3.0],
      ['u1', 'Спасибо за семинар! Можно следующий сделать по СКУД?', 2.9],
      ['u3', 'В общей папке снова две разные версии инструкции по закрывающим документам, не понимаю какая актуальная.', 1.6],
      ['m15', 'Вижу, это A-019 — согласуем правила хранения на этой неделе.', 1.5],
      ['u6', 'Готов показать новичкам демо-стенд СКУД на следующей неделе, если нужно для A-016.', 0.7],
      ['u2', 'Кто-нибудь знает, когда обновят прайс по видеонаблюдению?', 0.3]
    ];
    CH.forEach(function (c) { postChat(s, c[0], { text: c[1] }, now - c[2] * DAY); });
    var Z = { 'A-001': 'team', 'A-003': 'team', 'A-005': 'team', 'A-007': 'mgmt', 'A-009': 'team', 'A-011': 'mgmt', 'A-013': 'team', 'A-014': 'mgmt', 'A-015': 'team', 'A-017': 'mgmt', 'A-019': 'team', 'A-002': 'team', 'A-006': 'self', 'A-016': 'self' };
    Object.keys(Z).forEach(function (id) { var t = byId(s.tickets, id); if (t) t.zone = Z[id]; });
    var a16 = byId(s.tickets, 'A-016'); if (a16) a16.executorId = 'u6';
    kudos(s, 'u1', 'm4', 'Спасибо за семинар по новым линейкам — теперь отвечаю клиентам сам, без техподдержки', now - 2.8 * DAY);
    kudos(s, 'u5', 'u3', 'Памятка для новичков — огонь, наш стажёр разобрался за день', now - 1.2 * DAY);
    kudos(s, 'm1', 'u2', 'Спасибо за примеры по обозначениям в спецификациях — быстро нашли корень проблемы', now - 0.5 * DAY);
    // Решения: пул вариантов, выбор, план, проверка эффекта
    var opt = function (id, uid, text, eff, d, voters) { var t = byId(s.tickets, id); if (!t || t.decision) return null; var o = proposeOption(s, uid, id, { text: text, effect: eff }, now - d * DAY); o.votes = (voters || []).slice(); return o; };
    var first = function (id) { var t = byId(s.tickets, id); return t && t.options[0]; };
    opt('A-001', 'u5', 'Сделать в 1С выпадающий список «назначение» и обязательное поле «параметры» для групп оборудования СКУД и видео', 'Уточнений по заявкам меньше в 2 раза', 0.8, ['u2', 'u4']);
    if (first('A-001')) first('A-001').votes = ['u8'];
    opt('A-011', 'u5', 'Ввести внутренний SLA ответа смежников: 4 часа на срочные клиентские запросы, с меткой «срочно» в Битрикс24', 'КП уходит клиенту в тот же день', 1.6, ['u4', 'u6', 'u1']);
    opt('A-011', 'm11', 'Назначить дежурного проектировщика на день для срочных расчётов продаж', 'Ответ на срочный запрос — до 2 часов', 1.2, ['u4']);
    opt('A-006', 'u1', 'Сделать памятки в виде схем на одну страницу и повесить в Битрикс24 в разделе «Регламенты»', 'Меньше вопросов «а кто дальше?»', 5, ['u3']);
    opt('A-014', 'm11', 'Еженедельная таблица загрузки проектировщиков в общем доступе (часы на неделю вперёд)', 'Сроки запуска согласуются за 1 день, а не за 3', 6, ['u5', 'u6']);
    opt('A-003', 'm1', 'Завести единый справочник позиций с артикулом производителя как ключом; остальные обозначения — синонимы', 'Время проверки спецификации −50%', 8.5, ['u5', 'u2']);
    var a3 = byId(s.tickets, 'A-003'), o3 = a3 && a3.options[a3.options.length - 1];
    if (o3) {
      chooseOption(s, 'm1', 'A-003', o3.id, 'Решает корень проблемы и подходит для 1С без доработок', now - 8 * DAY);
      var st1 = addStep(s, 'm1', 'A-003', { text: 'Собрать 20 примеров расхождений обозначений', assigneeId: 'u2', due: iso(now - 6 * DAY) }, now - 8 * DAY);
      var st2 = addStep(s, 'm1', 'A-003', { text: 'Утвердить правило: артикул производителя — ключ позиции', assigneeId: 'm1', due: iso(now - 2 * DAY) }, now - 8 * DAY);
      addStep(s, 'm1', 'A-003', { text: 'Обновить справочник в 1С и проверить 3 спецификации', assigneeId: 'u1', due: iso(now + 5 * DAY) }, now - 8 * DAY);
      setStep(s, 'u2', 'A-003', st1.id, { state: 'done' }, now - 6.5 * DAY);
      setStep(s, 'm1', 'A-003', st2.id, { state: 'doing' }, now - 4 * DAY);
    }
    var a9 = byId(s.tickets, 'A-009');
    if (a9 && a9.options[0]) {
      chooseOption(s, 'm9', 'A-009', a9.options[0].id, 'Простое разграничение ролей, внедряется за неделю', now - 6 * DAY);
      var s9 = addStep(s, 'm9', 'A-009', { text: 'Описать роли: кто готовит, проверяет, утверждает приложение', assigneeId: 'm9', due: iso(now + 2 * DAY) }, now - 6 * DAY);
      setStep(s, 'm9', 'A-009', s9.id, { state: 'doing' }, now - 3 * DAY);
      addStep(s, 'm9', 'A-009', { text: 'Добавить этапы согласования в карточку договора в Битрикс24', assigneeId: 'u4', due: iso(now + 6 * DAY) }, now - 6 * DAY);
    }
    var a15 = byId(s.tickets, 'A-015');
    if (a15 && a15.options[0]) chooseOption(s, 'm2', 'A-015', a15.options[0].id, 'Шаблон закрывает большинство случаев', now - 3 * DAY);
    var a4 = byId(s.tickets, 'A-004'); if (a4) verifyEffect(s, 'm4', 'A-004', { ok: true, after: '6 вопросов в неделю (было 14)' }, now - 3 * DAY);
    var a8 = byId(s.tickets, 'A-008'); if (a8 && a8.verify) a8.verify.dueAt = iso(now - DAY);
    s.users.forEach(function (u) { if (u.role !== 'owner') s.ledger.push({ id: nextId(s, 'ledger', 'p'), userId: u.id, ticketId: null, kind: 'welcome', amount: 10, label: 'Стартовый бонус: добро пожаловать в «Сигнал»', at: iso(now - 40 * DAY) }); });
    bonus(s, 'o1', 'u3', 100, 'За памятку для новичков (A-008) — срок адаптации сократился с 15 до 9 дней', now - 2 * DAY);
    redeem(s, 'u3', 'gym', now - 0.4 * DAY); redeem(s, 'u1', 'merch', now - 0.2 * DAY);
    seedEntries(s, now);
    if (triage) {
      s.settings.ownerTriage = true;
      s.tickets.forEach(function (t) {
        if (t.status === 'new') { t.suggestAssigneeId = t.assigneeId; t.assigneeId = null; }
        if (t.status === 'done' && t.verify && t.verify.result === 'confirmed') t.status = 'closed';
      });
      [['A-001', 3], ['A-011', 6], ['A-016', 9]].forEach(function (x) {
        var t = byId(s.tickets, x[0]); if (!t || t.status !== 'new') return;
        accept(s, 'o1', t.id, { due: iso(now + x[1] * DAY), collectUntil: iso(now + 12 * HOUR), voteUntil: iso(now + DAY) }, Math.min(now - HOUR, ts(t.createdAt) + 5 * HOUR));
      });
      var pub = function (code, text, name, phone, d) { return createPublicTicket(s, code, { text: text, contactName: name, contactPhone: phone }, now - d * DAY); };
      pub('object-demo', 'На объекте после монтажа не работает считыватель на втором входе. Монтажники уехали, акт уже подписан. Кому звонить и когда приедут?', 'Ерлан, инженер заказчика', '+7 700 000-00-00', 0.4);
      pub('office', 'У входа в офис не работает домофон: курьеры и гости не могут дозвониться до ресепшена и уходят.', '', '', 0.2);
      pub('site', 'Здравствуйте! Предлагаем продвижение вашего сайта в топ-10 поисковой выдачи за 30 дней. Скидка 50% до конца недели!', '', '', 0.1);
      var sp = pub('social', 'Продам гараж в хорошем состоянии, торг уместен. Пишите в личные сообщения.', '', '', 3);
      toTrash(s, 'o1', sp.id, 'Не по теме', now - 2.9 * DAY);
    }
    s.notifications.forEach(function (n) { n.read = true; n.delivered = true; });
    return s;
  }


  /* ───────────────────────── Вход по ссылке и QR, фильтр собственника, доска ───────────────────────── */

  var BOARD = [
    { key: 'todo',   label: 'К выполнению', statuses: ['review', 'clarify'], hint: 'Принято собственником, есть ответственный и срок' },
    { key: 'doing',  label: 'В работе',     statuses: ['work'],              hint: 'Идут шаги по чек-листу' },
    { key: 'check',  label: 'На проверке',  statuses: ['done'],              hint: 'Результат записан, ждёт подтверждения' },
    { key: 'solved', label: 'Решено',       statuses: ['closed'],            hint: 'Результат подтверждён' }
  ];
  var ENTRY_KINDS = { site: 'Сайт', social: 'Соцсети', object: 'Объект', office: 'Офис' };
  var TRASH_REASONS = ['Не по теме', 'Спам', 'Дубль'];
  function boardOf(t) { if (t.status === 'clarify' && t.clarifyFrom === 'work') return 'doing'; for (var i = 0; i < BOARD.length; i++) if (BOARD[i].statuses.indexOf(t.status) >= 0) return BOARD[i].key; return null; }
  function boardStatuses() {
    var o = clone(STATUSES);
    o.new.label = 'Входящее'; o.review.label = 'К выполнению'; o.clarify.label = 'Ждём ответа автора'; o.done.label = 'На проверке'; o.closed.label = 'Решено';
    o.done.tone = 'amber'; o.clarify.tone = 'navy';
    return o;
  }
  function suggestAssignee(state, t) { return t.categoryId ? route(state, t.categoryId, t.type).assigneeId : state.settings.fallbackUser; }
  // Следующий шаг и кто его делает — показывается в каждой карточке
  function nextOf(state, t) {
    var name = function (id) { return (user(state, id) || {}).name || ''; };
    var own = triagers(state)[0], ownName = own ? own.name : 'Собственник';
    if (t.status === 'trash') return { text: 'В корзине: ' + (t.trashReason || 'не по теме'), who: '' };
    if (t.status === 'rejected') return { text: 'Отклонено с причиной', who: '' };
    if (t.status === 'closed') return { text: 'Решено', who: '' };
    if (t.status === 'new') return triageOn(state) ? { text: 'Решить: «В работу» или «В корзину»', who: ownName } : { text: 'Дать первый ответ', who: name(t.assigneeId) };
    if (t.team && t.team.phase === 'setup') return { text: 'Назначить сроки предложений и голосования', who: name(t.assigneeId) };
    if (t.team && t.team.phase === 'collect') return { text: 'Предложить решение', who: 'Вся команда' };
    if (t.team && t.team.phase === 'vote') return { text: teamVotingEnded(state, t) && teamLeaders(state, t).length > 1 ? 'Выбрать из лидеров голосования' : 'Проголосовать за лучшее решение', who: teamVotingEnded(state, t) && teamLeaders(state, t).length > 1 ? name(t.assigneeId) : 'Вся команда' };
    if (t.status === 'clarify') return { text: 'Ответить на вопрос', who: t.anonymous ? 'Автор' : (name(t.authorId) || 'Автор') };
    if (t.status === 'review') return { text: 'Взять в работу', who: name(t.assigneeId) };
    if (t.status === 'done') return triageOn(state) ? { text: 'Подтвердить результат', who: ownName } : { text: 'Проверить эффект', who: name(t.assigneeId) };
    var st = (t.plan || []).filter(function (x) { return x.state !== 'done'; })[0];
    if (st) return { text: st.text, who: name(st.assigneeId) };
    return { text: (t.plan || []).length ? 'Записать результат' : 'Составить шаги и записать результат', who: name(t.executorId || t.assigneeId) };
  }
  function randomCode(n) {
    var abc = 'abcdefghjkmnpqrstuvwxyz23456789', out = '', buf = null;
    try { if (typeof crypto !== 'undefined' && crypto.getRandomValues) { buf = new Uint8Array(n); crypto.getRandomValues(buf); } } catch (e) { buf = null; }
    for (var i = 0; i < n; i++) out += abc[(buf ? buf[i] : Math.floor(Math.random() * 256)) % abc.length];
    return out;
  }
  // Уведомление собственнику о новом обращении: бот добавляет к нему кнопки «В работу» / «В корзину»
  function notifyTriage(state, userId, t, text, at) {
    if (!userId) return;
    state.notifications.push({ id: nextId(state, 'notif', 'n'), userId: userId, ticketId: t.id, text: text, at: at, read: false, delivered: false, kind: 'triage' });
  }

  function entryView(state, e) {
    var n = 0, open = 0; state.tickets.forEach(function (t) { if (t.entryId === e.id) { n++; if (t.status === 'new') open++; } });
    return { id: e.id, code: e.code, name: e.name, kind: e.kind, kindLabel: ENTRY_KINDS[e.kind] || '', active: e.active, createdAt: e.createdAt, total: n, waiting: open };
  }
  function listEntries(state, actorId) {
    var u = user(state, actorId); if (!isAdmin(u)) throw err('forbidden', 'Точки входа настраивает администратор или собственник');
    return (state.entries || []).map(function (e) { return entryView(state, e); });
  }
  function saveEntry(state, actorId, id, patch, now) {
    var u = user(state, actorId); if (!isAdmin(u)) throw err('forbidden', 'Точки входа настраивает администратор или собственник');
    state.entries = state.entries || [];
    var e = id ? byId(state.entries, id) : null;
    if (id && !e) throw err('not_found', 'Точка входа не найдена');
    if (!e) {
      var name = trim(patch.name); if (name.length < 2) throw err('validation', 'Назовите точку входа: например «Объект: ЖК Северный»');
      e = { id: nextId(state, 'entry', 'en'), code: randomCode(10), name: name.slice(0, 80), kind: ENTRY_KINDS[patch.kind] ? patch.kind : 'object', active: true, createdAt: iso(now || Date.now()) };
      state.entries.push(e);
      return entryView(state, e);
    }
    if (patch.name != null) { var nm = trim(patch.name); if (nm.length < 2) throw err('validation', 'Название слишком короткое'); e.name = nm.slice(0, 80); }
    if (patch.kind != null && ENTRY_KINDS[patch.kind]) e.kind = patch.kind;
    if (patch.active != null) e.active = !!patch.active;
    return entryView(state, e);
  }
  function entryByCode(state, code) {
    code = trim(code).toLowerCase();
    var list = state.entries || [];
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }
  function publicEntry(state, code) {
    var e = entryByCode(state, code);
    if (!e) throw err('not_found', 'Ссылка не найдена. Проверьте адрес или отсканируйте QR-код ещё раз');
    return { code: e.code, name: e.name, kind: e.kind, kindLabel: ENTRY_KINDS[e.kind] || '', active: !!e.active, company: 'ГК «Модус Трейд»' };
  }
  // Обращение без входа в систему: три поля, автор — внешний человек
  function createPublicTicket(state, code, data, now) {
    data = data || {};
    if (!triageOn(state)) throw err('forbidden', 'Приём обращений по ссылке отключён');
    var e = entryByCode(state, code);
    if (!e) throw err('not_found', 'Ссылка не найдена');
    if (!e.active) throw err('forbidden', 'Эта ссылка больше не принимает обращения');
    var cname = trim(data.contactName).slice(0, 80), cphone = trim(data.contactPhone).slice(0, 40);
    if (cphone && !/^[+0-9()\-\s]{5,40}$/.test(cphone)) throw err('validation', 'Проверьте номер телефона');
    var t = createTicket(state, null, {
      _external: true, text: data.text, attachments: data.attachments, entryId: e.id, entryName: e.name,
      contact: (cname || cphone) ? { name: cname, phone: cphone } : null
    }, now);
    return { id: t.id, trackCode: t.trackCode, entryName: e.name };
  }
  // Страница статуса для внешнего автора: только его обращение и только итог
  function trackTicket(state, trackCode) {
    trackCode = trim(trackCode);
    var t = null;
    if (trackCode.length >= 16) state.tickets.forEach(function (x) { if (x.trackCode && x.trackCode === trackCode) t = x; });
    if (!t) throw err('not_found', 'Обращение не найдено. Проверьте ссылку');
    var S = {
      new: ['wait', 'На рассмотрении', 'Обращение получено. Мы сообщим здесь, принято ли оно в работу.'],
      trash: ['declined', 'Не принято', 'Обращение не относится к работе компании.'],
      rejected: ['declined', 'Не принято', ''],
      review: ['accepted', 'Принято в работу', 'Назначен ответственный и срок.'],
      clarify: ['accepted', 'Принято в работу', 'Мы уточняем детали.'],
      work: ['work', 'В работе', 'Над решением работают.'],
      done: ['check', 'Сделано, идёт проверка', ''],
      closed: ['solved', 'Решено', '']
    }[t.status] || ['wait', 'На рассмотрении', ''];
    var e = t.entryId ? byId(state.entries || [], t.entryId) : null;
    return {
      id: t.id, createdAt: t.createdAt, text: t.text.slice(0, 400), state: S[0], label: S[1], note: S[2],
      entryName: e ? e.name : '', due: boardOf(t) && t.status !== 'closed' ? t.resolveDue : null,
      result: (t.status === 'done' || t.status === 'closed') ? t.result : '', reason: t.status === 'rejected' ? t.rejectReason : '',
      steps: ['Получено', 'Принято в работу', 'В работе', 'Решено'], step: { wait: 0, declined: 0, accepted: 1, work: 2, check: 2, solved: 3 }[S[0]]
    };
  }

  // «В работу»: собственник назначает ответственного и срок, карточка появляется на доске
  function accept(state, actorId, id, data, now) {
    data = data || {};
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!t) throw err('not_found', 'Обращение не найдено');
    if (!triageOn(state)) throw err('validation', 'Фильтр собственника отключён');
    if (!isTriager(state, u)) throw err('forbidden', 'Принять обращение в работу может только собственник или его заместитель');
    if (t.status !== 'new') throw err('validation', 'Обращение уже разобрано');
    var c = data.categoryId ? byId(state.categories, data.categoryId) : null;
    if (data.categoryId && !c) throw err('validation', 'Категория не найдена');
    var target = user(state, data.assigneeId || (c ? route(state, c.id, t.type).assigneeId : suggestAssignee(state, t)));
    if (!teamActive(target)) throw err('validation', 'Выберите активного сотрудника, который будет ответственным');
    if (target.absent) throw err('validation', target.name + ' сейчас отсутствует — выберите другого ответственного');
    var at = iso(now || Date.now()), pr = PRIORITIES[data.priority] ? data.priority : t.priority;
    // Calendar-only API clients retain UTC end-of-day; the UI supplies the exact
    // instant for the end of the selected day in the user's time zone.
    var dueTs = data.due ? ts(data.due) + (/^\d{4}-\d{2}-\d{2}$/.test(data.due) ? DAY - 1000 : 0) : 0;
    if (data.due && (!dueTs || isNaN(dueTs) || dueTs < ts(at))) throw err('validation', 'Срок должен быть сегодня или позже');
    if (!dueTs) dueTs = ts(at) + (+data.dueDays > 0 ? Math.min(365, +data.dueDays) : PRIORITIES[pr].resolveD) * DAY;
    var schedule = t.type !== 'praise' ? teamDeadlines(data, now, iso(dueTs)) : null;
    if (c) { t.categoryId = c.id; if (!t.paei) t.paei = CAT_PAEI[c.id] || null; }
    t.priority = pr; t.assigneeId = target.id; t.suggestAssigneeId = null;
    transition(state, actorId, id, 'review', { accepted: true, comment: 'Принято в работу. Ответственный: ' + target.name + ', срок: ' + fmtShort(iso(dueTs)) }, now);
    t.resolveDue = iso(dueTs); t.acceptedAt = at; t.acceptedBy = u.id; t.esc_resolve = null; t.esc_response = null;
    addEvent(state, t, null, 'assigned', { text: 'Назначен ответственный: ' + target.name, to: target.id }, at);
    if (target.id !== u.id) notify(state, target.id, t, '📌 Вам назначено ' + t.id + ' «' + t.title + '». Срок: ' + fmtShort(t.resolveDue), at);
    startTeam(state, t, now, false, schedule); progressTeam(state, t, now);
    return t;
  }
  function toTrash(state, actorId, id, reason, now) {
    var u = user(state, actorId);
    if (!isTriager(state, u)) throw err('forbidden', 'Отправить в корзину может только собственник или его заместитель');
    return transition(state, actorId, id, 'trash', { comment: trim(reason).slice(0, 200) || TRASH_REASONS[0] }, now);
  }
  function restore(state, actorId, id, now) {
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!isTriager(state, u)) throw err('forbidden', 'Вернуть из корзины может только собственник или его заместитель');
    if (!t || t.status !== 'trash') throw err('validation', 'Обращения нет в корзине');
    return transition(state, actorId, id, 'new', { comment: 'Возвращено из корзины' }, now);
  }
  // Перенос карточки по доске: проверяет те же правила, что и кнопки в карточке
  function moveCard(state, actorId, id, col, opts, now) {
    opts = opts || {};
    var u = user(state, actorId), t = byId(state.tickets, id);
    if (!t || !canSee(state, u, t)) throw err('not_found', 'Обращение не найдено');
    var from = boardOf(t);
    if (!from) throw err('validation', 'Этой карточки нет на доске');
    if (from === col) return t;
    if (col === 'todo') return transition(state, actorId, id, 'review', { comment: trim(opts.comment) || 'Возвращено в «К выполнению»' }, now);
    if (col === 'doing') {
      if (from === 'check') return verifyEffect(state, actorId, id, { ok: false, note: trim(opts.comment) }, now);
      if (from === 'solved') { transition(state, actorId, id, 'review', { comment: trim(opts.comment) || 'Открыто заново' }, now); }
      return transition(state, actorId, id, 'work', { comment: trim(opts.comment) }, now);
    }
    if (col === 'check') {
      if (from === 'solved') throw err('validation', 'Решённую карточку сначала верните в работу');
      if (trim(opts.result).length < 5) throw err('validation', 'Запишите результат: что сделано');
      return transition(state, actorId, id, 'done', { result: opts.result, impact: opts.impact }, now);
    }
    if (col === 'solved') {
      if (from !== 'check') throw err('validation', 'В «Решено» карточка попадает только из «На проверке»');
      return verifyEffect(state, actorId, id, { ok: true, after: opts.after }, now);
    }
    throw err('validation', 'Неизвестная колонка');
  }
  // Приведение старых данных к текущей схеме
  function ensureDefaults(state) {
    state.entries = state.entries || [];
    var d = emptyState().settings, st = state.settings = state.settings || {};
    Object.keys(d).forEach(function (k) { if (st[k] == null) st[k] = d[k]; });
    if (!state.entries.length) seedEntries(state, Date.now());
    if (triageOn(state)) state.tickets.forEach(function (t) {
      if (!t.team && t.status === 'review' && !t.decision && !t.result && !(t.plan || []).length && !state.events.some(function (e) { return e.ticketId === t.id && e.kind === 'status' && (e.to === 'work' || e.to === 'done'); })) startTeam(state, t, Date.now(), true);
    });
    return state;
  }
  function seedEntries(state, now) {
    var E = [['site', 'site', 'Сайт modus-trade.ru'], ['social', 'social', 'Соцсети'], ['object', 'object-demo', 'Объект (пример)'], ['office', 'office', 'Офис, вход']];
    state.entries = state.entries || [];
    E.forEach(function (x) { state.entries.push({ id: nextId(state, 'entry', 'en'), code: x[1], name: x[2], kind: x[0], active: true, createdAt: iso(now - 20 * DAY) }); });
  }

  /* ───────────────────────── QR-код (байтовый режим, уровень коррекции M, версии 1–10) ───────────────────────── */
  var QR_ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26], QR_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  function qrRaw(ver) { var r = (16 * ver + 128) * ver + 64; if (ver >= 2) { var na = Math.floor(ver / 7) + 2; r -= (25 * na - 10) * na - 55; if (ver >= 7) r -= 36; } return r; }
  function qrMul(x, y) { var z = 0; for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; }
  function qrDivisor(deg) { var res = [], i, j; for (i = 0; i < deg - 1; i++) res.push(0); res.push(1); var root = 1; for (i = 0; i < deg; i++) { for (j = 0; j < res.length; j++) { res[j] = qrMul(res[j], root); if (j + 1 < res.length) res[j] ^= res[j + 1]; } root = qrMul(root, 2); } return res; }
  function qrRemainder(data, div) { var res = div.map(function () { return 0; }); data.forEach(function (b) { var f = b ^ res.shift(); res.push(0); div.forEach(function (c, i) { res[i] ^= qrMul(c, f); }); }); return res; }
  function utf8(str) { var out = [], s = unescape(encodeURIComponent(String(str))); for (var i = 0; i < s.length; i++) out.push(s.charCodeAt(i)); return out; }
  function qrMatrix(text) {
    var bytes = utf8(text), ver = 0, v, i, j, x, y;
    for (v = 1; v <= 10; v++) { var cap = (Math.floor(qrRaw(v) / 8) - QR_ECC[v] * QR_BLOCKS[v]) * 8; if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= cap) { ver = v; break; } }
    if (!ver) throw err('validation', 'Ссылка слишком длинная для QR-кода');
    var size = ver * 4 + 17, rawCw = Math.floor(qrRaw(ver) / 8), nb = QR_BLOCKS[ver], ecl = QR_ECC[ver], dataCw = rawCw - ecl * nb;
    var bits = [], push = function (val, len) { for (var k = len - 1; k >= 0; k--) bits.push((val >>> k) & 1); };
    push(4, 4); push(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(function (b) { push(b, 8); });
    push(0, Math.min(4, dataCw * 8 - bits.length)); push(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < dataCw * 8; pad ^= 0xEC ^ 0x11) push(pad, 8);
    var cw = []; for (i = 0; i < bits.length; i += 8) { var b8 = 0; for (j = 0; j < 8; j++) b8 = (b8 << 1) | bits[i + j]; cw.push(b8); }
    var nShort = nb - rawCw % nb, shortLen = Math.floor(rawCw / nb), blocks = [], div = qrDivisor(ecl), k = 0;
    for (i = 0; i < nb; i++) { var dl = shortLen - ecl + (i < nShort ? 0 : 1), dat = cw.slice(k, k + dl); k += dl; var ecc = qrRemainder(dat, div); if (i < nShort) dat = dat.concat([0]); blocks.push(dat.concat(ecc)); }
    var all = [];
    for (i = 0; i < blocks[0].length; i++) blocks.forEach(function (bl, bi) { if (i !== shortLen - ecl || bi >= nShort) all.push(bl[i]); });
    var M = [], F = [];
    for (y = 0; y < size; y++) { M.push([]); F.push([]); for (x = 0; x < size; x++) { M[y].push(false); F[y].push(false); } }
    var setF = function (px, py, dark) { if (px < 0 || py < 0 || px >= size || py >= size) return; M[py][px] = !!dark; F[py][px] = true; };
    for (i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) { for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) { var d = Math.max(Math.abs(dx), Math.abs(dy)); setF(c[0] + dx, c[1] + dy, d !== 2 && d !== 4); } });
    var al = [];
    if (ver > 1) { var na = Math.floor(ver / 7) + 2, stp = Math.ceil((ver * 4 + 4) / (na * 2 - 2)) * 2; al = [6]; for (var pos = size - 7; al.length < na; pos -= stp) al.splice(1, 0, pos); }
    al.forEach(function (ay, ai) { al.forEach(function (ax, aj) { if ((ai === 0 && aj === 0) || (ai === 0 && aj === al.length - 1) || (ai === al.length - 1 && aj === 0)) return; for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) setF(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }); });
    var drawFormat = function (mask) {
      var data = mask, rem = data, n; for (n = 0; n < 10; n++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var fb = ((data << 10) | rem) ^ 0x5412, bit = function (q) { return ((fb >>> q) & 1) !== 0; };
      for (n = 0; n <= 5; n++) setF(8, n, bit(n));
      setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
      for (n = 9; n < 15; n++) setF(14 - n, 8, bit(n));
      for (n = 0; n < 8; n++) setF(size - 1 - n, 8, bit(n));
      for (n = 8; n < 15; n++) setF(8, size - 15 + n, bit(n));
      setF(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) { var vr = ver; for (i = 0; i < 12; i++) vr = (vr << 1) ^ ((vr >>> 11) * 0x1F25); var vb = (ver << 12) | vr; for (i = 0; i < 18; i++) { var on = ((vb >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3); setF(a, b, on); setF(b, a, on); } }
    var bi2 = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) for (j = 0; j < 2; j++) {
        x = right - j; var up = ((right + 1) & 2) === 0; y = up ? size - 1 - vert : vert;
        if (!F[y][x] && bi2 < all.length * 8) { M[y][x] = ((all[bi2 >>> 3] >>> (7 - (bi2 & 7))) & 1) !== 0; bi2++; }
      }
    }
    var maskFn = [
      function (mx, my) { return (mx + my) % 2 === 0; }, function (mx, my) { return my % 2 === 0; }, function (mx, my) { return mx % 3 === 0; },
      function (mx, my) { return (mx + my) % 3 === 0; }, function (mx, my) { return (Math.floor(mx / 3) + Math.floor(my / 2)) % 2 === 0; },
      function (mx, my) { return mx * my % 2 + mx * my % 3 === 0; }, function (mx, my) { return (mx * my % 2 + mx * my % 3) % 2 === 0; },
      function (mx, my) { return ((mx + my) % 2 + mx * my % 3) % 2 === 0; }
    ];
    var applyMask = function (m) { for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) if (!F[yy][xx] && maskFn[m](xx, yy)) M[yy][xx] = !M[yy][xx]; };
    var penalty = function () {
      var p = 0, xx, yy, run, col, dark = 0;
      var line = function (get) { var r = 1, prev = get(0), pat = 0, q; for (q = 1; q < size; q++) { var c = get(q); if (c === prev) { r++; if (r === 5) p += 3; else if (r > 5) p++; } else { r = 1; prev = c; } }
        for (q = 0; q + 10 < size; q++) { var w = ''; for (var z = 0; z < 11; z++) w += get(q + z) ? '1' : '0'; if (w === '10111010000' || w === '00001011101') p += 40; } };
      for (yy = 0; yy < size; yy++) line(function (q) { return M[yy][q]; });
      for (xx = 0; xx < size; xx++) line(function (q) { return M[q][xx]; });
      for (yy = 0; yy < size - 1; yy++) for (xx = 0; xx < size - 1; xx++) { col = M[yy][xx]; if (col === M[yy][xx + 1] && col === M[yy + 1][xx] && col === M[yy + 1][xx + 1]) p += 3; }
      for (yy = 0; yy < size; yy++) for (xx = 0; xx < size; xx++) if (M[yy][xx]) dark++;
      p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      return p;
    };
    var best = 0, bestP = Infinity;
    for (i = 0; i < 8; i++) { applyMask(i); drawFormat(i); var pp = penalty(); if (pp < bestP) { bestP = pp; best = i; } applyMask(i); }
    applyMask(best); drawFormat(best);
    return M;
  }
  // SVG для печати: тихая зона 4 модуля, подпись под кодом
  function qrSvg(text, caption, px) {
    var M = qrMatrix(text), n = M.length, q = 4, cell = px || 8, w = (n + q * 2) * cell, capH = caption ? 44 : 0, d = '';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (M[y][x]) d += 'M' + (x + q) * cell + ' ' + (y + q) * cell + 'h' + cell + 'v' + cell + 'h-' + cell + 'z';
    var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + (w + capH) + '" width="' + w + '" height="' + (w + capH) + '"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#082742"/>' +
      (caption ? '<text x="' + w / 2 + '" y="' + (w + 14) + '" text-anchor="middle" font-family="Arial, sans-serif" font-size="' + Math.max(13, cell * 1.9) + '" font-weight="700" fill="#082742">' + esc(caption) + '</text>' : '') + '</svg>';
  }

  return {
    BOARD: BOARD, ENTRY_KINDS: ENTRY_KINDS, TRASH_REASONS: TRASH_REASONS, boardOf: boardOf, triageOn: triageOn, isTriager: isTriager, canSee: canSee,
    listEntries: listEntries, saveEntry: saveEntry, publicEntry: publicEntry, createPublicTicket: createPublicTicket, trackTicket: trackTicket,
    accept: accept, toTrash: toTrash, restore: restore, moveCard: moveCard, ensureDefaults: ensureDefaults, teamPass: teamPass, advanceTeam: advanceTeam, setTeamDeadlines: setTeamDeadlines, qrMatrix: qrMatrix, qrSvg: qrSvg,
    TYPES: TYPES, STATUSES: STATUSES, STATUS_ORDER: STATUS_ORDER, FLOW: FLOW, PRIORITIES: PRIORITIES, ROLES: ROLES,
    POINTS: POINTS, LEVELS: LEVELS, ACHIEVEMENTS: ACHIEVEMENTS, REWARDS: REWARDS,
    emptyState: emptyState, createSeedState: createSeedState,
    createTicket: createTicket, transition: transition, addComment: addComment, assign: assign, setPriority: setPriority,
    vote: vote, markRead: markRead, tick: tick,
    listTickets: listTickets, getTicket: getTicket, profile: profile, leaderboard: leaderboard, analytics: analytics,
    bootstrap: bootstrap, notificationsOf: notificationsOf, findSimilar: function (s, text, ex, viewerId) {
      return findSimilar(s, text, ex, 3, viewerId || '').map(function (x) { return { id: x.ticket.id, title: x.ticket.title, status: x.ticket.status, score: x.score }; });
    },
    route: route, overdueInfo: overdueInfo, canManage: canManage, balance: balance, level: level,
    updateCategory: updateCategory, createUser: createUser, updateUser: updateUser, updateSettings: updateSettings,
    fmtDate: fmtDate, fmtShort: fmtShort,
    claim: claim, bonus: bonus, nudge: nudge, postChat: postChat, listChat: listChat, looksLikeProblem: looksLikeProblem,
    peopleStats: peopleStats, ownerDigest: ownerDigest, digestText: digestText, saveReport: saveReport, ensureDailyReport: ensureDailyReport,
    listReports: listReports, STAGES: STAGES, stageOf: stageOf, proposeOption: proposeOption, voteOption: voteOption, chooseOption: chooseOption, addStep: addStep, setStep: setStep, verifyEffect: verifyEffect, myTasks: myTasks, solutionStats: solutionStats, solutionPrompt: solutionPrompt, similarSolved: similarSolved, QUESTS: QUESTS, LEAGUES: LEAGUES, gameState: gameState, claimQuest: claimQuest, claimStreak: claimStreak, openChest: openChest, setHideRating: setHideRating, setTeamGoal: setTeamGoal, seasonBoard: seasonBoard, heroOfWeek: heroOfWeek, teamGoal: teamGoal, PAEI: PAEI, ZONES: ZONES, QUADRANTS: QUADRANTS, CAT_PAEI: CAT_PAEI, quadrant: quadrant, classify: classify, carnegieCheck: carnegieCheck, carnegieTemplates: carnegieTemplates, kudos: kudos, methodStats: methodStats, redeem: redeem, decideRedemption: decideRedemption, listRedemptions: listRedemptions, updateReward: updateReward, rewardsView: rewardsView, agentPrompt: agentPrompt, cleanFiles: cleanFiles, isStaff: isStaff, isAdmin: isAdmin
  };
});
