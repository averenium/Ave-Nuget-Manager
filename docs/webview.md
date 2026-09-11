# Webview UI

Каталог: `src/webview/`. Бандл: Vite → `dist/webview/bundle.js` + `bundle.css`.

Точка входу `index.tsx`: монтує `<App />`, одразу шле `WEBVIEW_READY`.

## Стан

`NugetManagerContext` — один `useReducer`. Вхід з host: `dispatch({ type: 'MSG', msg })`.

Основні гілки стану:

- `scope`, `activeTab` (`packages` | `updates` | `sources` | `log` | `agents`);
- `packages` — installed / implicit / available, пошук, джерела, prerelease, enrich progress, loading, `blockedPackages`;
- `updates` — історія batch-джобів (Update all / family);
- `sources.configChain` / `allSources` / `snapshot` (effective feeds, chain diffs, conflicts);
- `log.entries`;
- `agents` — bundled version, `detected` families, `installs` (path + version + outdated);
- `detail` — вибраний пакет, metadata, versions, per-project loading/errors;
- `dotnetMissing`, `globalError`, `pendingRollback`.

Помилка add, банер, Rollback і синхронізація версій у деталях: [install-and-rollback](install-and-rollback.md).

`vscodeApi.getState` / `setState` оголошені, UI їх не викликає — вкладка і рядок пошуку не переживають повний reload webview.

## Оболонка (`App.tsx`)

Чотири вкладки (Packages, Groups, Sources, Log) + **Agents** після Log + кнопка поточного `.sln`/`.csproj` справа. Клік відкриває QuickPick інших solution/project у workspace (`SELECT_SCOPE`). Якщо scope порожній — «Select project…». Якщо `dotnetMissing` — банер замість UI. Вкладка Agents завжди видима (навіть коли `detected` порожній).

Банер операції (`.error-banner--operation`): заголовок + `▼ N` — один спойлер (`pointerdown`, щоб не треба було клікати двічі в webview). Повний CLI після відкриття, з переносом, без горизонтального скролу. Те саме для restore, add/remove і timeout. Кнопки Rollback / Groups / Log / ✕ окремо справа.

## Packages

`PackagesTab` і `UpdatesTab` ділять `SplitPane` (`.split-tab` / `.pkg-body` / `.pkg-row` / `.detail-panel`). Спліттер тягнеться мишею або стрілками; **за замовчуванням список ≤ 50%**. Після ручного ресайзу обмеження знімається.

`PackageRow`: перший рядок — лише назва (`overflow-wrap: anywhere`). Другий — встановлена версія зліва, source/latest справа; довгий prerelease **не** стискає назву.

Toolbar:

- Restore (`RESTORE_PACKAGES`) — `dotnet restore`, потім list/vuln; кеш latest лишається;
- Force refresh (`FORCE_REFRESH`) — те саме з очищенням кешу latest;
- пошук (inline `<input>` у `PackagesTab`);
- `SourceFilterDropdown`;
- лічильник enrich `done/total`;
- чекбокс Pre-release.

Під рядком пошуку / toolbar — завжди 7px `activity-strip`. Restore/refresh: повільний shimmer; Force refresh заповнює смужку за enrich. Group update: shimmer на старті, далі fill за проєктами. Restore штампує latest з кешу в list і не шле повторний `PACKAGE_INFO_UPDATE`, щоб лічильники не скакали.

Пошук каталогу: мінімум 2 символи, debounce 300 ms. Зміна джерел або prerelease повторює search.

### Списки

| Компонент | Дані | Нотатки |
|---|---|---|
| `InstalledList` | `INSTALLED_PACKAGES` | Групування за id; кілька версій у solution показує `PackageRow`. Skeleton під час loading |
| `ImplicitList` | `IMPLICIT_PACKAGES` | Ховає id, які вже є в Installed |
| `AvailableList` | `SEARCH_RESULTS` | Лише якщо query ≥ 2 |

Локальний фільтр Installed/Implicit — `utils/search.ts`: case-insensitive, абревіатури `ef`, `aspnet`, `mvc`, `di`, `ioc`, ранжування `relevanceScore`.

`PackageRow`: назва на першому рядку (може переноситись); версії / latest — окремий рядок. **↑** якщо SemVer latest > resolved; **⊘** якщо id у workspace `blockedPackages` (tooltip *Updates blocked for this workspace*); **⚠** якщо є finding на цьому id **або** на restore-граф залежності (implicit / інший installed). Прямий ⚠ червоний, через залежність — warning. Вразливі пакети в Installed/Implicit сортуються вище. Підказка implicit-версій батька залежить від `dependsOn`, яке CLI **не заповнює**.

Правий клік по Installed або прев’ю Groups: **Block updates** / **Unblock updates** (стандартне меню webview на цих рядках глушиться). Список пишеться в `.vscode/settings.json`. **↑** у деталях і per-project не виконує add, поки пакет заблоковано; **✕** Remove лишається. Новий install id, якого ще немає в Installed, дозволений.

