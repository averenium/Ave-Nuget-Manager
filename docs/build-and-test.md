# Збірка і тести

## npm-скрипти

| Скрипт | Дія |
|---|---|
| `build` | `build:ext` + `build:webview` |
| `build:ext` | `tsc -p tsconfig.json` |
| `build:webview` | `vite build --config vite.webview.config.ts` |
| `watch:ext` | `tsc --watch` — host |
| `watch:webview` | `vite build --watch` → `dist/webview/bundle.js` |
| `watch` | Обидва (на Windows надійніше через task `build:watch`) |
| `test` | Jest `--runInBand` |
| `test:unit` / `test:property` | Підмножини |
| `lint` | `eslint src --ext .ts,.tsx` — **eslint немає в devDependencies** |
| `package` | `vsce package` |
| `vscode:prepublish` | `npm run build` |

## Debug

`.vscode/launch.json`:

- **Run Extension** — one-shot `build:all`, webview з `dist/webview/bundle.js`.
- **Run Extension (watch)** — `tsc --watch` + `vite build --watch`. Панель вантажить зібраний бандл (не Vite dev server — webview VS Code не вміє надійно HMR з `localhost`). Зміна UI перезбирає bundle і перезавантажує HTML панелі. Зміни host потребують **Reload Window** (Ctrl+R) у Extension Development Host.
- **Debug Tests** — Jest in-band без coverage.

## Тести (Jest)

`jest.config.ts`: `ts-jest`, environment `node`, mock модуля `vscode` → `src/test/__mocks__/vscode.ts`. Coverage збирається з `src/**/*.ts`, **без** `src/webview/**`.

### Unit (`src/test/unit/`)

| Файл | Що перевіряє |
|---|---|
| `blockedPackages.setting.test.ts` / `dotnetConcurrency.setting.test.ts` | Читання Workspace settings |
| `concurrency.test.ts` | `runWithConcurrency` / `createConcurrencyGate` |
| `commandBuilder.test.ts` | Аргументи CLI, які будує `CliBackend` |
| `commandRegistrar.test.ts` | Резолв URI / папки / QuickPick |
| `agentSkillInstall.test.ts` | Detect/sort skill targets, atomic copy, frontmatter version |
| `configChainResolver.test.ts` | Ланцюжок і парсинг XML |
| `logger.test.ts` | Записи, subscribe, стійкість до помилок, `clear()` |
| `traceSanitize.test.ts` / `traceSession.test.ts` / `tracePack.test.ts` / `zipStore.test.ts` | Знеособлення шляхів, сесія jsonl, snapshot проєктів, zip |
| `solutionParser.test.ts` | `.sln` / `.slnx` |
| `webviewMessageBroker.test.ts` | INIT, search, install/remove, NU1605, rollback/keep, patch |
| `dotnetOutput.test.ts` | Summary NU1605 vs list JSON `problems` |
| `projectFileSnapshot.test.ts` | Знімок / restore csproj, читання Version |

### Property (`src/test/property/`, fast-check)

- `commandBuilder.property.ts`
- `configChain.property.ts`
- `solutionParser.property.ts`

У `package.json` є `@testing-library/react`, `jsdom`, `vitest` — тестів webview немає.

## VSIX / Marketplace preview

Перший публічний канал — **pre-release** (`vsce --pre-release`). Версія `0.1.0` (непарний minor). Стабільний реліз пізніше — парний minor (`0.2.0`) **без** `--pre-release`.

| Скрипт | Дія |
|---|---|
| `package` | `vsce package --pre-release` → `.vsix` |
| `package:release` | `vsce package` (стабільний канал; не для 0.1.x) |
| `publish:preview` | `vsce publish --pre-release` (потрібен publisher + PAT / Entra) |

`.vscodeignore` викидає `src/`, `docs/`, тести, source maps, `*.md` крім `README.md` і `CHANGELOG.md`. У пакет: `dist/extension.js`, `dist/webview/*`, `media/icon.png`, `LICENSE`.
