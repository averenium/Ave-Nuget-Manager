# Backend і CLI

Усі NuGet-операції проходять через `INuGetBackend` (`src/backend/INuGetBackend.ts`). Єдина реалізація — `CliBackend` (`src/backend/cliBackend.ts`).

## INuGetBackend

| Метод | Призначення |
|---|---|
| `listAllForSolution` | Один `dotnet list <sln> … --include-transitive` на всю solution |
| `listAllForProject` | Те саме для одного проєкту — основний шлях refresh |
| `listInstalled` | `@deprecated` — окремий list без transitive |
| `listTransitive` | Окремий list з `--include-transitive` |
| `searchPackages` | Пошук по кожному config file, merge і дедуп за id |
| `getAllVersions` | `--exact-match`, merge, SemVer desc |
| `getMetadata` | Обмежені поля з `dotnet package search` |
| `enrichPackage` | Latest version + source + повний список версій |
| `installPackage` | `dotnet add` на SDK-style; broker на legacy csproj пише XML і кличе `restoreProject` |
| `removePackage` | `dotnet remove` на SDK-style; broker на legacy стирає вузли й кличе `restoreProject` |
| `restoreProject` | `dotnet restore` після rollback; також при відкритті scope (паралельно з list) |
| `listVulnerable` | `dotnet list … --vulnerable --include-transitive` |

## CliRunner

`src/cliRunner.ts`:

- `spawn('dotnet', args, { cwd, stdio, shell: win32 })`.
- Збирає stdout/stderr повністю.
- Timeout: `SIGTERM`, через 500 ms `SIGKILL`.
- Кожен виклик іде в `Logger.logCliOperation`.
- `checkDotnetAvailable()` — `dotnet --version`, timeout 10 с.

Timeout: list / search / `--version` / `--vulnerable` — **30 000 ms**. `add` / `remove` / `restore` — **120 000 ms** (restore-heavy). Timeout рахується від spawn, не від черги на слот.

`CliRunner` опційно бере `createConcurrencyGate` (ліміт `dotnetConcurrency`): усі `dotnet` процеси в процесі — add, remove, restore, list, search, enrich, `--vulnerable` — ділять **один** пул слотів. Інакше install 4 + enrich 4 + сім’я Groups (`GET_ALL_VERSIONS` × N id × M config files) знову штормлять CLI. `checkDotnetAvailable` теж іде через gate.

## Команди, які будує CliBackend

| Операція | Аргументи `dotnet` |
|---|---|
| List solution | `list <sln> package --include-transitive --format json --no-restore` |
| List project | `list <csproj> package --include-transitive --format json --no-restore` |
| Search | `package search <query> --configfile <cfg> --format json` + опційно `--prerelease` |
| Exact / versions / enrich / metadata | `package search <id> --exact-match --configfile <cfg> --format json` + опційно `--prerelease` |
| Install | `add <proj> package <id> --version <ver>` |
| Remove | `remove <proj> package <id>` |
| Restore | `restore <proj\|sln>` |
| Vulnerable | `list <path> package --vulnerable --include-transitive --format json --no-restore` |

`cwd` — директорія solution/проєкту або директорія `nuget.config`.

Помилка або timeout list/search **не кидає виняток**. `listAllForSolution` / `listAllForProject` повертають `{ installed, implicit, error? }`.

З **.NET 10** `dotnet list package` спочатку робить restore; якщо restore падає (NU1605 тощо), команда виходить з кодом 1 і JSON лише з `problems` (без `projects`). Тому всі list-виклики йдуть з **`--no-restore`**: читають уже наявний `project.assets.json` / PackageReference, навіть коли restore зламаний. Якщо assets немає і list усе одно порожній з `error`, host **не** перетворює це на `INSTALLED_PACKAGES: []`.

При відкритті solution/проєкту host **паралельно** ганяє `dotnet restore` і `dotnet list --no-restore`, щоб UI заповнився одразу зі старого `assets.json`. Кнопки Restore / Force refresh навпаки: спочатку `restore`, потім list і vuln scan — інакше `--no-restore` читає граф ще до запису assets. Restore **не** чистить кеш latest-версій; Force refresh чистить. Якщо restore падає — банер `Restore failed` з NU1605 (не затирає банер невдалого add / Rollback). Після install/remove повторний restore не запускається: `dotnet add` уже робить restore сам.

Успіх `dotnet add` — не лише `exitCode === 0`: див. `isCliOperationSuccess` у `src/dotnetOutput.ts`. Повний потік rollback / keep: [install-and-rollback](install-and-rollback.md).

## Парсинг JSON

`dotnet list --format json` → `projects[].frameworks[]`:

- `topLevelPackages` → `InstalledPackage` (пропускається `autoReferenced === "true"`).
- `transitivePackages` → `ImplicitPackage`.
- `framework` → `InstalledPackage.framework` / `ImplicitPackage.framework` (TFM, напр. `net8.0`). RID у list немає.

Після парсингу `stampListedDependencies` пише в `dependencies` id з restore-графа (`obj/project.assets.json`), досяжні серед installed + implicit — ⚠ на батьках implicit vulns і блок **Current Dependencies** у деталях. Див. [vulnerabilities](vulnerabilities.md), [webview](webview.md).

Поля `sourceName` і `latestVersion` у list **немає** — їх додає enrich (`package search`, не `list --outdated`). Search не знає TFM проєкту: latest — найвища версія на feed, одна на package id. ↑ / Groups / селектор можуть цілити в версію, яка на `net48` не restore-иться, тоді як на `net8.0` у тій самій solution — так. `dotnet list --outdated` уже фільтрує під TFM, CLI-шлях його не використовує.

`dotnet package search --format json` підтримує кілька форматів SDK:

- `latestVersion` (звичайний search);
- `version` (кожен об’єкт = одна версія при `--exact-match`);
- вкладений `versions: [{ version }]`.

## SemVer

`compareSemVer` / `compareSemVerDesc` експортовані з `cliBackend.ts`. Розбирають `major.minor.patch.build` і pre-release суфікс. Release > pre-release при рівній числовій частині.

## Concurrency

`src/concurrency.ts`:

- `runWithConcurrency(tasks, n)` — не більше `n` одночасних промісів, результати в порядку входу.
- `createConcurrencyGate(getLimit)` — спільна черга слотів. `CliRunner` тримає один gate на всі spawn.

`runWithConcurrency` ще обмежує окремі хвилі (щоб не стартувати сотні промісів, які всі чекають на gate):

- list кількох проєктів у project-scope refresh;
- фоновий enrich унікальних package id (помилка / порожня відповідь — один retry після хвилі);
- `dotnet add` / `dotnet remove` по багатьох проєктах (`INSTALL_PACKAGE_MULTI`, Groups fan-out одного пакета, `REMOVE_PACKAGE_MULTI`). Snapshot csproj / `Directory.Packages.props` лишається повністю паралельним.

Ліміт: `averenium.nugetManager.dotnetConcurrency` (1–16, default 4) — max parallel `dotnet` processes.

## Межа CLI

`getMetadata` заповнює id, version, authors, description, tags, projectUrl, licenseUrl.  
`dependencies` і `targetFrameworks` завжди `[]`.

`dotnet package search` не приймає TFM і не віддає граф сумісності. Enrich / `getAllVersions` тому не можуть відповісти «latest, який встає в цей `.csproj`». Це ліміт CLI, не баг запису PackageReference. Catalog API (майбутній HttpBackend) або `dotnet list --outdated` по проєкту — єдині шляхи відфільтрувати версії під `TargetFramework` / `TargetFrameworkVersion`.
