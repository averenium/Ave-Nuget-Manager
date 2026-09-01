# Ланцюжок nuget.config

Файли: `src/nugetConfigChainResolver.ts`, `src/sourcesSnapshot.ts`.  
UI: `src/webview/components/SourcesTab.tsx`.

## Resolve

`NuGetConfigChainResolver.resolve(startDir)`:

1. Починає з абсолютного `startDir` (директорія solution або проєкту).
2. У кожній директорії шукає файл з ім’ям `nuget.config` **без урахування регістру**.
3. Йде вгору до кореня диска. Зупиняється також, якщо поточна директорія — глобальний NuGet-каталог.
4. Додає глобальний config, якщо його ще немає в ланцюжку.

Порядок: **найближчий = індекс 0**, глобальний — останній.

Host також резолвить ланцюжок **кожного csproj/fsproj** у поточному scope і `findFiles('**/nuget.config')` з лімітом 200 (`extraConfigsTruncated` у знімку, Other показує примітку).

### Глобальні та machine-wide шляхи

| Платформа | User | Legacy user | Computer (`*.config`) |
|---|---|---|---|
| Windows | `%APPDATA%\NuGet` | — | `%ProgramFiles(x86)%\NuGet\Config` |
| macOS | `~/.config/NuGet` | `~/.nuget/NuGet` | `/Library/Application Support/NuGet/Config` |
| Linux | `~/.config/NuGet` | `~/.nuget/NuGet` | `/etc/opt/NuGet/Config` |

`NUGET_COMMON_APPLICATION_DATA/NuGet/Config` перебиває computer-шлях. Machine-wide файли — найдальші в ланцюжку (після user), у UI окрема секція **Machine** (як Installed / Implicit), read-only (без запису disabled/credentials). User config — секція **Global**. Solution/project — **Workspace**. Злитий вигляд — **Effective**.

## Парсинг XML

Без DOM, regex:

- Секція `<packageSources>` — `<add key="Name" value="url" />` → `PackageSource`. Читає `allowInsecureConnections` і `disableTLSCertificateValidation` (лише `true`). `protocolVersion` 2/3 — у рядку тихий бейдж **v2**, якщо явно 2 або URL не закінчується на `.json`. `<clear />` обрізає дальші файли (`packageSourcesCleared`).
- Секція `<disabledPackageSources>` — merge farthest → nearest. `<clear />` стирає батьківський список; `value="true"` вимикає, `value="false"` знову вмикає. Effective `enabled` береться з цього merge, не лише з того самого файлу, що оголосив `<add>`. У NuGet цей список спільний за ключем: вимкнений package `nuget.org` також вимикає audit з тим самим ім’ям. Toggle Audit у UI **не** пише сюди — інакше вимкнути audit = вимкнути package.
- Секція `<packageSourceMapping>` — merge farthest → nearest. `<clear />` стирає батьківські правила; той самий `key` повністю замінює список pattern. Порожній злитий список = mapping вимкнено.
- Секція `<auditSources>` — ті самі `<add>`; `<clear />` обрізає дальші файли. Effective-рядки після nearer `<clear />` лишаються в UI як disabled (`uniqueAuditSourcesWithSuppressed`), щоб їх можна було знову ввімкнути без `<disabledPackageSources>`.
- Секція `<packageSourceCredentials>` — лише **імена** ключів і **username** (`credentialKeys` / `credentialUsernames`). Імена елементів з `_xHHHH_` (пробіл → `_x0020_`) декодуються до ключа джерела. Паролі не читаються в webview. **Читання:** з усього ланцюжка (Effective і форма файлу показують наявність, якщо секрет є в user/global). **Запис:** не ближче за user/global `%APPDATA%\NuGet\NuGet.Config` (або `~/.config/NuGet`). Workspace `nuget.config` не отримує password / API key; якщо там уже був блок — його знімаємо, щоб він не перебивав user config. Windows — `Password` (DPAPI). macOS/Linux — `ClearTextPassword`. Порожній password на Save копіює наявний blob. `<clear />` у `<packageSourceCredentials>` репо все ще ховає батьківські credentials (NuGet); у цей файл секрети не пишемо.
- Секція `<apikeys>` — лише URL-ключі (`apiKeyUrls`), значення не шлються. **Запис Windows:** той самий DPAPI blob, що й `Password` (`AQAA…` Base64). Сирий GUID у value ламає `FromBase64String`. **Запис не Windows:** секція `<clearTextApiKeys>` (plaintext, той самий URL-ключ) — NuGet CLI не вміє розшифрувати `<apikeys>` поза Windows; пізніше Push з розширення читатиме це поле. Кнопка **Copy** (`export NUGET_API_KEY=…`) лише не на Windows.
- Помилка читання/парсингу → `parseError`, `sources: []`.
- `%VAR%` у `value` розгортається для відображення, kind, copy URL, порівняння URL у конфліктах і гейта `dotnet list --vulnerable` (NuGet 3.4+, навіть на Unix). Сирий рядок лишається в XML і в `urlRaw`. `$HOME` не розгортається. Імена змінних матчаться case-insensitive (добріше за CLI: `%home%` ≠ `%HOME%` у NuGet на Linux).

Не парсяться: fallbackPackageFolders.

## Дедуплікація джерел

`uniquePackageSources` / `uniqueEnabledPackageSources` / `uniqueAuditSources`: перша зустріч імені (case-insensitive) виграє — nearest config. `<clear />` у відповідній секції зупиняє дальші файли. Після збору імен `enabled` накладається з merged `disabledPackageSources`. `uniqueDeclaredAuditSources` цей merge пропускає — щоб rewrite `<auditSources>` не викидав add лише тому, що package-ключ вимкнений.

