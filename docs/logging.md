# Логування

Файл: `src/logger.ts`.

`Logger`:

- Output Channel `Averenium NuGet Manager`;
- in-memory масив `LogEntry[]` (хронологічний, без ліміту розміру);
- pub/sub: `subscribe(listener)` → `Disposable`;
- `clear()` — порожнить масив і Output Channel. **Не** зупиняє trace і не чіпає `globalStorage`.

Кожен `CliRunner.run` і частина «несправжніх» операцій broker (резолв config chain) викликають `logCliOperation`.

`LogEntry`: `id` (UUID), `timestamp` (ISO), `command`, `args`, `stdout`, `stderr`, `exitCode`, `timedOut`, `durationMs`.

Помилки запису в Output Channel і помилки слухачів ковтаються — логер не повинен ламати CLI.

## Доставка в UI

При `attach()` broker підписується на logger і шле `LOG_ENTRY_ADDED`. Вкладка Log при монтуванні просить повний зріз `GET_LOG_ENTRIES`. `CLEAR_LOG` шле `LOG_CLEARED`.

`LogTab`: toolbar (**● Trace** / **■ Stop & save zip**, **Clear log**), бедж `recording`, автоскрол вниз, рядок з часом / duration / командою / exit, перші 3 рядки виводу, решта за кнопкою розгортання.

Метод `Logger.show()` (показати Output Channel) у UI не викликається.

## Trace (діагностика для issue)

Не експорт вкладки Log. Окрема **сесія** (`src/traceSession.ts`, `src/traceController.ts`): вимкнена за замовчуванням.

1. **Start** (toolbar або **NuGet: Trace -> Start**) — confirm: запис включає CLI, sanitised `nuget.config` і sanitised project files поточного scope; zip не комітити. Пише в `globalStorage/trace-<iso>/` (`trace.jsonl`), не в RAM.
2. Користувач відтворює баг.
3. **Stop & save zip** — sanitize → zip (`src/zipStore.ts`, deflate, без PowerShell) → Save dialog. Toast: прикріпити zip до issue. GitHub не відкривається і архів нікуди не POST.

Повторний Start, поки сесія жива: запропонувати спочатку Stop. Hide panel (`retainContextWhenHidden`) **не** зупиняє запис. Після reload Extension Host, якщо лишилась папка сесії: **Stop & pack** / **Discard**.

Поки запис увімкнено, додатково (лише у файли сесії, не у вкладку Log): webview `type` + урізаний payload; кроки broker (init, snapshot, add/remove, batch-item, enrich-retry, vuln); CLI `cwd` / duration / stdout / stderr.

У zip після sanitizer (`src/traceSanitize.ts`, найдовший шлях першим): `trace.jsonl` (CLI stdout/stderr, webview, broker — без окремого `cli.log`), ланцюжок `nuget.config`, csproj/fsproj scope + `Directory.Packages.props` / `Directory.Build.props` / `global.json` / `packages.config` / `.sln`, `blocked-packages.json` (лише ids). Кожен проєкт/конфіг має **один** id (`projects/p01.csproj`, `nuget-config/c00.xml`) — той самий у `trace.jsonl`, у `ProjectReference` / `.sln` / `.slnx` (csproj/fsproj/vbproj) і в папках zip. У csproj маскуються **Container*** / **Docker*** / **Registry*** (реєстр образів, репозиторій, env, ключі Windows Registry); порти й `EnableSdkContainerSupport` лишаються. Елементи й атрибути, у назві яких є **password** / **apikey** (і `key`/`Include` з таким словом), теж `<redacted>`. Дефолтна назва архіву: `nuget-manager-trace-YYYY-MM-DD_HH-MM-SS.zip`. Без secrets, `.vscode/settings.json`, `.cs`, `appsettings`, `bin`/`obj`. Ліміт ~15 MB / 30 хв (oldest jsonl drop, `truncated=yes` у README). Більше 40 проєктів — touched + `projects-omitted.txt`.