Host відхиляє `INSTALL_PACKAGE` / `INSTALL_PACKAGE_MULTI` / `UPDATE_PACKAGES_BATCH` для вже встановленого blocked id.

### Деталі

`PackageDetailPanel` + `VersionSelector`:

- при виборі пакета — `GET_ALL_VERSIONS` і `GET_PACKAGE_METADATA`;
- зміна версії — повторний metadata;
- project scope: Install / Update / Remove одразу в цей `.csproj`;
- solution scope: попап `ProjectSelectionPopup` (усі проєкти для install, лише з пакетом для remove; для update за замовчуванням зняті проєкти вже на цільовій версії) або рядки `ProjectListSection` для per-project update/remove.
- **↑** на вже встановлений `Microsoft.CodeAnalysis*` з версією новішою за SDK `csc`: спочатку `RoslynCapPopup` (Update anyway / Cancel). Solution — warning, потім picker. Перший Install і версії `≤ csc` — як раніше.

`ProjectListSection`: select версії синхронізується з `installed` / `detail.projectVersions` після PATCH або нового `dotnet list` (`useEffect` на встановлену версію), щоб відкрита панель деталей не лишалась на старих значеннях при частковому успіху.

Порожній вибір у попапі = Cancel, без CLI.

Секції metadata (authors, description, URLs, tags) показуються, якщо CLI щось повернув. Catalog **Dependencies** / TFM / published у розмітці є, з CLI backend завжди порожні (чекають HttpBackend).

Останній блок **Current Dependencies** — дерево з restore-графа встановленої версії (`dependencies` зі `project.assets.json`, серед installed + implicit). Версія одразу після назви, TFM справа (`framework` з `dotnet list`). RID (`win-x64`) list не віддає. Не залежить від вибраної версії в селекторі. Клік по id відкриває той пакет; implicit рядки приглушені.

## Groups

`UpdatesTab` — той самий `SplitPane`, що Packages: зліва All, families, Other як `pkg-row`; справа `detail-panel`. All / Other — лише назва + count, без версії (у кожного пакета своя latest). Сім’я завжди показує `from → suggested`. Деталі: [batch-updates](batch-updates.md).

## Sources, Log і Agents

Окремі документи: [config-chain](config-chain.md), [logging](logging.md), [agent-skill](agent-skill.md). Sources — `SplitPane` 35/65: зліва секції конфігів (Effective / Workspace / Global / Machine), справа репозиторії з бейджами; Edit розгортає форму в рядку. `AgentsTab` — картка skill + **Install…** або split **Update | …** (`INSTALL_AGENT_SKILL`). **…** — QuickPick в інше місце. Update не відкриває QuickPick. Після copy host одразу шле `SKILL_STATUS` (тост не блокує). Вкладка не ховається, якщо `detected` порожній.

## Стилі

`styles/global.css` — змінні під VS Code theme (`--vscode-*`), layout панелі, рядки пакетів, попап, лог. Окремого UI-kit немає.

### High Contrast (#44)

`--color-contrast-border: var(--vscode-contrastBorder, transparent)` і `--color-focus-border: var(--vscode-contrastActiveBorder, var(--color-btn-bg))` у `:root` — обидва прозорі/дефолтні поза HC-темами, тож це суто адитивно.

Кожна нова кнопка (`.btn`) чи іконка-індикатор без власного border/background мають отримати:
- `outline: 1px solid var(--color-contrast-border); outline-offset: -1px;` (або `outline-offset: 2px;` для іконки без padding) — межа, яку HC-теми чекають на interactive-елементі;
- для focus/hover, де раніше стояв `outline: 1px solid var(--color-btn-bg)` — замінити на `var(--color-focus-border)` (fallback-ланцюжок зберігає той самий колір поза HC).

`@media (forced-colors: active)` в кінці `global.css` — незалежний другий рівень захисту на системних ключових словах (`ButtonText`, `Canvas Text`, …) для Windows forced-colors, на випадок якщо `--vscode-contrastBorder` з якоїсь причини не проставлений.

Перевірка: `workbench.colorTheme` → "High Contrast" / "High Contrast Light" у самому VS Code, спеціального стенду не треба.

## Налаштування, які читає UI

Через `INIT_STATE.includePrerelease` і чекбокс → `SET_PRERELEASE_SETTING` → `config.ts` пише `averenium.nugetManager.includePrerelease` у Global. За замовчуванням галочка **вимкнена** (`false`).

`averenium.nugetManager.blockedPackages` — лише Workspace (`.vscode/settings.json`). Host шле список у `INIT_STATE` / `BLOCKED_PACKAGES`. User-level значення ігнорується.

`averenium.nugetManager.onFailedUpdate` читає host (`getConfig()`), не UI: `rollback` | `keep`.
