# МОДУС · СИГНАЛ — справочник REST API

Базовый адрес: `https://<ваш-домен>/api`. Все запросы и ответы — JSON в UTF-8 (кроме `/api/export.csv`).
Максимальный размер тела запроса — 1 МБ.

## Авторизация

| Режим | Заголовок | Когда |
|---|---|---|
| Демо | `X-Demo-User: <userId>` (например `u1`, `m1`, `a1`) | только при `DEMO=1` |
| Telegram Mini App | `Authorization: tma <initData>` | всегда, если задан `BOT_TOKEN` |

`initData` — строка `Telegram.WebApp.initData` без изменений. Сервер проверяет подпись
(HMAC-SHA256 по документации Telegram) и срок давности (не старше 24 ч), затем ищет сотрудника
с `tgId`, равным `user.id`. Если заголовок `Authorization` присутствует, он имеет приоритет над `X-Demo-User`.

Демо-пользователи: сотрудники `u1`…`u8`, ответственные/руководители `m1`…`m15` (`m3` — в отпуске), администратор `a1`.

## Формат ошибок

```json
{ "error": "Отказ должен быть мотивированным — укажите причину", "code": "validation" }
```

| HTTP | code | Значение |
|---|---|---|
| 400 | `validation`, `bad_json` | ошибка в данных |
| 401 | `unauthorized`, `unknown_user`, `bad_init_data`, `init_data_expired`, `link_required`, `tg_not_configured` | нет/неверная авторизация |
| 403 | `forbidden`, `bad_link_code` | недостаточно прав |
| 404 | `not_found` | объект или метод не найден |
| 413 | `payload_too_large` | тело больше 1 МБ |
| 500 | `internal` | внутренняя ошибка сервера |

`link_required` — подпись Telegram верна, но аккаунт не привязан: клиент должен показать экран привязки (`POST /api/tg/link`).

---

## Служебные

### `GET /api/health` — без авторизации
```json
{ "ok": true, "mode": "server", "version": "1.0.0", "bot": true }
```
`bot` — запущен ли Telegram-бот.

### `GET /api/bootstrap`
Текущий пользователь и справочники для интерфейса.
```json
{
  "me": { "id": "m1", "name": "Руководитель закупок", "role": "manager", "dept": "Закупки" },
  "users": [{ "id": "u1", "name": "Сотрудник закупок", "role": "employee", "dept": "Закупки", "absent": false, "absentNote": "" }],
  "categories": [{ "id": "c01", "name": "Межотдельное взаимодействие", "owner": "m1", "backup": "m2" }],
  "departments": ["Закупки", "Проектирование"],
  "rewards": [{ "id": "merch", "name": "Мерч «Модус Трейд»", "cost": 40, "desc": "Худи, термокружка или рюкзак" }],
  "settings": { "anonymousAllowed": true, "solutionRequiredForIdeas": true, "escalateAfterFactor": 2, "fallbackUser": "a1" },
  "dict": { "TYPES": {}, "STATUSES": {}, "STATUS_ORDER": [], "FLOW": {}, "PRIORITIES": {}, "ROLES": {}, "POINTS": {}, "LEVELS": [] },
  "auth": "demo",
  "demo": true
}
```

---

## Обращения

### `GET /api/tickets`
Параметры запроса (все необязательные):

| Параметр | Значения |
|---|---|
| `scope` | `mine` — мои, `assigned` — назначенные мне, `manage` — в моей зоне ответственности |
| `status` | `new`, `review`, `clarify`, `work`, `done`, `rejected`, `closed`, `open` (все открытые), `all` |
| `type` | `problem`, `idea`, `praise` |
| `categoryId` | `c01`…`c18` |
| `dept` | подразделение (анонимные обращения не попадают в фильтр) |
| `priority` | `low`, `medium`, `high` |
| `overdue` | `1` — только просроченные |
| `q` | поиск по номеру, заголовку, тексту, решению |
| `sort` | `updated` (по умолчанию), `created`, `due`, `votes` |
| `from`, `to` | даты создания `YYYY-MM-DD` |

