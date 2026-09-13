# Логування

Файл: `src/logger.ts`.

`Logger`:

- Output Channel `Averenium NuGet Manager` — unbounded, повний сінк;
- in-memory масив `LogEntry[]` (хронологічний), ring buffer — макс. 500, старі відкидаються (`MAX_ENTRIES`, #58). Рядки `kind: 'http'` мають **власний бюджет** (300, `MAX_HTTP_ENTRIES`, #27): одне оновлення панелі по HTTP робить сотні запитів і на спільному кільці витіснило б CLI-історію, заради якої лог існує;
- pub/sub: `subscribe(listener)` → `Disposable`;
- `clear()` — порожнить масив і Output Channel. **Не** зупиняє trace і не чіпає `globalStorage`.
- `http` — запити експериментального HTTP-каталогу (#27): `command` = `GET <url>`, `args` = статус, розмір тіла, позначка `authenticated` / `cached` / `shared` і причина. **Значення заголовка авторизації в лог не потрапляє ніколи** — лише факт, що запит його ніс. Окремими рядками того ж kind ідуть рішення: яка сходинка драбини відповіла, скільки влучень дав пошук, коли пішли на CLI. `exitCode` тут означає лише «фарбувати як помилку»: 404 — штатна відповідь «пакета тут немає», тож він `0`, а 401 / 5xx — ні.
- `info` / `error` — діагностика host (активація, view). Output Channel (+ `console.error` для `error`) **і** рядок у вкладці Log (`kind: 'info'`/`'error'`, без `stdout`; `error` кладе повний текст у `stderr`) — до #58 в Log tab не потрапляли.

`activate()` обгорнутий у try/catch: кроки в Output (`activate start` … `activate done`). Якщо кидок — `error` зі stack, канал показується, toast `AVE NuGet Manager failed to start`, виняток пробрасується далі в VS Code. `resolveWebviewView` так само ловить свої помилки.

Падіння **webview** (білий екран): React Error Boundary показує stack у панелі й шле `WEBVIEW_ERROR`. Те саме для `window.onerror`, `unhandledrejection` і винятку в reducer. Host пише `[error] webview react|window|reducer: …` і відкриває цей канал.

Куди дивитись, якщо панель не з’явилась: **Output → Averenium NuGet Manager**, не лог C# / restore.

Кожен `CliRunner.run` і частина «несправжніх» операцій broker (резолв config chain, edit PackageReference, nuget.config edits, vulnerability scan skipped) викликають `logCliOperation`.

`LogEntry`: `id` (UUID), `timestamp` (ISO), `kind` (`'cli' | 'edit' | 'scan' | 'info' | 'error' | 'http'`, дефолт `'cli'` в `logCliOperation` — реальний `dotnet` завжди йде через `CliRunner._logCli`, «несправжні» виклики в broker передають свій kind явно), `command`, `args`, `stdout`, `stderr`, `exitCode`, `timedOut`, `durationMs`.

Помилки запису в Output Channel і помилки слухачів ковтаються — логер не повинен ламати CLI.

## Доставка в UI

При `attach()` broker підписується на logger і шле `LOG_ENTRY_ADDED`. Вкладка Log при монтуванні просить повний зріз `GET_LOG_ENTRIES`. `CLEAR_LOG` шле `LOG_CLEARED`. Webview-бік reducer теж тримає ring buffer (500, той самий ліміт, що й у `Logger`).

`LogTab` (#58, редизайн — subsumes #50 пошук / #51 автоскрол / #52 формат часу):

- **Toolbar**: **● Trace** / **■ Stop & save zip**, бедж `recording`, пошук (командa+args+stdout+stderr, case-insensitive substring — нативний Ctrl+F не працює в sidebar `WebviewView`), фільтр за kind (All / Errors / CLI / HTTP / Edits), **Copy** (видимі рядки), **Copy sanitised** (`COPY_LOG_SANITIZED` → host прогонить через `sanitizeText`/`sanitizeCtx`, той самий редактор, що й trace-zip — для вставки в публічний issue без повного трейсу), **Output** (`OPEN_LOG_OUTPUT` → `logger.show()`), **Clear**.
- **Рядок**: шеврон, час `HH:mm:ss.SSS` (без locale; повний ISO в `title`), duration, kind-бедж, команда (+ `args` окремим рядком для «несправжніх» kind — `cli` вже має args у самому `command`), exit-чіп (`ok`/`exit N`/NU-код/`TIMEOUT`). Розділювачі днів (`Today`/`Yesterday`/`YYYY-MM-DD`) між рядками різних днів.
- **Прев'ю помилки** (тільки для нерозгорнутого рядка, що впав): перший змістовний рядок через `summarizeDotnetFailure`, а не перші 3 рядки сирого виводу.
- **Розгорнутий рядок**: блок "command" (copyable) лише для `kind: 'cli'` — для решти kind сумарний рядок вже показує повну мітку й `args`, дублювати нема сенсу (#66); stdout і stderr окремими підписаними блоками (не конкатенація), NU-код клікабельним чіпом на `learn.microsoft.com`. Кожен блок має власну copy-кнопку, що з'являється біля курсора при наведенні (#66) — окремої кнопки Copy знизу рядка більше нема.
- **Автоскрол**: лише якщо список уже був унизу (`isAtBottom`, поріг 24px) — інакше піл "N new ↓" (клік = scroll to bottom, `prefers-reduced-motion` враховано).
- `role="log"` без `aria-live` на всьому контейнері (раніше кожен доданий рядок озвучувався скрінрідером).

## Trace (діагностика для issue)

Не експорт вкладки Log. Окрема **сесія** (`src/traceSession.ts`, `src/traceController.ts`): вимкнена за замовчуванням.

1. **Start** (toolbar або **NuGet: Trace -> Start**) — confirm: запис включає CLI, sanitised `nuget.config` і sanitised project files поточного scope; zip не комітити. Пише в `globalStorage/trace-<iso>/` (`trace.jsonl`), не в RAM.
2. Користувач відтворює баг.
3. **Stop & save zip** — sanitize → zip (`src/zipStore.ts`, deflate, без PowerShell) → Save dialog. Toast: прикріпити zip до issue. GitHub не відкривається і архів нікуди не POST.

Повторний Start, поки сесія жива: запропонувати спочатку Stop. Hide panel (`retainContextWhenHidden`) **не** зупиняє запис. Після reload Extension Host, якщо лишилась папка сесії: **Stop & pack** / **Discard**.

Поки запис увімкнено, додатково (лише у файли сесії, не у вкладку Log): webview `type` + урізаний payload (`password` / `apiKey` → `omitted`; `COPY_TEXT` з `export NUGET_API_KEY=` без значення); кроки broker (init, snapshot, add/remove, batch-item, enrich-retry, vuln); CLI `cwd` / duration / stdout / stderr.

У zip після sanitizer (`src/traceSanitize.ts`, найдовший шлях першим): `trace.jsonl` (CLI stdout/stderr, webview, broker — без окремого `cli.log`), ланцюжок `nuget.config`, csproj/fsproj scope + `Directory.Packages.props` / `Directory.Build.props` / `global.json` / `packages.config` / `.sln`, `blocked-packages.json` (лише ids). Кожен проєкт/конфіг має **один** id (`projects/p01.csproj`, `nuget-config/c00.xml`) — той самий у `trace.jsonl`, у `ProjectReference` / `.sln` / `.slnx` (csproj/fsproj/vbproj) і в папках zip. У csproj маскуються **Container*** / **Docker*** / **Registry*** (реєстр образів, репозиторій, env, ключі Windows Registry); порти й `EnableSdkContainerSupport` лишаються. Елементи й атрибути, у назві яких є **password** / **apikey** (і `key`/`Include` з таким словом), теж `<redacted>`. Дефолтна назва архіву: `nuget-manager-trace-YYYY-MM-DD_HH-MM-SS.zip`. Без secrets, `.vscode/settings.json`, `.cs`, `appsettings`, `bin`/`obj`. Ліміт ~15 MB / 30 хв (oldest jsonl drop, `truncated=yes` у README). Більше 40 проєктів — touched + `projects-omitted.txt`.

## Тіла відповідей: три рівні (#27)

Рядок `http` **не містить тіла** — і це рішення, а не пропуск. Тіла, які варто читати, маленькі: сторінка помилки проксі, HTML капітивного порталу, документ не тієї форми. Великі — це саме ті, що успішно розібрались і вже все сказали рядком (статус, розмір, час) і наслідком (скільки версій прийшло).

1. **Завжди** — метадані рядка: адреса, статус, байти, мілісекунди, `authenticated` / `cached` / `shared`, причина.
2. **На вироку** — коли ресурс визнано непридатним і його прибрано на годину, у лог іде окремий рядок із причиною **і уривком** того, що адреса насправді відповіла (до 400 символів у один рядок). Раніше це рішення було німим: у лозі лишався на вигляд успішний `GET … 200`, а джерело тихо переставало використовуватись.
3. **Повні тіла — лише в трейсі.** Транспорт тримає зріз відповіді розміром 2 КБ у звичайному режимі і 256 КБ поки трейс записує; у `trace.jsonl` потрапляє лише другий. Трейс і так проходить через `sanitizeText` при пакуванні, тож внутрішні адреси й пошта авторів усередині документа редагуються разом з усім іншим, а наявні стелі сесії (15 МБ, 30 хв) доповнені стелею на одне тіло.

Подія трейсу `kind: 'http'` несе адресу, статус, тривалість, розмір, позначку автентифікації й тіло. До цього трейс знав лише `cli`, `webview` і `broker` — тобто трейс, знятий щоб розібрати проблему HTTP-каталогу, не містив жодного HTTP-запиту.
