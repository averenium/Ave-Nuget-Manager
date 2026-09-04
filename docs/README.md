# Документація реалізації

Розширення **AVE NuGet Manager** (`averenium-nuget-manager`, v0.1.0) — менеджер NuGet-пакетів для VS Code / Cursor. UI натхненний JetBrains Rider: webview у нижній панелі з вкладками Packages, Groups, Sources, Log і Agents.

Кореневий [README.md](../README.md) — сторінка Marketplace. Документи нижче описують **те, що вже є в коді**.

| Документ | Частина коду |
|---|---|
| [Архітектура](architecture.md) | Шари, процеси, потік даних |
| [Активація і команди](activation.md) | `extension.ts`, `commandRegistrar.ts`, `nugetManagerViewProvider.ts` |
| [Протокол повідомлень](protocol.md) | `messages.ts`, `webviewMessageBroker.ts` |
| [Install, restore-fail і rollback](install-and-rollback.md) | `dotnet add`, NU1605, snapshot csproj, `onFailedUpdate` |
| [Пакетні оновлення](batch-updates.md) | Update all, родини `Microsoft.**.**`, вкладка Groups |
| [Вразливості](vulnerabilities.md) | `dotnet list --vulnerable`, користувацький скрипт, ⚠ у Packages |
| [Backend і CLI](backend.md) | `INuGetBackend`, `cliBackend.ts`, `cliRunner.ts`, `concurrency.ts` |
| [Парсер solution](solution.md) | `solutionParser.ts` |
| [Ланцюжок nuget.config](config-chain.md) | `nugetConfigChainResolver.ts`, `sourcesSnapshot.ts`, вкладка Sources |
| [Webview UI](webview.md) | `src/webview/**` |
| [Логування](logging.md) | `logger.ts`, вкладка Log, trace zip |
| [Збірка і тести](build-and-test.md) | npm-скрипти, Jest, launch; лабораторний Nexus |
| [Agent skill](agent-skill.md) | `installAgentSkill`, `skills/dependency-breaking-changes-review/` |
| [Vulnerability script](vulnerability-script.md) | `averenium.nugetManager.vulnerabilityScript`, `userScriptVulnerabilities.ts` |
| [Незавершене](incomplete.md) | Оголошено, але не доведено |

`agent-skill.md` і `vulnerability-script.md` — виняток серед документів вище: англійською і для користувача (не implementation notes), бо на них є пряме посилання з Settings UI / README, а не лише з цього індексу (#69).

## Швидкий старт розробки

```bash
npm install
npm run build
```

F5 у VS Code / Cursor запускає Extension Host (`Run Extension`, preLaunchTask `build:all`).
