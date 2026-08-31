# Протокол повідомлень

Контракт: `src/messages.ts`.  
Маршрутизація: `WebviewMessageBroker._handle()` у `src/webviewMessageBroker.ts`.  
UI: `sendMessage` / `onMessage` у `src/webview/vscodeApi.ts`.

Усі повідомлення — дискриміновані union за полем `type`.

## Життєвий цикл сесії

```
webview mount  →  WEBVIEW_READY
                   │
                   ├─ немає scope → auto-detect або порожній INIT_STATE
                   └─ є scope
                        ├─ activateScope уже зробив init → пропуск (антидубль)
                        └─ інакше _initForScope
                             → INIT_STATE (scope, sources, configChain, snapshot, includePrerelease, blockedPackages, traceRecording, bundledVersion, detected, installs, roslynCap, isWindows)
                             → INSTALLED_PACKAGES + IMPLICIT_PACKAGES (`dotnet list --no-restore`)
                             → паралельно `dotnet restore` → ERROR «Restore failed» якщо впав
                             → фоновий enrich → PACKAGE_INFO_UPDATE / ENRICH_PROGRESS
                             → фоновий vuln scan → VULNERABILITIES
```

`activateScope()` (з команди) одразу пушить init, якщо React уже слухає. Повторний `WEBVIEW_READY` (переміщення view або editor tab) знову викликає `_initForScope` — HTML після dispose збирається заново.

## Webview → Host

