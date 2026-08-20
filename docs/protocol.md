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
                             → INIT_STATE (scope, sources, configChain, includePrerelease, blockedPackages)
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
| `SEARCH_PACKAGES` | Пошук ≥2 символи | `searchPackages`; config files беруться з поточного scope, не з payload |
| `SET_PRERELEASE_SETTING` | Чекбокс Pre-release | Пише Global settings, чистить кеш, refresh |
| `GET_PACKAGE_METADATA` | `VersionSelector` | `getMetadata` |
| `GET_ALL_VERSIONS` | `VersionSelector` / сім’я Groups | Кеш (TTL 5 хв); інакше `getAllVersions` |
| `INSTALL_PACKAGE` | Один проєкт | Snapshot файлів → `dotnet add` → успіх або rollback/patch; див. [install-and-rollback](install-and-rollback.md) |
| `REMOVE_PACKAGE` | Один проєкт | `dotnet remove`, потім refresh scope |
| `INSTALL_PACKAGE_MULTI` | Попап у solution | Snapshot усіх проєктів, потім add з лімітом `dotnetConcurrency` |
| `REMOVE_PACKAGE_MULTI` | Попап у solution | Remove з лімітом `dotnetConcurrency`; refresh усієї solution |
| `ROLLBACK_FAILED_UPDATE` | Кнопка Rollback (`onFailedUpdate: keep`) | Відновлює знімки невдалих проєктів + restore |
| `UPDATE_PACKAGES_BATCH` | Update all / family / other | Послідовний add по пакетах; див. [batch-updates](batch-updates.md) |
| `CANCEL_BATCH_UPDATE` | Stop (■) замість Update в заголовку групи | Аборт поточного `dotnet add`, решта пакетів `cancelled` |
| `RESTORE_PACKAGES` | Іконка пакета (Restore) | Restore → list → vuln; смужка Restoring… до `REFRESH_FINISHED`; кеш latest лишається |
| `FORCE_REFRESH` | Кругова стрілка (Force refresh) | Те саме з очищенням кешу; смужка далі показує enrich latest |
| `OPEN_CONFIG_FILE` | Вкладка Sources | `openTextDocument` |
| `GET_LOG_ENTRIES` | Відкриття Log | Повний масив Logger |
| `SET_PACKAGE_BLOCKED` | Контекстне меню Block / Unblock | Пише `averenium.nugetManager.blockedPackages` у Workspace settings |
| `SHOW_TOAST` | Клік по недоступному **↑** (blocked) | `window.showInformationMessage` |
| `REFRESH_PACKAGES` | **UI не шле** | Handler є: refresh без restore і без очистки кешу |

## Host → Webview

| `type` | Коли шлеться | Обробка в reducer |
|---|---|---|
| `INIT_STATE` | Початок scope | Scope, sources, loading, `blockedPackages` |
| `INSTALLED_PACKAGES` | Після успішного `dotnet list` | Список + `isLoadingPackages: false`; оновлює `detail.projectVersions` для вибраного пакета |
| `IMPLICIT_PACKAGES` | Після `dotnet list` | Транзитивні |
| `INSTALLED_PACKAGES_PATCH` | Після fail add (успішні проєкти завжди; невдалі — лише `keep`) | Точкове оновлення version у списку й деталях |
| `PACKAGE_INFO_UPDATE` | Enrich по id | `latestVersion` + `sourceName`; сортування: спочатку з оновленням |
| `ENRICH_PROGRESS` | `done/total` | Смужка Force refresh (`Refreshing latest n/m`); зникає коли `done >= total` |
| `VULNERABILITIES` | Після list (паралельно з enrich) | Findings для ⚠ і деталей; див. [vulnerabilities](vulnerabilities.md) |
| `BLOCKED_PACKAGES` | Після `SET_PACKAGE_BLOCKED` або зміни Workspace settings | Ids з `blockedPackages` |
| `SEARCH_RESULTS` | Пошук | Available-список |
| `PACKAGE_METADATA` | Деталі | Права панель |
| `ALL_VERSIONS` | Деталі | Dropdown версій |
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
| `ERROR` | Пошук / metadata / list refresh / restore | Metadata → `detail.error`; list refresh / restore → `globalError` (restore не затирає `pendingRollback`) |
| `CONFIG_CHAIN_UPDATE` | **Ніколи не шлеться** | Handler у reducer є |
| `DOTNET_NOT_FOUND` | **Ніколи не шлеться** | Банер `dotnetMissing` у `App.tsx` |

## Кеш enrich

У broker: `Map<packageId, { latestVersion, sourceName, versions, fetchedAt }>`.

- TTL: `getConfig().cacheTtlMs` = 5 хвилин (не в settings).
- Hit: одразу `PACKAGE_INFO_UPDATE`.
- Miss: `enrichPackage` з лімітом `dotnetConcurrency`. Порожній search або throw — **один retry** після решти хвилі. Abort (FORCE_REFRESH) між хвилями доводить `ENRICH_PROGRESS` до `done === total`.
- Новий scope / `FORCE_REFRESH` / зміна prerelease — abort поточного job (`AbortController`) і `cache.clear()`.
- `RESTORE_PACKAGES` — abort enrich/vuln, `dotnet restore` + list, кеш latest лишається.

`GET_ALL_VERSIONS` віддає кешований список. Якщо TTL ще живий — CLI не викликається (сім’я Groups не штормить search після enrich). Якщо кеш порожній або протух — fetch і пост, лише коли список змінився.

Install після NU1605, rollback і patch: [install-and-rollback](install-and-rollback.md).  
Пакетні оновлення: [batch-updates](batch-updates.md).