Пример: `GET /api/tickets?dept=Бухгалтерия&categoryId=c07&status=new&overdue=1`
```json
[{
  "id": "A-007", "type": "problem", "categoryId": "c07", "categoryName": "Интеграции и IT",
  "title": "Повторный ввод одних и тех же сведений в разных системах",
  "text": "…", "solution": "…", "status": "new", "priority": "high",
  "authorId": "u3", "authorName": "Сотрудник бухгалтерии", "authorDept": "Бухгалтерия",
  "assigneeId": "m7", "assigneeName": "IT-специалист",
  "createdAt": "2026-11-08T02:00:00.000Z", "respondDue": "2026-11-09T02:00:00.000Z",
  "overdue": { "kind": "response", "hours": 48, "label": "Нет первого ответа" },
  "votesCount": 3, "voted": false, "mine": false, "canManage": true, "escalated": true
}]
```
Для анонимных обращений `authorId: null`, `authorName: "Анонимно"`, `authorDept: "—"` — для всех, кроме самого автора.

### `POST /api/tickets` → 201
```json
{
  "type": "problem",
  "categoryId": "c03",
  "title": "Дубли карточек в каталоге",
  "text": "В каталоге два артикула одной камеры, путаемся при подборе.",
  "solution": "Объединить карточки и закрепить владельца справочника",
  "effect": "Минус 20 минут на проверку спецификации",
  "priority": "medium",
  "anonymous": false,
  "attachments": [{ "name": "скриншот.png", "size": 48213 }]
}
```
Обязательны `type`, `categoryId`, `text` (≥ 15 символов); для `idea` — `solution` (≥ 10 символов).
`title` формируется из первой фразы, если не задан. Вложения — только метаданные (до 5 шт.).
Источник (`source`) проставляет сервер: `tma` для Mini App, `web` для браузера, `bot` для бота.
Ответ — полная карточка (как `GET /api/tickets/:id`). Ответственный назначается автоматически:
владелец категории → замещающий (если владелец отсутствует) → администратор.

### `GET /api/tickets/:id`
Карточка с историей `events` (внутренние заметки видны только руководителям) и `similar` — похожими обращениями.
```json
{
  "id": "A-021", "status": "new", "assigneeId": "m1", "assigneeName": "Руководитель закупок",
  "events": [
    { "id": "e63", "kind": "created", "userId": "u2", "userName": "Сотрудник проектирования", "text": "Обращение зарегистрировано", "at": "…" },
    { "id": "e64", "kind": "assigned", "userId": null, "userName": "Система", "text": "Назначен ответственный: Руководитель закупок (замещение: Ответственный за номенклатуру — В отпуске)", "to": "m1", "at": "…" }
  ],
  "similar": [{ "id": "A-003", "title": "Разные обозначения одного изделия в спецификациях", "status": "work", "score": 0.18 }]
}
```

### `POST /api/tickets/:id/transition`
Смена статуса (ответственный по категории, назначенный, администратор).
```json
{ "to": "rejected", "rejectReason": "Шаблон заявки меняется централизованно в III квартале" }
```
```json
{ "to": "done", "result": "Введено правило проверки номенклатуры",
  "impact": { "metric": "Время проверки спецификации, мин", "before": "40", "after": "15" } }
```
Поля: `to`, `comment`, `result`, `rejectReason`, `impact`. Правила:
- допустимые переходы — `dict.FLOW` из `/api/bootstrap`;
- `rejected` — причина ≥ 10 символов, иначе 400;
- `clarify` — `comment` ≥ 5 символов (что уточнить);
- `done`/`closed` — итог ≥ 5 символов (кроме отзывов).
Ответ — обновлённая карточка. Сотрудник получает 403.

### `POST /api/tickets/:id/comments`
```json
{ "text": "Приложите пример заявки, пожалуйста", "internal": false, "clarify": true }
```
`clarify: true` — переводит обращение в «Ожидает уточнения». `internal: true` — заметка, видимая только руководителям.
Ответ автора на уточнение автоматически возвращает обращение в «На рассмотрении».

### `POST /api/tickets/:id/assign`
```json
{ "userId": "m2" }
```
Переназначение на руководителя/ответственного (не отсутствующего).

### `POST /api/tickets/:id/priority`
```json
{ "priority": "high" }
```
Пересчитывает сроки SLA (high: ответ 24 ч / решение 5 дн; medium: 48 ч / 10 дн; low: 72 ч / 20 дн).

### `POST /api/tickets/:id/vote`
Поддержать / снять поддержку (переключатель). Нельзя голосовать за своё обращение (400).

### `GET /api/similar?text=...`
Поиск похожих обращений до отправки (для подсказки «возможно, об этом уже сообщили»).
```json
[{ "id": "A-007", "title": "Повторный ввод одних и тех же сведений в разных системах", "status": "new", "score": 0.33 }]
```