| `type` | Коли UI шле | Що робить host |
|---|---|---|
| `WEBVIEW_READY` | Після `root.render` у `index.tsx` | `dotnet --version` (один раз), потім init |
| `WEBVIEW_ERROR` | Error Boundary / `window.onerror` / reducer | Output Channel `[error] webview …` + stack; канал показується |
| `SEARCH_PACKAGES` | Пошук ≥2 символи | `searchPackages`; config files беруться з поточного scope, не з payload |
| `SET_PRERELEASE_SETTING` | Чекбокс Pre-release | Пише Global settings, чистить кеш, refresh |
| `GET_PACKAGE_METADATA` | `VersionSelector` | `getMetadata` |
| `GET_ALL_VERSIONS` | `VersionSelector` / сім’я Groups | Кеш (TTL 5 хв); інакше `getAllVersions` |
| `INSTALL_PACKAGE` | Один проєкт | Snapshot файлів → `dotnet add` → успіх або rollback/patch; див. [install-and-rollback](install-and-rollback.md) |
| `REMOVE_PACKAGE` | Один проєкт | `dotnet remove`, потім refresh scope |
| `INSTALL_PACKAGE_MULTI` | Попап у solution | Snapshot усіх проєктів, add з лімітом `dotnetConcurrency`; skip якщо вже на версії |
| `REMOVE_PACKAGE_MULTI` | Попап у solution | Remove з лімітом `dotnetConcurrency`; refresh усієї solution |
| `ROLLBACK_FAILED_UPDATE` | Кнопка Rollback (`onFailedUpdate: keep`) | Відновлює знімки невдалих проєктів + restore |
| `UPDATE_PACKAGES_BATCH` | Update all / family / other | Послідовний add по пакетах; див. [batch-updates](batch-updates.md) |
| `CANCEL_BATCH_UPDATE` | Stop (■) замість Update в заголовку групи | Аборт поточного `dotnet add`, решта пакетів `cancelled` |
| `RESTORE_PACKAGES` | Іконка пакета (Restore) | Restore → list → vuln; смужка Restoring… до `REFRESH_FINISHED`; кеш latest лишається |
| `FORCE_REFRESH` | Кругова стрілка (Force refresh) | Те саме з очищенням кешу; смужка далі показує enrich latest |
| `OPEN_CONFIG_FILE` | Вкладка Sources | `openTextDocument` |
| `COPY_TEXT` | Copy URL на Sources (клік / ПКМ Copy) | `env.clipboard.writeText` |
| `OPEN_URL` | ПКМ на URL → Open in browser | `env.openExternal` (лише http/https) |
| `SET_SOURCE_ENABLED` | Toggle on/off | `kind: package` (за замовчуванням) → `<disabledPackageSources>`. `kind: audit` → лише `<auditSources>`. Effective: не копіює весь audit-ланцюг у nearest repo файл — один ключ у файлі, де він уже є / `<clear />`, інакше user `NuGet.Config` (`<clear />` + решта, якщо треба перебити machine). Файл: upsert/remove. Якщо файл не writable — warning toast, не тихий no-op. Не пише спільний disable-список. Потім `CONFIG_CHAIN_UPDATE` |
| `SET_SOURCE_CONNECTION_FLAGS` | Edit: HTTP / TLS checkboxes | Пише `allowInsecureConnections` / `disableTLSCertificateValidation` на `<add>`. Якщо файл не writable — warning toast, не тихий no-op. |
| `SET_SOURCE_SECRETS` | **Save credentials** / Enter на username/password/API key, × щоб зняти; не Windows: **Copy typed** копіює щойно введене як `export NUGET_API_KEY=…` (збережений ключ у webview не приходить) | Секрети пишуться в user/global `NuGet.Config`, не в repo. Не пише на blur/unmount. `url` — сирий `value` з XML (`%VAR%` не розгортати): NuGet шукає `<apikeys>` за цим рядком. Блок у workspace-файлі знімається. Windows `<apikeys>` DPAPI; не Windows `<clearTextApiKeys>`. Якщо declared path не writable і не machine — warning toast, не тихий no-op |
| `GET_LOG_ENTRIES` | Відкриття Log | Повний масив Logger |
| `START_TRACE` | ● Trace | Confirm, потім сесія в `globalStorage` |
| `STOP_TRACE` | ■ Stop & save zip | Sanitize → zip → Save dialog |
| `CLEAR_LOG` | Clear log | `Logger.clear()` + `LOG_CLEARED`. Не зупиняє trace |
| `SET_PACKAGE_BLOCKED` | Контекстне меню Block / Unblock | Пише `averenium.nugetManager.blockedPackages` у Workspace settings |
| `SHOW_TOAST` | Клік по недоступному **↑** (blocked) | `window.showInformationMessage` |
| `INSTALL_AGENT_SKILL` | Вкладка Agents **Install…** / **Update** | Без `updateExisting` — QuickPick. `updateExisting: true` — копія в уже встановлені outdated шляхи, без вибору папки. Потім `SKILL_STATUS` |
| `REFRESH_PACKAGES` | **UI не шле** | Handler є: refresh без restore і без очистки кешу |

## Host → Webview

