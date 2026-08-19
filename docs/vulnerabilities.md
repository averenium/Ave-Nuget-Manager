# Вразливості

Код: `src/vulnerabilities.ts`, `src/vulnerabilityProvider.ts`, `src/userScriptVulnerabilities.ts`, `CliBackend.listVulnerable`, вкладка Packages.

Після `dotnet list` host паралельно з enrich збирає findings і шле `VULNERABILITIES`. Список пакетів показує **⚠** і піднімає вразливі id вгору (спочатку прямі, потім через залежності, потім оновлення). У деталях пакета — секція Vulnerabilities з посиланням на advisory.

Finding на **implicit** пакеті також позначає installed (і інші implicit), які тягнуть його в графі restore (`project.assets.json` → `dependencies`). Прямий ⚠ — колір error; лише через залежність — warning. Tooltip / деталі: `via Newtonsoft.Json · HIGH: GHSA-…`. Клік по `via …` у деталях відкриває той пакет.

## Провайдери

`IVulnerabilityProvider.scan(ctx)` → `VulnerabilityFinding[]`. Зараз два:

| id | Джерело |
|---|---|
| `dotnet` | `dotnet list <sln\|csproj> package --vulnerable --include-transitive --format json --no-restore` |
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

Новий провайдер у коді — ще одна реалізація `IVulnerabilityProvider` у `collectVulnerabilityFindings` (OSV/GHSA HTTP пізніше).
