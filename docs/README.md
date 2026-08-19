# Документація реалізації

Розширення **AVE NuGet Manager** (`averenium-nuget-manager`, v0.1.0) — менеджер NuGet-пакетів для VS Code / Cursor. UI натхненний JetBrains Rider: webview у нижній панелі з вкладками Packages, Groups, Sources і Log.

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
| [Ланцюжок nuget.config](config-chain.md) | `nugetConfigChainResolver.ts`, вкладка Sources |
| [Webview UI](webview.md) | `src/webview/**` |
| [Логування](logging.md) | `logger.ts`, вкладка Log |
| [Збірка і тести](build-and-test.md) | npm-скрипти, Jest, launch |
| [Незавершене](incomplete.md) | Оголошено, але не доведено |

## Швидкий старт розробки

```bash
npm install
npm run build
```

F5 у VS Code / Cursor запускає Extension Host (`Run Extension`, preLaunchTask `build:all`).