| `type` | Коли шлеться | Обробка в reducer |
|---|---|---|
| `INIT_STATE` | Початок scope | Scope, sources, `configChain`, `snapshot` (effective / chain diffs / extra / conflicts), loading, `blockedPackages`, `traceRecording`, skill status (`detected` може бути `[]`), `roslynCap` (`null` якщо `csc -version` не вдався), `isWindows` (на Windows ховається Copy / tooltip для `<clearTextApiKeys>`) |
| `SKILL_STATUS` | Після Install… / Palette skill | `bundledVersion`, `detected`, `installs` |
| `INSTALLED_PACKAGES` | Після успішного `dotnet list` | Список + `isLoadingPackages: false`; оновлює `detail.projectVersions` для вибраного пакета |
| `IMPLICIT_PACKAGES` | Після `dotnet list` | Транзитивні |
| `INSTALLED_PACKAGES_PATCH` | Після fail add (успішні проєкти завжди; невдалі — лише `keep`) | Точкове оновлення version у списку й деталях |
| `PACKAGE_INFO_UPDATE` | Enrich по id | `latestVersion` + `sourceName` + `versions[]`; сортування: спочатку з оновленням |
| `ENRICH_PROGRESS` | `done/total` | Смужка Force refresh (`Refreshing latest n/m`); зникає коли `done >= total` |
| `VULNERABILITIES` | Після list (паралельно з enrich) | Findings для ⚠ і деталей; див. [vulnerabilities](vulnerabilities.md) |
| `VULN_SCAN_HINT` | Після скан (skip CLI); `show: false` після config update, якщо audit уже є | Sources / Audit: якщо skip і немає enabled `<auditSources>`. На вкладці Packages не показується |
| `BLOCKED_PACKAGES` | Після `SET_PACKAGE_BLOCKED` або зміни Workspace settings | Ids з `blockedPackages` |
| `SEARCH_RESULTS` | Пошук | Available-список |
| `PACKAGE_METADATA` | Деталі | Права панель |
| `ALL_VERSIONS` | Деталі | Dropdown версій |
| `ROSLYN_CAP` | Restore / Force refresh | Повторний `dotnet --version` + `csc -version`; `cap: null` якщо probe впав |
| `OPERATION_SUCCESS` | Install/remove ok | Скидає спінери / `globalError`; далі нові списки |
| `OPERATION_ERROR` | add/remove fail | Банер NU1605 з add; `rollbackApplied` / `canRollback`; списки `[]` не шле |
| `ROLLBACK_COMPLETE` | Після ручного rollback | Скидає банер і `pendingRollback` |
| `OPERATION_TIMEOUT` | CLI timeout (single) | Банер timeout, спінери скидаються |
| `BATCH_UPDATE_STARTED` | Початок batch | Вкладка Groups, таблиця queued |
| `BATCH_UPDATE_ITEM` | Кожен пакет у batch | pending → running → ok/error/timeout/cancelled |
| `BATCH_UPDATE_FINISHED` | Кінець batch | `finishedAt`, опційно `canRollback`, `cancelled` |
| `REFRESH_STARTED` | Restore / Force refresh | `kind: restore \| refresh`; смужка Restoring… / Refreshing… |
| `REFRESH_FINISHED` | Після restore + list + vuln | Restore: ховає смужку; refresh: лишає, якщо ще йде enrich |
| `LOG_ENTRIES` / `LOG_ENTRY_ADDED` | Log | Масив записів |
| `LOG_CLEARED` | Clear log | Порожній список |
| `TRACE_STATE` | Start/Stop trace | `recording` для беджа |
| `ERROR` | Пошук / metadata / list refresh / restore | Metadata → `detail.error`; list refresh / restore → `globalError` (restore не затирає `pendingRollback`) |
| `CONFIG_CHAIN_UPDATE` | Watcher nuget.config, Restore / Force refresh | `configChain` + `sources` + `snapshot`; без toast |
| `DOTNET_NOT_FOUND` | **Ніколи не шлеться** | Банер `dotnetMissing` у `App.tsx` |

## Кеш enrich

У broker: `Map<packageId, { latestVersion, sourceName, versions, fetchedAt }>`. Ключ без TFM / проєкту — ліміт `package search`, див. [backend](backend.md#межа-cli).

- TTL: `getConfig().cacheTtlMs` = 5 хвилин (не в settings).
- Hit: одразу `PACKAGE_INFO_UPDATE`.
- Miss: `enrichPackage` з лімітом `dotnetConcurrency`. Порожній search або throw — **один retry** після решти хвилі. Abort (FORCE_REFRESH) між хвилями доводить `ENRICH_PROGRESS` до `done === total`.
- Новий scope / `FORCE_REFRESH` / зміна prerelease — abort поточного job (`AbortController`) і `cache.clear()`.
- `RESTORE_PACKAGES` — abort enrich/vuln, `dotnet restore` + list, кеш latest лишається; заново читає SDK compiler (`ROSLYN_CAP`).

`GET_ALL_VERSIONS` віддає кешований список. Якщо TTL ще живий — CLI не викликається (сім’я Groups не штормить search після enrich). Якщо кеш порожній або протух — fetch і пост, лише коли список змінився.

Install після NU1605, rollback і patch: [install-and-rollback](install-and-rollback.md).  
Пакетні оновлення: [batch-updates](batch-updates.md).