---

## Аналитика и вовлечённость

### `GET /api/analytics` — руководители и администратор (иначе 403)
```json
{
  "total": 20,
  "byType": { "problem": 10, "idea": 9, "praise": 1 },
  "byStatus": { "new": 5, "review": 7, "clarify": 2, "work": 3, "done": 2, "rejected": 1, "closed": 1 },
  "closedShare": 20, "resultShare": 20, "reviewedShare": 75,
  "avgFirstResponseH": 17.4,
  "implemented": 2,
  "overdue": ["A-007", "A-011", "A-015"],
  "categories": [{ "name": "Обучение", "total": 2, "open": 1, "done": 1, "votes": 0 }],
  "byDept": { "Закупки": 4 },
  "managers": [{ "userId": "m2", "name": "Руководитель направления", "total": 3, "open": 3, "overdue": 2, "avgResponseH": 20, "implemented": 0, "conversion": 0 }],
  "clusters": [{ "lead": "A-011", "title": "…", "ids": ["A-011"], "votes": 4, "weight": 4 }],
  "weeks": [{ "label": "16 сен", "created": 1, "closed": 0 }],
  "participation": 88
}
```

### `GET /api/leaderboard`
```json
[{ "userId": "u3", "name": "Сотрудник бухгалтерии", "dept": "Бухгалтерия", "role": "employee", "points": 55, "level": "Сигнальщик", "implemented": 1, "accepted": 1, "submitted": 3 }]
```

### `GET /api/profile`, `GET /api/profile/:userId`
Баланс баллов, уровень, достижения, история начислений и обменов.
```json
{
  "user": { "id": "u3", "name": "Сотрудник бухгалтерии" },
  "balance": { "earned": 55, "spent": 0, "coins": 55 },
  "level": { "name": "Сигнальщик", "min": 20, "next": { "min": 60, "name": "Соавтор улучшений" }, "progress": 0.875 },
  "achievements": [{ "id": "first", "name": "Первый сигнал", "earned": true }],
  "ledger": [{ "kind": "implemented", "amount": 30, "label": "Улучшение внедрено", "ticketId": "A-008" }],
  "redemptions": [],
  "stats": { "submitted": 3, "implemented": 1, "inWork": 0, "withSolution": 3 },
  "unread": 2
}
```

### `POST /api/rewards/:id/redeem` → 201
Обмен баллов на награду (`course`, `dayoff`, `merch`, `cert`, `lunch`).
```json
{ "redemption": { "id": "r1", "rewardId": "merch", "name": "Мерч «Модус Трейд»", "cost": 40, "status": "Заявка передана в HR" },
  "balance": { "earned": 55, "spent": 40, "coins": 15 } }
```
Недостаточно баллов — 400 «Недостаточно баллов: нужно 200, доступно 55».

---

## Уведомления

### `GET /api/notifications`
Последние 60 уведомлений, новые сверху.
```json
[{ "id": "n70", "userId": "u1", "ticketId": "A-021", "text": "Ваше обращение A-021 взято на рассмотрение", "at": "…", "read": false, "delivered": true }]
```

### `POST /api/notifications/read`
```json
{ "ids": ["n70", "n71"] }
```
Без `ids` — отметить прочитанными все. Ответ: `{ "ok": true, "unread": 0 }`.

---

## Администрирование

### `POST /api/admin/categories` → 201 (администратор)
```json
{ "name": "Склад и логистика", "owner": "m1", "backup": "m2" }
```

### `PUT /api/admin/categories/:id` (администратор)
```json
{ "owner": "m10", "backup": "m2" }
```

### `PUT /api/admin/users/:id`
Администратор — любой пользователь; сотрудник — только себя (присутствие).
```json
{ "absent": true, "absentNote": "В отпуске до 25 ноября" }
```
Администратор может также менять `role` и `tgId`.

### `PUT /api/admin/settings` (администратор)
```json
{ "anonymousAllowed": true, "solutionRequiredForIdeas": false }
```

### `POST /api/admin/reset` (администратор, только `DEMO=1`)
Пересоздаёт демонстрационные данные. Ответ: `{ "ok": true, "tickets": 20 }`.

