# Ланцюжок nuget.config

Файл: `src/nugetConfigChainResolver.ts`.  
UI: `src/webview/components/SourcesTab.tsx`.

## Resolve

`NuGetConfigChainResolver.resolve(startDir)`:

1. Починає з абсолютного `startDir` (директорія solution або проєкту).
2. У кожній директорії шукає файл з ім’ям `nuget.config` **без урахування регістру**.
3. Йде вгору до кореня диска. Зупиняється також, якщо поточна директорія — глобальний NuGet-каталог.
4. Додає глобальний config, якщо його ще немає в ланцюжку.

Порядок: **найближчий = індекс 0**, глобальний — останній.

### Глобальні шляхи

| Платформа | Основний | Legacy |
|---|---|---|
| Windows | `%APPDATA%\NuGet` | — |
| macOS / Linux | `~/.config/NuGet` | `~/.nuget/NuGet` |

## Парсинг XML

Без DOM, regex:

- Секція `<packageSources>` — `<add key="Name" value="url" />` → `PackageSource`.
- Секція `<disabledPackageSources>` — `value="true"` вимикає джерело з тим самим `key`.
- Помилка читання/парсингу → `parseError`, `sources: []`.

Не парсяться: credentials, package source mapping, fallback, `<clear/>` як семантика NuGet (файл просто додається в ланцюжок; дедуп імен робить broker/UI).

## Дедуплікація джерел

У `_initForScope` і на вкладці Sources: перша зустріч імені (case-insensitive) виграє — тобто nearest config. Дальші файли з тим самим `key` показуються як «усі джерела вже визначені ближчим файлом».

## Вкладка Sources

- Список файлів ланцюжка.
- Клік по шляху → `OPEN_CONFIG_FILE` → `workspace.openTextDocument`.
- Бейдж ON/OFF, ім’я, URL.
- **Немає** додавання/видалення/toggle джерел у UI — лише правкою XML.
- Повідомлення `CONFIG_CHAIN_UPDATE` у протоколі є, host його не шле: зміна файлу на диску не оновлює вкладку, поки не буде нового init/refresh scope.
