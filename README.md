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

> Если в вашем окружении официальное хранилище зашифровано (`enc:v1:` в credentials.json), тулза `claim_credits` честно вернёт ошибку — расшифровка official runtime'а не реализуется, выполните клейм вручную через браузер z.ai.

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
| `account_status(account?)` | `{account, model, configuredFiles, activeJobs, stats:{done, failed}}`. |
| `claim_credits(account?)` | **Experimental**: детект активностей (`billing/preview`), активация (`event/report`), статус квоты (`billing/current`) и клейм (`billing/claim`) через JWT аккаунта. Капча/anti-bot не автоматизированы — при верификации вернёт инструкцию на ручной клейм в браузере z.ai → страница активностей. |

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
| `ORCHESTRA_ACCOUNTS` | `[{"name":"main",...}]` | JSON-массив аккаунтов: `[{"name":"main","credentialsFile":null,"providerConfigFile":null,"model":"account:zai-start-plan/GLM-5.3-Flash"}]`. `credentialsFile`/`providerConfigFile` — абсолютные пути; если заданы, при спавне ребёнку подставляются `ZCODE_CLI_CREDENTIALS_FILE` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (изоляция аккаунтов). Дефолт — один аккаунт `main` с общим `~/.zcode`. |
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
