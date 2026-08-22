# Вразливості

Код: `src/vulnerabilities.ts`, `src/vulnerabilityProvider.ts`, `src/userScriptVulnerabilities.ts`, `CliBackend.listVulnerable`, вкладка Packages.

Після `dotnet list` host паралельно з enrich збирає findings і шле `VULNERABILITIES`.

`dotnet list --vulnerable` без `<auditSources>` читає **registration кожного package source**. На nuget.org там є GHSA; на Nexus — немає, плюс GET на кожен пакет. CLI стартує коли:

- усі HTTP package sources — nuget.org / `data.nuget.org`; або
- є хоч один HTTP `<auditSources>` (CLI тоді йде в VDB і **не** чіпає package registration, навіть якщо audit порожній).

Інакше skip: матч VDB з HTTP-кешу restore + `NU1901`–`NU1904` поточного restore (лише id зі списку) + скрипт. Не `globalError`.

Список пакетів показує **⚠** і піднімає вразливі id вгору (спочатку прямі, потім через залежності, потім оновлення). У деталях пакета — секція Vulnerabilities з посиланням на advisory.

Finding на **implicit** пакеті також позначає installed (і інші implicit), які тягнуть його в графі restore (`project.assets.json` → `dependencies`). Прямий ⚠ — колір error; лише через залежність — warning. Tooltip / деталі: `via Newtonsoft.Json · HIGH: GHSA-…`. Клік по `via …` у деталях відкриває той пакет.

## Провайдери

`IVulnerabilityProvider.scan(ctx)` → `VulnerabilityFinding[]`. Зараз два:

| id | Джерело |
|---|---|
| `dotnet` | `dotnet list … --vulnerable` (лише nuget.org-only HTTP feeds або робочий `<auditSources>`) |
| `nuget-cache` | Сторінки VDB в HTTP-кеші restore, якщо CLI пропущено |
| `script` | опційний файл з settings |

Результати **мерджаться** (`packageId` + version + advisory id/url). Падіння одного провайдера не прибирає findings інших.

Контракт finding:

```json
{
  "packageId": "Newtonsoft.Json",
  "version": "12.0.1",
  "severity": "critical | high | moderate | low | unknown",
  "id": "GHSA-…",
  "title": "optional",
  "url": "https://github.com/advisories/…",
  "source": "dotnet"
}
```

`source` для скрипта підставляється як ім’я файлу, якщо скрипт його не задав.

## Користувацький скрипт

Setting `averenium.nugetManager.vulnerabilityScript` — абсолютний шлях або відносно кореня workspace.

- `.js` / `.mjs` / `.cjs` → `node <file>`
- `.py` → `python <file>`
- інакше файл запускається як executable

stdin — JSON snapshot поточного scope:

```json
{
  "scope": { "kind": "solution", "solutionPath": "…", "projects": [] },
  "installed": [],
  "implicit": []
}
```

stdout — JSON-масив findings або `{ "findings": [ … ] }`. Timeout 30 с. Лог — вкладка Log.

Приклад (`audit.js`):

```js
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const extra = [];
for (const pkg of [...input.installed, ...input.implicit]) {
  if (pkg.id.toLowerCase() === 'contoso.legacy') {
    extra.push({
      packageId: pkg.id,
      version: pkg.resolvedVersion,
      severity: 'high',
      id: 'internal-1',
      title: 'Banned package',
    });
  }
}
process.stdout.write(JSON.stringify(extra));
```

Новий провайдер у коді — ще одна реалізація `IVulnerabilityProvider` у `collectVulnerabilityFindings` (OSV/GHSA HTTP пізніше). Повний HTTP catalog VDB (#27 / HttpBackend) **не** качається в цьому шарі.

## Коли CLI `--vulnerable` запускається

| Package sources | Audit sources | CLI |
|---|---|---|
| Немає HTTP / лише локальні | будь-які | так |
| Лише nuget.org | будь-які | так |
| Є не-nuget.org HTTP | хоч один HTTP `<auditSources>` | так (VDB path; порожній audit → warning, не registration) |
| Є не-nuget.org HTTP | немає | **ні** — кеш / NU190x |

nuget.org + Nexus **без** audit → skip. Quiet hint на Sources при skip. Packages — короткий рядок лише якщо ще немає ⚠.

HTTP-кеш: `%LOCALAPPDATA%\NuGet\v3-cache` (Windows); на Unix/macOS — `~/Library/Caches/NuGet/…`, `~/.cache/…`, `~/.local/share/NuGet/v3-cache`.