### `GET /api/export.csv` (руководители и администратор)
CSV для Excel: UTF-8 с BOM, разделитель `;`. Принимает те же фильтры, что `GET /api/tickets`.
```
Номер;Тип;Категория;Автор;Подразделение;Приоритет;Статус;Ответственный;Создано;Первый ответ;Закрыто;Просрочено;Результат/причина отказа;Поддержали
A-007;Проблема;Интеграции и IT;Сотрудник бухгалтерии;Бухгалтерия;Высокий;Новое;IT-специалист;08.11.2026 07:00;;;Да: Нет первого ответа;;3
```

---

## Telegram

### `POST /api/tg/link`
Привязка Telegram-аккаунта к сотруднику. Требует заголовок `Authorization: tma <initData>` с корректной подписью
(пользователь может быть ещё не привязан).
```json
{ "userId": "u4", "code": "7F3K-91QA" }
```
- `DEMO=1` — `code` не нужен (выбор демо-роли);
- `DEMO=0` — `code` должен совпадать с переменной окружения `LINK_CODE_<userId>` (выдаёт администратор).

Ответ: `{ "ok": true, "me": { "id": "u4", "name": "Менеджер по продажам", "tgId": "777001" } }`.
Один Telegram-аккаунт привязывается только к одному сотруднику (прежняя привязка снимается).

## Фоновые процессы

- Проверка SLA — при старте и каждые 10 минут (`core.tick`): просроченные обращения эскалируются замещающему/администратору.
- Рассылка уведомлений в Telegram — каждые 15 секунд (при заданном `BOT_TOKEN`).
- Битрикс24 — при переходе в «В работе» создаётся задача, при «Реализовано»/«Отклонено» — комментарий (при заданном `B24_WEBHOOK`).

---

# Версия 2

Роль `owner` (собственник, демо-пользователь `o1`) входит в число руководителей (`isStaff`) и имеет права
администратора (`isAdmin`): всё, что помечено «администратор», доступно также собственнику.

## Файлы

### `POST /api/files` → 201
Тело запроса — **байты файла** (не multipart). Заголовки:
- `Content-Type` — тип файла;
- `X-File-Name` — имя в `encodeURIComponent` (например `%D0%A4%D0%BE%D1%82%D0%BE.jpg`).

Лимит — 25 МБ (иначе 413 `payload_too_large`). Допустимые типы: `image/*` (кроме SVG), `video/mp4`, `video/webm`,
`video/quicktime`, `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.*`,
`application/vnd.ms-excel`, `text/plain`, `text/csv` (иначе 415 `unsupported_type`).

```js
const r = await fetch('/api/files', { method: 'POST', headers: { ...auth, 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) }, body: file });
```
Ответ:
```json
{ "id": "3f9c…(48 hex)", "name": "Фото.jpg", "type": "image/jpeg", "size": 183244, "kind": "image", "url": "/api/files/3f9c…" }
```
`kind`: `image` | `video` | `doc`. Этот объект целиком передаётся в `attachments` обращения или `files` сообщения чата.

### `GET /api/files/:id` — без авторизации
Идентификатор неугадываемый, поэтому ссылку можно ставить прямо в `<img src>` / `<video src>`.
Изображения, видео и PDF — `Content-Disposition: inline`, остальные документы — `attachment`.
Поддерживается `Range` (ответ 206 / 416) для перемотки видео. Кэш — 1 день.

## Общий чат

### `GET /api/chat?after=<ISO>&limit=200`
Сообщения по возрастанию времени; `after` — только новее указанного момента (для опроса).
```json
[{
  "id": "m10", "userId": "u1", "userName": "Сотрудник закупок", "userRole": "employee", "mine": true,
  "text": "Посмотрите A-007 — опять не работает синхронизация",
  "files": [{ "id": "3f9c…", "name": "Фото.jpg", "size": 183244, "type": "image/jpeg", "kind": "image", "url": "/api/files/3f9c…" }],
  "at": "2026-11-11T05:12:00.000Z", "replyTo": "m3", "ticketId": null,
  "suggestTicket": true,
  "refs": [{ "id": "A-007", "title": "Повторный ввод одних и тех же сведений в разных системах", "status": "new" }]
}]
```
`suggestTicket: true` — сообщение сотрудника похоже на проблему: интерфейс может предложить «Оформить обращение».
`ticketId` — обращение, созданное из этого сообщения.

### `POST /api/chat` → 201
```json
{ "text": "Посмотрите A-007", "files": [ /* объекты из /api/files */ ], "replyTo": "m3" }
```
Ответ — элемент списка (как в `GET /api/chat`). Пустое сообщение — 400.

