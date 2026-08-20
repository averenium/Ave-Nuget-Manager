# Активація і команди

## Activation

`package.json` `activationEvents`:

- `workspaceContains:*.sln` / `*.slnx` / `*.csproj` / `*.fsproj` і ті самі з `**/` — щоб у .NET папці розширення стартувало **без** відкриття вкладки і могло поставити context key;
- `onView:averenium.nugetManagerView` і команди `open` / `openInEditor` / `openInNewWindow` / `installAgentSkill` / `startTrace` / `stopTrace` / `clearLog`.

**`onStartupFinished` немає.** У папці без `.sln`/`.csproj` JS не вантажиться. У .NET папці `activate()` ставить видимість вкладки (`findFiles`, без `dotnet`). Restore / list / enrich — лише після `WEBVIEW_READY`.

`activate()` у `src/extension.ts`:

1. `Logger`
2. `watchDotnetWorkspaceContext()` — `setContext('averenium.nugetManager.hasDotnetWorkspace')` + watcher
3. Сервіси, реєстрація view provider і команд. **Не** викликає `dotnet --version`.

| Коли | Що |
|---|---|
| `activate()` (workspaceContains або команда) | `findFiles` + context key. Без restore/list. |
| Перший `WEBVIEW_READY` | `dotnet --version` (лог, не блокує), auto-detect scope, restore, list, enrich, vuln |
| Повторний `WEBVIEW_READY` (переміщення view, editor tab) | Знову init (list/restore). `dotnet --version` не повторюється |

Якщо вкладка NuGet лишилась відкритою з минулої сесії, VS Code відновлює view → `onView` активує розширення — це очікувано.

`deactivate()` dispose’ить logger.

## Видимість панелі

Вкладка **NuGet** у нижній панелі (`viewsContainers.panel` / `averenium-nuget-panel`).

`when` на **view** (не на контейнері — у schema контейнера немає `when`):

```
averenium.nugetManager.hasDotnetWorkspace && !averenium.nugetManager.editorOpen
```

`workspaceContains` у `when` **не** є context key (це activation event). Якщо поставити його в `when`, умова завжди false → вкладка зникає назавжди і `onView` ніколи не стріляє.

`editorOpen` ховає нижню вкладку, поки UI живе в editor tab / окремому вікні (один живий UI).

Перетягування: **title bar** вкладки (не webview). `View: Move View` / `Move Focused View` — Panel, Primary Sidebar, Secondary Sidebar. Після move VS Code dispose + `resolveWebviewView`; HTML збирається знову, React шле `WEBVIEW_READY`, broker знову робить init.

## View provider

`src/nugetManagerViewProvider.ts` — `WebviewView` (панель) або `WebviewPanel` (`averenium.nugetManager.editor`).

- `onDidReceiveMessage()` можна викликати **до** `resolveWebviewView()`. Handlers перев’язуються на активний webview.
- CSP: `default-src 'none'`, скрипти/стилі з nonce, картинки з `https:` і `data:`.
- Скрипт і CSS — `dist/webview/bundle.js` / `bundle.css` через `asWebviewUri`.

Публічне API: `setScope`, `getCurrentScope`, `postMessage`, `onDidReceiveMessage`, `setOnViewReady`, `setOnSurface`, `isVisible`, `reveal`, `openInEditor`.

## Команди

| Команда | Де | Дія |
|---|---|---|
| `averenium.nugetManager.open` | Palette **NuGet: Management**, Explorer | Резолв `.sln`/`.csproj`, `reveal` + `activateScope` |
| `averenium.nugetManager.openInEditor` | Palette **NuGet: Open in Editor** | Той самий UI як editor tab |
| `averenium.nugetManager.openInNewWindow` | Title bar (`$(empty-window)`), Palette **NuGet: Open in New Window** | Editor tab, потім `workbench.action.moveEditorToNewWindow` |
| `averenium.nugetManager.installAgentSkill` | Palette **NuGet: SKILL -> Install Dependency Breaking Changes Review**, title (`$(mortar-board)`) | Копіює bundled skill у `~/.cursor/skills/…` тощо. [agent-skill](agent-skill.md) |
| `averenium.nugetManager.startTrace` | Palette **NuGet: Trace -> Start**, вкладка Log **● Trace** | Confirm, сесія в `globalStorage`. [logging](logging.md) |
| `averenium.nugetManager.stopTrace` | Palette **NuGet: Trace -> Stop & save zip** | Sanitize zip для GitHub issue |
| `averenium.nugetManager.clearLog` | Palette **NuGet: Log -> Clear** | Чистить вкладку Log / Output Channel, не trace |

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
- `viewProvider.reveal()` (editor panel, якщо він живий, інакше `averenium.nugetManagerView.focus`).

## Автодетект без команди

Якщо webview шле `WEBVIEW_READY`, а scope ще немає, broker сканує корінь workspace: спочатку `.sln`/`.slnx`, інакше `.csproj`/`.fsproj`. Якщо нічого немає — `INIT_STATE` з порожнім `projectPath`. Клік по назві в панелі (`SELECT_SCOPE`) шукає файли рекурсивно (`findFiles`) і дає QuickPick.
