# Парсер solution

Файл: `src/solutionParser.ts`.

`SolutionParser.getProjects(solutionPath)` читає файл і повертає `ProjectInfo[]`:

| Поле | Зміст |
|---|---|
| `name` | Ім’я файлу без розширення |
| `relativePath` | Шлях зі solution, слеші нормалізовані на `/` |
| `absolutePath` | `path.resolve(solutionDir, relativePath)` |

Беруться лише `.csproj` і `.fsproj`. Інші типи проєктів у `.sln` (solution folders, websites тощо) ігноруються regex’ом.

## `.sln`

Regex:

```
Project("…") = "…", "relative\path\Foo.csproj", "{guid}"
```

CRLF нормалізується до `\n` перед пошуком. Regex глобальний і stateful — перед кожним проходом `lastIndex = 0`.

## `.slnx`

Без DOM: regex по тегах

```
<Project … Path="some/path.csproj" …>
```

## Контекстне меню папок

`shouldShowContextMenu(directChildFileNames)` — `true`, якщо серед **прямих** імен файлів є `.sln` / `.slnx` / `.csproj` / `.fsproj`. Рекурсії немає. Функція експортується і покрита property-тестом; у `package.json` `when`-клаузула меню ширша (`explorerResourceIsFolder`), тож фільтр «чи є проєкт у папці» насправді виконується вже в `CommandRegistrar` після кліку.
