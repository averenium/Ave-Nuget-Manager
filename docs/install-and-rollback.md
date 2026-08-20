# Install, помилки restore і rollback

Код: `src/webviewMessageBroker.ts` (`_finishInstallAttempts`), `src/projectFileSnapshot.ts`, `src/dotnetOutput.ts`, `src/config.ts`.  
Налаштування: `averenium.nugetManager.onFailedUpdate` (`rollback` | `keep`, default **`rollback`**).

`dotnet add` часто **спочатку змінює csproj** (і інколи `Directory.Packages.props`), потім робить restore. Restore може впасти (NU1605 TreatWarningsAsErrors / downgrade), навіть коли PackageReference уже новий. Іноді `exitCode` при цьому **0**.

## Що вважається успіхом add

`isCliOperationSuccess` (`src/dotnetOutput.ts`):

- не timeout;
- `exitCode === 0`;
- у stdout/stderr **немає** рядків `error:` і тексту `Failed to restore`.

Саме тому NU1605 у stdout не маскується під успіх.

## Текст помилки в UI

Банер показує вивід **`dotnet add`**, не наступний `dotnet list`.

`summarizeDotnetFailure` лишає:

- `error:` (NU1605 і граф `Project -> Package -> …`);
- `warn : NU1608` (конфлікт версій залежностей);
- `log : Failed to restore …`.

Відкидає X.509, CACHE, NU1903. Повний CLI-лог — вкладка Log.

`dotnet list` з .NET 10 без `--no-restore` після зламаного restore виходить з кодом 1 і JSON лише з `problems` (`"Restore failed. Run dotnet restore…"`). Це **не** підставляється замість NU1605. Host завжди викликає list з `--no-restore`, щоб показати поточні PackageReference навіть коли restore не проходить.

Окремо, при відкритті scope і на Restore / Force refresh, host паралельно запускає `dotnet restore`. Якщо він падає — банер **Restore failed** зі спойлером CLI (закритий за замовчуванням). Повний лог також на вкладці Log.

## Потік install / update

Один проєкт: `INSTALL_PACKAGE`. Кілька (попап у solution): `INSTALL_PACKAGE_MULTI`.

```
для кожного проєкту:
  1. snapshot csproj + найближчий Directory.Packages.props
  2. запам’ятати previousVersion з XML
  3. dotnet add … --version <target>   (multi — add паралельно після всіх snapshot)

якщо всі успішні:
  OPERATION_SUCCESS → dotnet list усього scope → INSTALLED_PACKAGES

якщо є fail:
  rollback або keep (див. нижче)
  OPERATION_ERROR (NU1605 з add, rollbackApplied / canRollback)
  refresh list з notifyListError: false
    — порожній/зламаний list НЕ затирає UI списками []
    — ERROR «Restore failed. Run dotnet restore» НЕ перетирає банер add
```

Snapshot робиться **до** будь-якого add, щоб спільний `Directory.Packages.props` не зняти вже зміненим.

## Режими `onFailedUpdate`

### `rollback` (default)

Для **невдалих** проєктів:

1. Записати знімки файлів назад.
2. `dotnet restore` цього проєкту.
3. Запис у Log: `rollback project files`.

Для **успішних** (частковий апдейт): `INSTALLED_PACKAGES_PATCH` з новою версією, щоб список і деталі не лишались на старій, навіть якщо `dotnet list` ще не відпрацював.

Невдалі після rollback у списку лишаються на `previousVersion`.

### `keep`

Файли не чіпаються. `INSTALLED_PACKAGES_PATCH` для успішних **і** невдалих (у csproj уже нова версія). Кнопка **Rollback** у банері шле `ROLLBACK_FAILED_UPDATE` → ті самі знімки + restore.

## Частковий успіх (2 проєкти, 1 впав)

| Місце | Очікування |
|---|---|
| Лівий список | Успішний — нова версія; невдалий — стара (`rollback`) або нова (`keep`) |
| `ProjectListSection` | Те саме: `useEffect` синхронізує select з `projectVersions` / `installed` після PATCH |
| Банер | NU1605 лише по failed; `succeededProjects` у `OPERATION_ERROR` |

Reducer на `INSTALLED_PACKAGES` / `INSTALLED_PACKAGES_PATCH` оновлює `detail.projectVersions` для вибраного пакета (порівняння шляхів через `pathsEqual`).

## Refresh після fail

`_applyListedPackages`:

- якщо list повернув пакети — шле `INSTALLED_PACKAGES` / `IMPLICIT_PACKAGES`;
- якщо порожньо **і** є `error` (restore JSON без `projects`) **або** це refresh після fail (`notifyListError: false`) — **нічого не шле**, попередній список лишається.

Примусовий Force refresh і Restore при зламаному restore покажуть банер list-помилки, але теж не замінять список на порожній.

## Банер UI

`App.tsx` + `.error-banner--operation`:

- заголовок + спойлер `▼ N` (закритий за замовчуванням), як у Log;
- відкритий вивід з `pre-wrap`, без горизонтального скролу;
- Rollback / Groups / Log / ✕ у рядку заголовка;
- `pendingRollback` лишає кнопку Rollback навіть після dismiss помилки (`keep`).

## Файли

| Файл | Роль |
|---|---|
| `src/projectFileSnapshot.ts` | Знімок / restore XML, читання Version з PackageReference / PackageVersion |
| `src/dotnetOutput.ts` | Успіх add, summary NU1605, `problems[]` з list JSON |
| `src/backend/cliBackend.ts` | `listAll*` повертає `error?`; `restoreProject` |
| `src/webviewMessageBroker.ts` | Оркестрація snapshot → add → rollback/patch → refresh |
| `src/webview/components/ProjectListSection.tsx` | Sync версії рядка після PATCH |
