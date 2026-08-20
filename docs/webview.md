# Webview UI

Каталог: `src/webview/`. Бандл: Vite → `dist/webview/bundle.js` + `bundle.css`.

Точка входу `index.tsx`: монтує `<App />`, одразу шле `WEBVIEW_READY`.

## Стан

`NugetManagerContext` — один `useReducer`. Вхід з host: `dispatch({ type: 'MSG', msg })`.

Основні гілки стану:

- `scope`, `activeTab` (`packages` | `updates` | `sources` | `log`);
- `packages` — installed / implicit / available, пошук, джерела, prerelease, enrich progress, loading;
- `updates` — історія batch-джобів (Update all / family);
- `sources.configChain` / `allSources`;
- `log.entries`;
- `detail` — вибраний пакет, metadata, versions, per-project loading/errors;
- `dotnetMissing`, `globalError`, `pendingRollback`.

Помилка add, банер, Rollback і синхронізація версій у деталях: [install-and-rollback](install-and-rollback.md).

`vscodeApi.getState` / `setState` оголошені, UI їх не викликає — вкладка і рядок пошуку не переживають повний reload webview.

## Оболонка (`App.tsx`)

Чотири вкладки (Packages, Groups, Sources, Log) + кнопка поточного `.sln`/`.csproj` справа. Клік відкриває QuickPick інших solution/project у workspace (`SELECT_SCOPE`). Якщо scope порожній — «Select project…». Якщо `dotnetMissing` — банер замість UI.

Банер операції (`.error-banner--operation`): заголовок + `▼ N` — один спойлер (`pointerdown`, щоб не треба було клікати двічі в webview). Повний CLI після відкриття, з переносом, без горизонтального скролу. Те саме для restore, add/remove і timeout. Кнопки Rollback / Groups / Log / ✕ окремо справа.

## Packages

`PackagesTab` і `UpdatesTab` ділять `SplitPane` (`.split-tab` / `.pkg-body` / `.pkg-row` / `.detail-panel`). Спліттер тягнеться мишею або стрілками; **за замовчуванням список ≤ 50%**. Після ручного ресайзу обмеження знімається.

`PackageRow`: перший рядок — лише назва (`overflow-wrap: anywhere`). Другий — встановлена версія зліва, source/latest справа; довгий prerelease **не** стискає назву.

Toolbar:

- Restore (`RESTORE_PACKAGES`) — `dotnet restore`, потім list/vuln; кеш latest лишається;
- Force refresh (`FORCE_REFRESH`) — те саме з очищенням кешу latest;
- пошук (inline `<input>`, не `SearchBar.tsx` — той файл **не підключений**);
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

`PackageRow`: назва на першому рядку (може переноситись); версії / latest — окремий рядок. **↑** якщо SemVer latest > resolved; **⚠** якщо є finding на цьому id **або** на restore-граф залежності (implicit / інший installed). Прямий ⚠ червоний, через залежність — warning. Вразливі пакети в Installed/Implicit сортуються вище. Підказка implicit-версій батька залежить від `dependsOn`, яке CLI **не заповнює**.

### Деталі

`PackageDetailPanel` + `VersionSelector`:

- при виборі пакета — `GET_ALL_VERSIONS` і `GET_PACKAGE_METADATA`;
- зміна версії — повторний metadata;
- project scope: Install / Update / Remove одразу в цей `.csproj`;
- solution scope: попап `ProjectSelectionPopup` (усі проєкти для install, лише з пакетом для remove) або рядки `ProjectListSection` для per-project update/remove.

`ProjectListSection`: select версії синхронізується з `installed` / `detail.projectVersions` після PATCH або нового `dotnet list` (`useEffect` на встановлену версію), щоб відкрита панель деталей не лишалась на старих значеннях при частковому успіху.

Порожній вибір у попапі = Cancel, без CLI.

Секції metadata (authors, description, URLs, tags) показуються, якщо CLI щось повернув. Catalog **Dependencies** / TFM / published у розмітці є, з CLI backend завжди порожні (чекають HttpBackend).

Останній блок **Current Dependencies** — дерево з restore-графа встановленої версії (`dependencies` зі `project.assets.json`, серед installed + implicit). Версія одразу після назви, TFM справа (`framework` з `dotnet list`). RID (`win-x64`) list не віддає. Не залежить від вибраної версії в селекторі. Клік по id відкриває той пакет; implicit рядки приглушені.

## Groups

`UpdatesTab` — той самий `SplitPane`, що Packages: зліва All, families, Other як `pkg-row`; справа `detail-panel`. All / Other — лише назва + count, без версії (у кожного пакета своя latest). Сім’я завжди показує `from → suggested`. Деталі: [batch-updates](batch-updates.md).

## Sources і Log

Окремі документи: [config-chain](config-chain.md), [logging](logging.md).

## Стилі

`styles/global.css` — змінні під VS Code theme (`--vscode-*`), layout панелі, рядки пакетів, попап, лог. Окремого UI-kit немає.

## Налаштування, які читає UI

Через `INIT_STATE.includePrerelease` і чекбокс → `SET_PRERELEASE_SETTING` → `config.ts` пише `averenium.nugetManager.includePrerelease` у Global. За замовчуванням галочка **вимкнена** (`false`).

`averenium.nugetManager.onFailedUpdate` читає host (`getConfig()`), не UI: `rollback` | `keep`.
