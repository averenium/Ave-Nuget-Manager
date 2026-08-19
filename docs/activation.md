# Активація і команди

## Activation

`package.json`: `activationEvents: ["onStartupFinished"]`, точка входу `./dist/extension.js`.

`activate()` у `src/extension.ts`:

1. Створює `Logger`, `CliRunner`, `CliBackend`, `SolutionParser`, `NuGetConfigChainResolver`.
2. Викликає `runner.checkDotnetAvailable()` (`dotnet --version`). Помилка **не блокує** активацію — пишеться в лог. Повідомлення `DOTNET_NOT_FOUND` у webview **не надсилається** (див. [incomplete](incomplete.md)).
3. Реєструє `NugetManagerViewProvider` як `WebviewViewProvider` для `averenium.nugetManagerView` з `retainContextWhenHidden: true`.
4. Створює `WebviewMessageBroker`, викликає `attach()`.
5. `CommandRegistrar.register(context)`.

`deactivate()` dispose’ить logger.

## View provider

`src/nugetManagerViewProvider.ts` — панель у `viewsContainers.panel` (`averenium-nuget-panel`).

Особливості життєвого циклу:

- `onDidReceiveMessage()` можна викликати **до** `resolveWebviewView()`. Handlers зберігаються і перереєстровуються, коли view з’являється.
- HTML збирається один раз (`_htmlBuilt`). Повторне присвоєння `webview.html` зламало б React через `retainContextWhenHidden`.
- CSP: `default-src 'none'`, скрипти/стилі з nonce, картинки з `https:` і `data:`.
- Скрипт і CSS — `dist/webview/bundle.js` / `bundle.css` через `asWebviewUri`.

Публічне API: `setScope`, `getCurrentScope`, `postMessage`, `onDidReceiveMessage`, `setOnViewReady`, `isVisible`.

## Команда відкриття

Команда: `averenium.nugetManager.open`  
Заголовок: «C# Solution / C# Project: NuGet Management».

Контекстне меню Explorer (`when`):

```
resourceExtname =~ /\.(sln|slnx|csproj|fsproj)$/ || explorerResourceIsFolder
```

Підтримувані розширення: `.sln`, `.slnx`, `.csproj`, `.fsproj`. `.vbproj` немає.

### Резолв цілі (`CommandRegistrar`)

| Вхід | Поведінка |
|---|---|
| Клік по файлу з відомим розширенням | Відкрити цей файл |
| Клік по папці | Лише **прямі** дочірні файли (без рекурсії). 0 збігів — warning; 1 — відкрити; кілька — якщо рівно один solution, взяти його, інакше QuickPick |
| Command Palette (без URI) | Те саме в корені `workspaceFolders[0]` |

Multi-root workspace не підтримується: завжди перша папка.

Після резолву:

- `.sln`/`.slnx` → `SolutionParser.getProjects()` → scope `solution`;
- інакше → scope `project`;
- `broker.activateScope(scope)`;
- `averenium.nugetManagerView.focus`.

## Автодетект без команди

Якщо webview шле `WEBVIEW_READY`, а scope ще немає, broker сканує корінь workspace: спочатку `.sln`/`.slnx`, інакше `.csproj`/`.fsproj`. Якщо нічого немає — `INIT_STATE` з порожнім `projectPath`.
