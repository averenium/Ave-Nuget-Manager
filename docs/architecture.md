# Архітектура

Розширення складається з двох процесів. UI не викликає `dotnet` і не читає файли проєктів — усе йде через extension host.

```
┌─────────────────────────────────────────────────────────┐
│  Extension Host (Node, dist/extension.js)               │
│                                                         │
│  CommandRegistrar ──► WebviewMessageBroker              │
│                           │                             │
│                           ├── INuGetBackend (CliBackend)│
│                           │       └── CliRunner         │
│                           ├── SolutionParser            │
│                           ├── NuGetConfigChainResolver  │
│                           └── Logger                    │
│                           │                             │
│                     NugetManagerViewProvider            │
│                           │ postMessage                 │
└───────────────────────────┼─────────────────────────────┘
                            │  messages.ts
┌───────────────────────────┼─────────────────────────────┐
│  Webview (React, dist/webview/bundle.js)                │
│                           │                             │
│                     NugetManagerContext                 │
│                           │                             │
│            PackagesTab / UpdatesTab / SourcesTab / LogTab           │
└─────────────────────────────────────────────────────────┘
```

## Шари

| Шар | Файли | Відповідальність |
|---|---|---|
| Activation | `src/extension.ts`, `src/dotnetWorkspace.ts` | Лінива активація (view/команда), видимість панелі, реєстрація view і команд |
| Commands | `src/commandRegistrar.ts` | Резолвить `.sln`/`.csproj` з URI або кореня workspace, викликає `activateScope` |
| View | `src/nugetManagerViewProvider.ts` | `WebviewViewProvider`, HTML/CSP, `postMessage`, відкладені handlers |
| Broker | `src/webviewMessageBroker.ts` | Маршрутизація, init, refresh, enrich-кеш, install/remove/rollback, batch update, vulns |
| Vulnerabilities | `src/vulnerabilities.ts`, `src/vulnerabilityProvider.ts` | `dotnet list --vulnerable` + user script |
| Batch | `src/batchUpdates.ts`, `src/packageFamily.ts` | Update all і родини `Microsoft.**.**` |
| Snapshot | `src/projectFileSnapshot.ts` | Знімок csproj / Directory.Packages.props перед зміною PackageReference та `dotnet add |
| Legacy csproj | `src/projectPackageStyle.ts`, `src/legacyPackageReference.ts` | Без `Sdk=`: XML upsert; `packages.config` skip лише без PackageReference |
| CLI output | `src/dotnetOutput.ts`, `src/cliRetry.ts` | Успіх add, summary NU1605, parse `problems` з list; retry group `dotnet add` за NU/HTTP-фразами в CLI |
| Backend | `src/backend/` | Усі NuGet-операції через абстракцію `INuGetBackend` |
| CLI | `src/cliRunner.ts` | `spawn('dotnet')`, timeout, логування |
| Solution | `src/solutionParser.ts` | Список проєктів з `.sln` / `.slnx` |
| Config | `src/nugetConfigChainResolver.ts` | Ланцюжок `nuget.config` nearest → global |
| Types | `src/types.ts` | Scope, пакети, sources, log, CLI |
| Protocol | `src/messages.ts` | Дискриміновані union-типи в обидва боки |
| UI | `src/webview/` | React 19, Vite-бандл |

## Scope

Робочий контекст — `WorkspaceScope` у `src/types.ts`:

- `{ kind: 'solution'; solutionPath; projects }` — усі `.csproj`/`.fsproj` з solution.
- `{ kind: 'project'; projectPath }` — один проєкт.

Від scope залежить:

- який `dotnet list` викликається (solution vs project);
- чи install/remove йде в один файл, чи через попап вибору проєктів;
- з якої директорії резолвиться ланцюжок `nuget.config`.

Поведінка після невдалого `dotnet add` (NU1605, rollback, patch списку): [install-and-rollback](install-and-rollback.md).

## Принцип залежностей

Споживчий код (`WebviewMessageBroker`) залежить лише від `INuGetBackend`, не від `CliBackend`. Коментар у інтерфейсі передбачає майбутній `HttpBackend` (NuGet HTTP API v3). Зараз реалізація одна — CLI.

## Збірка двох світів

| Ціль | Компілятор | Вихід |
|---|---|---|
| Host | `tsc -p tsconfig.json` (CommonJS, ES2022) | `dist/*.js` |
| Webview | Vite + `@vitejs/plugin-react` | `dist/webview/bundle.js` (+ watch перезбирає бандл) |

`tsconfig.json` виключає `src/webview/**`. Webview має окремий `tsconfig.webview.json` (`noEmit`, JSX). Спільні типи — `src/types.ts` і `src/messages.ts`.
