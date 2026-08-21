# Пакетні оновлення

Код: `src/batchUpdates.ts`, `src/packageFamily.ts`, `src/webviewMessageBroker.ts` (`_handleUpdateBatch`), вкладка `UpdatesTab`.

Дві дії в UI, обидві використовують **той самий latest**, що вже порахований enrich з урахуванням галочки Pre-release.

## Pre-release

`SET_PRERELEASE_SETTING` чистить кеш і перезапитує latest. За замовчуванням галочка **вимкнена**. На вкладці **Groups** (і Packages) вона задає, що вважати latest:

- увімкнена → ціль може бути `9.0.0-preview.*`;
- вимкнена → лише стабільні.

Host не перераховує latest: виконує `items[].toVersion`, які зібрав UI.

## Вкладка Groups

Увесь batch-UI на вкладці **Groups**, той самий `SplitPane` / `pkg-row` / `DetailHeader`, що Packages. Оновлення — іконка **↑**; під час batch вона замінюється на **■** (Stop) у тому ж місці. Версію обирає кастомний `VersionSelect` (нативний `<select>` у webview розпирає панель довгими prerelease).

За замовчуванням список пакетів **не** показується. Зліва групи:

- **All** — усі пакети з новішим latest (у кожного своя ціль); рядок без версії;
- **Families** — `Microsoft.Extensions.*` тощо, 2+ id на одній поточній версії; рядок завжди `from → suggested`;
- **Other** (останній рядок) — updatable пакети, яких немає в жодній сім’ї; як All, без версії на рядку.

Лічильники зліва **не** включають ids з `blockedPackages`. Прев’ю справа їх лишає: приглушені, **⊘**, без зеленого `from → to`. **↑** групи шле лише незаблоковані; якщо всі blocked — кнопка disabled.

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

`UPDATE_PACKAGES_BATCH`: пакети **послідовно** (щоб не писати один csproj паралельно). Проєкти одного пакета — `dotnet add` з лімітом `dotnetConcurrency`. Rollback / keep — ті самі правила, що для одиночного add ([install-and-rollback](install-and-rollback.md)); batch не зупиняється на першій помилці.

Якщо `dotnet add` падає **тимчасово**, host робить **ще одну** спробу того самого id/версії (пауза 750 мс). Між спробами знімки **не** відкочуються: другий add або дописує PackageReference, або лише restore. Rollback / keep — лише коли обидві спроби провалились. Stop / `cancelled` не ретраїться.

Ретрай (`src/cliRetry.ts`) дивиться **текст `dotnet add`** (NU-коди й HTTP-фрази у stdout/stderr). Catalog HTTP API v3, коли з’явиться, ретраїть у `HttpBackend`, не тут.

| Сигнал | Чому |
|---|---|
| `CliResult.timedOut` | Host убив процес (30 с), як `MongoDB.Driver` / `Operation timed out` |
| **NU1301** | Бліп service index / remote source |
| HTTP **429 / 502 / 503** | Throttle / feed |
| `connection reset`, `HttpRequestException`, `The HTTP request … timed out`, `TaskCanceledException` | Мережа |
| `being used by another process` / lock на global NuGet cache | Паралельний `dotnet add` |

Не ретраїти: Stop; **NU1605** / **NU1608**; **NU1101 / NU1102 / NU1103**; **NU1107**; **NU1201 / NU1202**; **NU1302**; **401 / 403**; `dotnet` немає в PATH.

Одиночний Install у Packages цей цикл не використовує.

**Stop (■)** замінює **↑** у заголовку групи і шле `CANCEL_BATCH_UPDATE`: host убиває поточний `dotnet add` (`AbortSignal` у `CliRunner`), відновлює знімки цього add (навіть при `onFailedUpdate: keep`), поточний пакет → `cancelled`, решта queued → `cancelled` без CLI. Stop не банер помилки і не Rollback.

Прогрес: `BATCH_UPDATE_STARTED` → `BATCH_UPDATE_ITEM` → `BATCH_UPDATE_FINISHED` (History на тій самій вкладці).

### Changelogs і breaking changes (заплановано)

З CLI (`dotnet package search` / `dotnet add`) **немає** release notes і diff між версіями. У вкладці заглушки немає.

Коли з’явиться HttpBackend (NuGet HTTP API v3):

1. catalog/registration leaf для `from` і `to`;
2. поле `releaseNotes` / README, якщо є в nuspec;
3. евристика breaking changes (major bump SemVer, ключові слова в notes) — окремо, не як гарантія.

Поки що джерело правди — вкладка Groups (що поставили) + Log (повний CLI).