### Обращение из сообщения чата
`POST /api/tickets` принимает `chatId` — сообщение получает `ticketId`, в истории обращения — «создано из сообщения в общем чате».

## Обращения: новые действия

### `POST /api/tickets/:id/claim`
«Взять в работу». Руководитель/собственник/администратор — становится ответственным и переводит обращение в «В работе»
(из «Новое», «На рассмотрении», «Ожидает уточнения»). Сотрудник — становится исполнителем (`executorId`),
повторный вызов снимает его. Ответ — карточка обращения.

### `POST /api/tickets/:id/nudge`
Напомнить (только руководители): ответственному о сроке или автору — об уточнении. Ответ — карточка.

`GET /api/tickets?sort=priority` — сортировка: приоритет → просрочка → поддержка → давность.

## Магазин мотивации

### `GET /api/rewards`
```json
[{ "id": "lunch", "icon": "🍽", "name": "Обед с собственником", "cost": 120, "stock": 4, "perUser": 1, "desc": "…", "left": 4, "mineLeft": 1 }]
```
`left` — осталось в квартале (null — без лимита), `mineLeft` — осталось мне в квартале.

### `POST /api/rewards/:id/redeem` → 201
Создаёт **заявку на подтверждение** (монеты резервируются сразу, при отказе возвращаются).
```json
{ "redemption": { "id": "r3", "rewardId": "lunch", "name": "Обед с собственником", "icon": "🍽", "cost": 120, "state": "pending", "status": "Ждёт подтверждения", "decidedBy": null, "decidedAt": null, "note": "" },
  "balance": { "earned": 300, "spent": 120, "coins": 180 } }
```
400 — недостаточно монет или исчерпан квартальный лимит.

### `GET /api/owner/redemptions` (собственник, администратор, HR `m14`)
Все заявки, новые сверху, с `userName` и текущим `coins` сотрудника.

### `POST /api/owner/redemptions/:id` (собственник, администратор, HR `m14`)
```json
{ "approve": false, "note": "Лимит на квартал уже распределён" }
```
Отказ требует причину (≥ 5 символов). Ответ — заявка (`state`: `approved` | `rejected`). Сотрудник получает уведомление.

### `POST /api/admin/rewards` → 201, `PUT /api/admin/rewards/:id` (собственник, администратор)
```json
{ "name": "Парковочное место на месяц", "icon": "🚗", "cost": 200, "stock": 2, "perUser": 1, "desc": "…", "active": true }
```

## Собственник и ИИ-агент (собственник и администратор; остальным — 403)

### `GET /api/owner/digest`
Ежедневный разбор: `date`, `health {score, label, tone}`, `kpi`, `hanging` (висящие), `active`, `attention`,
`reward` (к поощрению), `risk` (зона риска), `corrections`, `nextSteps`, `leader`, `pendingRewards`, `clusters`.

### `GET /api/owner/people`
Статистика по каждому сотруднику и руководителю (активность, обращения, SLA, просрочки).

### `POST /api/owner/bonus` → 201
```json
{ "userId": "u5", "amount": 50, "reason": "За демо-стенд для новичков" }
```
5–500 монет. Ответ — запись начисления + `balance` получателя:
```json
{ "id": "p41", "userId": "u5", "ticketId": null, "kind": "bonus", "amount": 50, "label": "Поощрение: За демо-стенд для новичков", "at": "…", "balance": { "earned": 50, "spent": 0, "coins": 50 } }
```

### `GET /api/owner/reports`
Последние 30 отчётов, новые сверху.

### `POST /api/owner/report` → 201
Сформировать отчёт сейчас. С подключённым LLM — `source: "ai"`, иначе — по правилам.
```json
{ "id": "R3", "at": "2026-11-11T04:00:00.000Z", "day": "2026-11-11", "source": "ai", "model": "claude-sonnet-5-5",
  "text": "## Главное за сутки\n…", "health": { "score": 58, "label": "Горит", "tone": "red" }, "kpi": { "total": 20, "open": 14, "overdue": 3 } }
```
Если LLM недоступен — отчёт по правилам и поле `"error": "LLM 529: Overloaded"` (отчёт всё равно сохранён).
`text` от ИИ — Markdown, по правилам — простой текст с переносами строк.

