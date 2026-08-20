# Пакетні оновлення

Код: `src/batchUpdates.ts`, `src/packageFamily.ts`, `src/webviewMessageBroker.ts` (`_handleUpdateBatch`), вкладка `UpdatesTab`.

Дві дії в UI, обидві використовують **той самий latest**, що вже порахований enrich з урахуванням галочки Pre-release.

## Pre-release

`SET_PRERELEASE_SETTING` чистить кеш і перезапитує latest. На вкладці **Groups** (і Packages) галочка Pre-release задає, що вважати latest:

- увімкнена → ціль може бути `9.0.0-preview.*`;
- вимкнена → лише стабільні.

Host не перераховує latest: виконує `items[].toVersion`, які зібрав UI.

## Вкладка Groups

Увесь batch-UI на вкладці **Groups**, той самий `SplitPane` / `pkg-row` / `DetailHeader`, що Packages. Оновлення — іконка **↑**; під час batch вона замінюється на **■** (Stop) у тому ж місці. Версію обирає кастомний `VersionSelect` (нативний `<select>` у webview розпирає панель довгими prerelease).

За замовчуванням список пакетів **не** показується. Зліва групи:

- **All** — усі пакети з новішим latest (у кожного своя ціль); рядок без версії;
- **Families** — `Microsoft.Extensions.*` тощо, 2+ id на одній поточній версії; рядок завжди `from → suggested`;
- **Other** (останній рядок) — updatable пакети, яких немає в жодній сім’ї; як All, без версії на рядку.

Клік по рядку відкриває справа: `from → to` і **↑**. Для сім’ї є **селектор спільної версії** (перетин `GET_ALL_VERSIONS` по членах; доки списки не прийшли — suggested latest). Усі члени сім’ї йдуть на обрану версію. All / Other — кожен id на свою latest.

History після запуску — під прев’ю. Одиночний update/install лишається в деталях Packages.

## 1. All

Рядок **All** зліва (назва + count, без from/latest). Справа — пакети, де `latest > resolved`; кожен id на свою latest. Кнопка Update.

## 2. Family (`Microsoft.**.**`)

Родина = перші два сегменти id (`Microsoft.Extensions.Logging` і корінь `Microsoft.EntityFrameworkCore` → `Microsoft.EntityFrameworkCore`). Самотній `Newtonsoft.Json` (немає `Newtonsoft.Json.*` на тій самій версії) у родину не входить.

Група: **2+ різних id** з тієї самої родини **на одній resolved-версії**. Справа обирається **одна** цільова версія для всієї сім’ї.

## 3. Other

Останній рядок зліва. Пакети, які **не** входять у жодну сім’ю (самотній `Newtonsoft.Json` без `Newtonsoft.Json.*`, або один `Microsoft.Extensions.Logging` без пари на тій самій версії). Працює як All: кожен id на свою latest.

## Виконання

`UPDATE_PACKAGES_BATCH`: пакети **послідовно** (щоб не писати один csproj паралельно). Проєкти одного пакета — як і раніше, паралельний `dotnet add`. Rollback / keep — ті самі правила, що для одиночного add ([install-and-rollback](install-and-rollback.md)); batch не зупиняється на першій помилці.

**Stop (■)** замінює **↑** у заголовку групи і шле `CANCEL_BATCH_UPDATE`: host убиває поточний `dotnet add` (`AbortSignal` у `CliRunner`), відновлює знімки цього add (навіть при `onFailedUpdate: keep`), поточний пакет → `cancelled`, решта queued → `cancelled` без CLI. Stop не банер помилки і не Rollback.

Прогрес: `BATCH_UPDATE_STARTED` → `BATCH_UPDATE_ITEM` → `BATCH_UPDATE_FINISHED` (History на тій самій вкладці).

### Changelogs і breaking changes (заплановано)

З CLI (`dotnet package search` / `dotnet add`) **немає** release notes і diff між версіями. У вкладці заглушки немає.

Коли з’явиться HttpBackend (NuGet HTTP API v3):

1. catalog/registration leaf для `from` і `to`;
2. поле `releaseNotes` / README, якщо є в nuspec;
3. евристика breaking changes (major bump SemVer, ключові слова в notes) — окремо, не як гарантія.

Поки що джерело правди — вкладка Groups (що поставили) + Log (повний CLI).