## Знімок Sources (`SourcesSnapshot`)

`buildSourcesSnapshot` (чиста функція):

1. **Effective** — unique package + audit джерела поточного scope: ON/OFF, kind (`nuget.org` / `data.nuget.org` / HTTP / local), «credentials set», copy URL. Якщо mapping увімкнено — `mappingPatterns` на рядку (порожній масив = unmapped).
2. **Chain** — відносний шлях без префікса типу; у UI файли згруповані в секції **Workspace** / **Global** / **Machine**; **що змінив файл** (added / replaced / disabled / clear / overridden), не другий повний список. Disable імені, якого немає в `<packageSources>` цього файлу, теж показується як `disabled`. `auditSources` лише якщо цей файл їх задав або зробив `<clear />`.
3. **Other nuget.config** — workspace-файли поза поточним ланцюжком: `applies` (діє на N проєктів) або `dead`. У знімку є `packageSources` / `auditSources` цього файлу (URL розгортає host), щоб клік по Other не шукав файл у `configChain` scope.
4. **Conflicts** (#36) на панелі Sources (не `globalError`):
   - той самий key → різні URL;
   - той самий URL → різні key в effective-наборі (не попереджає nuget.org + Global з тим самим URL);
   - `<clear />` прибирає батьківські **не-nuget.org** feeds (ізоляція від nuget.org / Global — не конфлікт);
   - auditSources solution ≠ проєкт;
   - файл поза ланцюжком, який усе ж застосовується до csproj.
5. **Audit hint** (#7) — ⚠ на вкладці Sources і на Effective, лише якщо немає working HTTP `<auditSources>` для не-nuget.org feeds. Off-chain `applies` сам по собі вкладку не мітить.

## Вкладка Sources

`SplitPane` 35/65: зліва конфіги секціями як пакети (Installed / Implicit) — **Effective**, **Workspace**, **Global**, **Machine**, порожні секції ховаються; Other — файли поза ланцюжком. Справа репозиторії цього вибору: рядок = ім’я + короткі позначки (`on`/`off`, `v2`, user, іконка API key, іконка HTTP, іконка skip-TLS, `unmapped`) + URL + patterns mapping. У **Effective** machine-wide package sources виносяться в секцію **Machine** після Audit (VS Offline тощо). Клік по Machine-файлу зліва показує його джерела як звичайний список; **Edit** на machine-wide ховається (запис у Program Files / `/etc` — no-op). **Edit** розгортає форму і підписує три цілі: Enable з Effective → `disabledPackageSources` у **найближчий** config; HTTP/TLS → файл `<add>` (`configFilePath`); credentials/API key → user `NuGet.Config` (**Save credentials** / Enter, не blur/unmount). Не Windows **Copy typed** копіює лише щойно введений ключ (збережений у панель не приходить). Ключ `<apikeys>` — `value` з XML (`urlRaw`), не розгорнутий URL. `%VAR%` розгортає host (`process.env`); webview env не чіпає. Якщо `nuget.config` відкритий (у т.ч. dirty), запис іде в буфер через `WorkspaceEdit` і save, не `writeFile` поверх диску. Toggle **package** з Effective пише `disabledPackageSources` у **найближчий** config (`value="true"` / `value="false"`), не в файл, що оголосив джерело. Toggle **audit** з Effective змінює один ключ: якщо він уже в workspace-файлі (або той файл має `<clear />`) — upsert/remove там; успадкований з user/machine — user `NuGet.Config` (за потреби `<clear />` + решта дальніх feeds). Не копіює весь audit-ланцюг у repo `nuget.config`. Вигляд файлу: upsert/remove. Не чіпає спільний disable-список. CLI все одно вимкне audit того ключа, якщо package вимкнений через `<disabledPackageSources>`. Mapping (#40): у **Edit** — поле patterns (comma-separated) + **Save mapping**, пише `setPackageSourceMappingPatterns` (`nugetConfigEdit.ts`) у `configFilePath` цього джерела (`SET_SOURCE_MAPPING`); порожнє значення прибирає блок цього source key, а не всю секцію (якщо лишились інші), `<clear />` не чіпає. Mapping-поле показується лише для `kind === 'package'` — `<packageSourceMapping>` не стосується `<auditSources>` взагалі, тож для audit-рядків його немає.

Add/remove (#48): **+ Add source** / **+ Add audit source** — невелика форма над списком (key + URL, для package ще чекбокс `NuGet v2 (OData)` → явний `protocolVersion="2"`, інакше атрибут не пишеться й діє авто-визначення за URL). Пише в `addSourceTargetPath` — вибраний файл, якщо `selection.kind === 'file'`, інакше найближчий workspace-конфіг (`chain[0]`); ховається для machine-wide вибору. **✕** на рядку package-джерела — повне видалення `<add>` (`removePackageSourceEntry`, `REMOVE_PACKAGE_SOURCE`), з підтвердженням другим кліком (4с). Немає окремої кнопки для audit — там **off**-toggle вже прибирає запис повністю (`removeAuditSource`), новий remove-шлях був би дублем. Правий клік по URL package-джерела, якого ще нема в Audit-списку, пропонує **Add as audit source** (`SourceUrlMenu`) — той самий `SET_SOURCE_ENABLED{kind:'audit', enabled:true}`, без нового broker-хендлера. Видалення джерела не чистить orphaned mapping/credentials/disabled-записи для того ж ключа в інших файлах ланцюжка — свідомо, як зазначено в issue.

## Живі оновлення

Host дивиться `**/nuget.config` (debounce 200 мс) і шле `CONFIG_CHAIN_UPDATE` (`configChain`, `sources`, `snapshot`). Те саме після Restore / Force refresh / зміни scope. Без toast на кожен save.