### `POST /api/agent/ask`
```json
{ "question": "Кого поощрить в этом месяце?", "history": [{ "role": "user", "content": "Что висит?" }, { "role": "assistant", "content": "A-007 и A-011…" }] }
```
В LLM уходят последние 6 реплик `history` (только `user`/`assistant`). Ответ:
```json
{ "text": "…", "source": "ai", "model": "claude-sonnet-5-5" }
```
Без LLM: `{ "text": "<отчёт по правилам>\n\nИИ не подключён: задайте LLM_API_KEY — сейчас показан отчёт по правилам", "source": "rules", "model": null }`.
При ошибке LLM: `source: "rules"`, `model: null`, `error`.

### `GET /api/health`
Дополнено: `"llm": { "configured": true, "provider": "anthropic", "model": "claude-sonnet-5-5" }`.

## Ежедневный отчёт
Раз в минуту сервер проверяет: если наступил `REPORT_HOUR` (локальное время по `TZ`) и за текущие сутки отчёта ещё нет —
формирует его (ИИ или правила), уведомляет собственников (колокольчик) и отправляет полный текст собственникам с привязанным Telegram.
Отчёт, созданный вручную через `POST /api/owner/report`, тоже считается отчётом за день.


## Версия 5: вход по ссылке, фильтр собственника, доска

### Публичные адреса — без авторизации

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/public/entry/:code` | Точка входа по коду ссылки: `{code, name, kind, kindLabel, active, company}`; неизвестный код — 404 |
| `POST /api/public/tickets` → 201 | Обращение по ссылке. Тело: `{code, text, attachments?, contactName?, contactPhone?}`. Ответ: `{id, trackCode, entryName}`. Текст короче 10 символов — 400, отключённая ссылка — 403, больше `PUBLIC_PER_HOUR` обращений с адреса в час — 429 (`too_many`). Заполненное скрытое поле `website` означает бота: ответ 201, обращение не создаётся |
| `POST /api/public/files?code=<код>` → 201 | Загрузка вложения без входа; принимается только с действующим кодом точки входа. Формат как у `POST /api/files` |
| `GET /api/public/track/:trackCode` | Статус для внешнего автора: `{id, state, label, note, step, steps, result, due, createdAt, text}`. `state`: `wait`, `declined`, `accepted`, `work`, `check`, `solved`. Контакт автора и сотрудники не раскрываются |

### Фильтр собственника — собственник или заместитель, иначе 403

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/tickets?box=inbox` | Входящие: обращения в статусе `new`, ждут решения |
| `GET /api/tickets?box=trash` | Корзина |
| `POST /api/tickets/:id/accept` | «В работу». Тело: `{assigneeId?, due? (ГГГГ-ММ-ДД), dueDays?, priority?, categoryId?}`. Без `assigneeId` берётся ответственный категории. Статус → `review`, карточка появляется на доске |
| `POST /api/tickets/:id/trash` | «В корзину». Тело: `{reason?}` |
| `POST /api/tickets/:id/restore` | Вернуть из корзины во входящие |

До решения собственника обращение видят только он, заместитель и автор: остальным `GET /api/tickets/:id` отвечает 404. Заместитель задаётся через `PUT /api/admin/settings` `{deputyId}` (только собственник).

### Доска

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/tickets?box=board` | Карточки доски. Дополнительные фильтры: `my=1`, `overdue=1`, `entryId=<id\|app>`, `assigneeId`, `q`. У карточки поля `board` (`todo`, `doing`, `check`, `solved`) и `next` (`{text, who}` — следующий шаг и кто его делает) |
| `POST /api/tickets/:id/move` | Перенос в колонку. Тело: `{col, result?, comment?, after?}`. В `check` нужен `result`; в `solved` — только из `check` и только собственник; из `check` в `doing` — с комментарием, что не так |

`GET /api/bootstrap` дополнительно возвращает `triage`, `canTriage`, `inboxCount`, `board` (колонки), `entries`, `entryKinds`.

### Точки входа — администратор или собственник

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/admin/entries` | Список: `{id, code, name, kind, kindLabel, active, total, waiting}` |
| `POST /api/admin/entries` → 201 | Создать: `{name, kind: site\|social\|object\|office}`; код ссылки выдаёт сервер |
| `PUT /api/admin/entries/:id` | Изменить `name`, `kind`, `active` |

Ссылка на форму: `<адрес приложения>/#/f/<code>`. QR-код строится в браузере функцией `ModusCore.qrSvg(url, caption)`.
