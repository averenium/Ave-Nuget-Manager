# Незавершене

Проєкт свідомо неповний. Нижче — розриви між типами/UI і фактичною поведінкою host.

## Запланований HttpBackend

`INuGetBackend` і коментарі в `cliBackend.getMetadata` передбачають NuGet HTTP API v3. Без нього:

- `PackageMetadata.dependencies` завжди `[]`;
- `targetFrameworks` завжди `[]`;
- `published` не заповнюється.

Розмітка для catalog Dependencies / TFM / published у `PackageDetailPanel` уже є. Restore-граф поточної версії показується окремо як **Current Dependencies**.

Changelogs і breaking changes після batch-оновлення теж потребують catalog API — план у [batch-updates](batch-updates.md).

Retry 429/503 на catalog GET — у `HttpBackend`, не в `cliRetry` (той лише парсить вивід `dotnet add`).

## Граф транзитивних залежностей

`ImplicitPackage.dependsOn` і `InstalledPackage.implicitVersions` є в типах. `CliBackend` їх не ставить: `dotnet list` не віддає parent. `InstalledList` групує implicit «за parent», тому підказка `(highestImplicit)` у `PackageRow` ніколи не з’являється.

## Протокол, який не живе

| Елемент | Стан |
|---|---|
| `DOTNET_NOT_FOUND` | Банер у `App.tsx` є; `activate()` лише логує відсутність SDK |
| `CONFIG_CHAIN_UPDATE` | Reducer є, host не шле |
| `REFRESH_PACKAGES` | Handler є, UI шле `RESTORE_PACKAGES` / `FORCE_REFRESH` |

## Settings

`cacheTtlMs` (5 хв) захардкоджений у `config.ts`, у `contributes.configuration` його немає.

`onFailedUpdate` уже в settings і в коді — [install-and-rollback](install-and-rollback.md).

## UI-мертвий код

- `src/webview/components/SearchBar.tsx` — дубль пошуку, `PackagesTab` має власний input.
- `getState` / `setState` у `vscodeApi.ts` не використовуються.

## Обмеження scope

- Лише `.csproj` / `.fsproj`, немає `.vbproj`.
- Немає рекурсивного пошуку проєктів у підпапках.
- Лише `workspaceFolders[0]`.
- Sources — read-only (немає CRUD джерел).

## Інфра

- Скрипт `lint` без пакета eslint.
- `vitest` і Testing Library в залежностях без тестів UI.
- Кореневий `README.md` — текст Marketplace; ця папка `docs/` — внутрішній опис реалізації.
