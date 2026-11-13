# zcode-orchestra

MCP-сервер-оркестратор над CLI [zcode](https://www.npmjs.com/package/zcode-app-cli) (неофициальный CLI ZCode). Даёт внешним AI-агентам (оркестраторам) тулзы для запуска **параллельных «брифованных сессий»**: каждая задача — отдельный процесс `zcode -p '<brief>' --output-format json` со своим workdir и своей сессией в session DB. Квоты Z.AI Start Plan (бесплатные ночные/выходные кредиты) используются аккаунтным логином — ключи не нужны.

## Как это устроено

- `submit` кладёт задачу в очередь и сразу возвращает `jobId`; воркеры (семафор, `ORCHESTRA_MAX_PARALLEL`, по умолчанию 2) исполняют задачи по очереди. Состояния: `queued → running → done | failed | cancelled`.
- stdout/stderr каждой задачи пишутся в `data/jobs/<jobId>.log`; в памяти держатся только метаданные и хвосты буферов — сервер экономен по RAM.
- Журнал `data/jobs.json` переживает рестарт: задачи, застрявшие в `running`/`queued` без процесса, помечаются `failed`.
- Результат парсится толерантно из финального JSON (`result`, `session_id`, `usage`); `session_id` можно передать в `resume` следующего вызова.
- Отмена: `SIGTERM`, через 10 секунд `SIGKILL`.

Транспорты: **streamable HTTP** (основной, путь `/mcp`, bearer-токен) и **stdio** (для отладки). Переключение — `ORCHESTRA_TRANSPORT=http|stdio`.

## Деплой на сервер (Docker)

Требования: Docker с docker compose v2; на сервере 1.9 ГБ RAM — лимит контейнера 1g уже выставлен.

```bash
git clone <repo> zcode-orchestra && cd zcode-orchestra
cp .env.example .env
# отредактируйте .env: задайте ORCHESTRA_TOKEN (любая длинная случайная строка)
docker compose up -d --build
curl http://127.0.0.1:8787/healthz   # → {"ok":true,"version":"1.0.0"}
```

## Первичный логин аккаунта z.ai внутри контейнера

Креды хранятся в volume `./.data/zcode` (→ `/root/.zcode` в контейнере), поэтому логин достаточно выполнить один раз:

```bash
docker compose exec zcode-orchestra zcode login --oauth --no-browser
```

Команда напечатает ссылку — **откройте её в любом браузере** (на любой машине) и подтвердите вход. После логина JWT появится в `/root/.zcode/v2/credentials.json` внутри volume.

> **Headless-сервер (Docker):** без Secret Service runtime требует секрет шифрования кредов. compose уже подключает `./.data/zcode-credential-secret` как `ZCODE_CREDENTIAL_SECRET_FILE` — создайте файл до первого логина:
> ```bash
> openssl rand -base64 32 > .data/zcode-credential-secret && chmod 600 .data/zcode-credential-secret
> ```
> Секрет нужно сохранить отдельно: без него после утери volume креды не расшифровать.

## Клейм бесплатных кредитов (claim_credits)

Тулза `claim_credits` выполняет полный цикл в отдельном child-процессе (`dist/claim-cli.js`, свои 512МБ heap):

1. расшифровка JWT из `credentials.json` (`enc:v1`/`enc:v2:env` — формат реверсирован из официального рантайма; секрет — `ZCODE_CREDENTIAL_SECRET_FILE`);
2. события активации `app_launch`/`app_daily_active` (триггерят выдачу Start Plan);
3. детект клеймящихся активностей (`billing/preview`);
4. **минт Aliyun traceless-капчи** — вендоред happy-dom-солвер ([TriDefender/zcode-api](https://github.com/TriDefender/zcode-api), CC BY-NC-SA 4.0 — см. [NOTICE.md](NOTICE.md)); без браузера, ~5-10с на решение, ретрай-лесенка с классификацией ошибок (F008/IP-блок — фатальны, сталь/таймаут — ретраятся);
5. `POST billing/claim` с заголовками `X-Aliyun-Captcha-Verify-Param`/`-Region` (повтор со свежим минтом при 3007);
6. статус квоты (`billing/current`, фолбэк `billing/balance`).

Ручной прогон внутри контейнера (учётка уже залогинена):

```bash
docker compose exec zcode-orchestra node dist/claim-cli.js --credentials /root/.zcode/v2/credentials.json            # статус: preview + квота
docker compose exec zcode-orchestra node dist/claim-cli.js --credentials /root/.zcode/v2/credentials.json --claim    # клейм (авто-выбор активности)
docker compose exec zcode-orchestra node dist/claim-cli.js --credentials /root/.zcode/v2/credentials.json --claim zcode-v3-start-plan-1113-wk  # конкретный plan_id
node dist/claim-cli.js --mint-only   # смоук солвера без кредов (можно локально)
```

Коды отказа: `1005` — суточный слот исчерпан (уже клеймилось, NextAt = ends_at), `1002` — кампания завершена, `3006` — модель не разрешена, `3007` — капча отклонена (автоматически повторяется со свежим минтом).

> `enc:v2:os` (keyring десктопа) не поддерживается — только файловый секрет (`enc:v1`/`enc:v2:env`), как в Docker.

## Подключение как MCP из ZCode Desktop

Добавьте сервер (тип **http**):

- **url**: `http://<host>:8787/mcp`
- **заголовок**: `Authorization: Bearer <ORCHESTRA_TOKEN>`

Проверка доступности: `curl -H "Authorization: Bearer <token>" http://<host>:8787/healthz`.

## Тулзы

| Тулза | Назначение |
|---|---|
| `zcode_agent(brief, workdir?, model?, effort?, resume?, account?, wait?)` | Поставить брифованную сессию в очередь. `wait=false` (дефолт) → сразу `{jobId, status:"queued", position}`; `wait=true` → ждать завершения (до 30 минут) и вернуть финал: `{status, result, session_id, usage, error}`. `workdir` относительный резолвится от `ORCHESTRA_WORKDIR_ROOT`. `account` по умолчанию `main`. |
| `zcode_job_status(jobId)` | `{status, exitCode, result, usage, session_id, error, logTail}` — logTail: последние 1000 символов журнала задачи. |
| `zcode_jobs()` | Последние 20 задач из журнала, свежие первыми. |
| `zcode_job_cancel(jobId)` | Отменить задачу (queued снимается с очереди, running → SIGTERM → SIGKILL через 10с). |
| `account_status(account?)` | `{account, model, configuredFiles, activeJobs, stats:{done, failed}}` — только ваши аккаунты. |
| `claim_credits(account?)` | Полный цикл клейма бесплатных кредитов: активация (`event/report`) → детект (`billing/preview`) → минт Aliyun-капчи (вендоред happy-dom-солвер, ~5-10с) → `billing/claim` с верификацией → квота (`billing/current`). Детали и коды отказа — секция «Клейм бесплатных кредитов» выше. |
| `notify_test(account?)` | Тест канала уведомлений: шлёт проверочное сообщение в ваш Telegram через Worker-релей. |

Все тулзы скоупятся пользователем MCP: bearer-токен → пользователь (`ORCHESTRA_USERS`), чужие аккаунты и их задачи недоступны.

## Мультиюзер

Каждый пользователь = свой bearer-токен + свой набор аккаунтов + свой Telegram chat для уведомлений:

```json
ORCHESTRA_USERS=[{"name":"warlock","token":"<длинный-случайный>","accounts":["main","alt"],"chatId":123456789},
                 {"name":"friend","token":"<другой-токен>","accounts":["*"]}]
```

`accounts: ["*"]` — все аккаунты. `chatId` (или `notifyChatId` у аккаунта) — куда слать уведомления автоклейма. Без `ORCHESTRA_USERS` — один пользователь `default` с `ORCHESTRA_TOKEN` и доступом ко всем аккаунтам (обратная совместимость). Chat id передаётся юзером при настройке MCP — один раз, через конфиг или инструмент `notify_test` для проверки.

## Автоклейм

Планировщик внутри сервера (`ORCHESTRA_CLAIM_AUTO=1`, интервал `ORCHESTRA_CLAIM_INTERVAL_MS=600000`) каждые N минут на каждый аккаунт:

0. **окно раздач**: тики работают только после 14:00 МСК (`ORCHESTRA_CLAIM_AFTER_MSK`), в пятницу — после 17:00 (`ORCHESTRA_CLAIM_FRIDAY_AFTER_MSK`) — раньше раздач всё равно нет;
1. **discovery** (дёшево, без капчи): `event/report` (мимикрия перезахода — триггерит выдачу кампаний) → `marketing/touch` (карточки кампаний, plan_id) → `billing/preview`;
2. новый кандидат (не в state / окно истекло / бэкофф прошёл) → полный клейм через claim-cli (минт капчи + claim);
3. результат в `data/claim-state.json` (переживает рестарты): успех — suppress до `ends_at` плана; `1005` (суточный слот занят) — до NextAt/6ч; `1002` (кампания умерла) — 7 дней; прочие отказы — **лестница до 4 попыток с паузой 10 минут**, после — тишина до следующего окна;
4. уведомление владельцу через Worker-релей (успех / каждая неудача с номером попытки / исчерпание / сломанный discovery).

Окна (18:00 ночные, пт-вечер выходные) не хардкодятся — кандидат появляется в touch/preview и клеймится в течение одного тика. Под полной нагрузкой (все слоты заняты задачами) тик пропускается — claim-child не конкурирует за память с брифами.

## Уведомления (CF Worker-релей)

Токен бота НЕ хранится в контейнере — только в Cloudflare Worker. Деплой:

1. dash.cloudflare.com → Workers → Create → вставить `worker/notify-worker.js`;
2. Settings → Variables → Secrets: `TG_BOT_TOKEN` (токен от @BotFather) и `AUTH_TOKEN` (длинная случайная строка);
3. в `.env` оркестра: `NOTIFY_WEBHOOK_URL=https://<worker>.workers.dev/notify`, `NOTIFY_WEBHOOK_TOKEN=<AUTH_TOKEN>`;
4. юзеру в Telegram: написать боту что угодно (активировать чат), проверить `notify_test`.

Без `NOTIFY_WEBHOOK_URL` уведомления выключены (одна строка в лог, автоклейм работает).

Типичный цикл оркестратора: `zcode_agent(brief=..., workdir="proj-a")` → `zcode_job_status(jobId)` → забрать `result`/`session_id` → продолжение сессии: `zcode_agent(brief="...", resume=<session_id>, workdir="proj-a")`.

## Конфигурация

Env-переменные (все с дефолтами; валидация при старте, фатальные ошибки — в лог):

| Переменная | Дефолт | Описание |
|---|---|---|
| `ORCHESTRA_TOKEN` | — | Bearer-токен HTTP-режима; **обязателен в http** (иначе фатал при старте) |
| `ORCHESTRA_PORT` | `8787` | Порт HTTP-транспорта |
| `ORCHESTRA_TRANSPORT` | `http` | `http` \| `stdio` |
| `ORCHESTRA_MAX_PARALLEL` | `2` | Семафор параллельных процессов zcode |
| `ORCHESTRA_START_STAGGER_MS` | `20000` | Минимальный интервал между стартами задач (мс): стартовый burst zcode — пик памяти, на слабом хосте разносите старты; 0 = без разноса |
| `ORCHESTRA_ACCOUNTS` | `[{"name":"main",...}]` | JSON-массив аккаунтов: `[{"name":"main","credentialsFile":null,"providerConfigFile":null,"model":"account:zai-start-plan/GLM-5.3-Flash","notifyChatId":123}]`. `credentialsFile`/`providerConfigFile` — абсолютные пути; если заданы, при спавне ребёнку подставляются `ZCODE_CLI_CREDENTIALS_FILE` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (изоляция аккаунтов). `notifyChatId` — переопределение Telegram chat для уведомлений этого аккаунта. Дефолт — один аккаунт `main` с общим `~/.zcode`. |
| `ORCHESTRA_USERS` | `default` | JSON-массив пользователей: `[{"name":"warlock","token":"...","accounts":["main","*"],"chatId":123456789}]` — см. «Мультиюзер». |
| `ORCHESTRA_CLAIM_AUTO` | `1` | Автоклейм: планировщик discovery+claim внутри сервера |
| `ORCHESTRA_CLAIM_INTERVAL_MS` | `600000` | Интервал тика автоклейма (60с..3.6млн) |
| `ORCHESTRA_CLAIM_AFTER_MSK` | `14` | Час МСК, с которого тикает автоклейм (раздачи появляются после 14:00) |
| `ORCHESTRA_CLAIM_FRIDAY_AFTER_MSK` | `17` | Час МСК для пятницы (weekend-раздача после 17:00) |
| `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_TOKEN` | — | CF Worker-релей уведомлений (см. «Уведомления»); без URL — выключены |
| `ORCHESTRA_ZCODE_BIN` | `zcode` | Бинарник zcode CLI |
| `ORCHESTRA_WORKDIR_ROOT` | `/workspace` | База для относительных workdir |
| `ORCHESTRA_DATA_DIR` | `./data` (в контейнере `/app/data`) | Журнал задач: `jobs.json` + `jobs/*.log` |
| `ORCHESTRA_CONFIG` | — | Путь к JSON-файлу конфига (ключи camelCase); **env имеет приоритет над файлом** |

## Отладка через stdio

```bash
npm install && npm run build
ORCHESTRA_TRANSPORT=stdio npm start
```

В ZCode Desktop можно подключить как stdio-сервер (команда `node dist/index.js`, cwd — каталог проекта); тогда `ORCHESTRA_TOKEN` не нужен.

Смоук-тест runner'а без реального zcode: `npm run smoke` (использует `test/fake-zcode.mjs` — echo-заглушку).

## Ограничения RAM

- Контейнер ограничен `mem_limit: 1g` (хост — 1.9 ГБ). Держите `ORCHESTRA_MAX_PARALLEL` в пределах 2–3: каждый процесс zcode — это Node.js-процесс со своими потребностями.
- Сервер не буферизует вывод задач: полный stdout/stderr — только в файл журнала, в памяти хвосты (stdout ≤ 512 КБ, stderr ≤ 64 КБ на задачу).
- HTTP-транспорт работает в stateless-режиме: на каждый запрос — одноразовая пара transport+server, сессии в памяти не копятся.
- Глобальный request-таймаут отключён (`requestTimeout=0`): долгие вызовы с `wait=true` (до 30 минут) не рвутся.

## Замечания по безопасности

- Все логи — в stderr; JWT и другие секреты в логи и результаты не выводятся.
- Bearer-токен сравнивается constant-time (`crypto.timingSafeEqual`); `/healthz` доступен без авторизации и отдаёт только версию.
- Не выставляйте порт в открытый интернет без прокси с TLS — токен передаётся в заголовке при каждом запросе.
