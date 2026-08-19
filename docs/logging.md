# Логування

Файл: `src/logger.ts`.

`Logger`:

- Output Channel `Averenium NuGet Manager`;
- in-memory масив `LogEntry[]` (хронологічний, без ліміту розміру);
- pub/sub: `subscribe(listener)` → `Disposable`.

Кожен `CliRunner.run` і частина «несправжніх» операцій broker (резолв config chain) викликають `logCliOperation`.

`LogEntry`: `id` (UUID), `timestamp` (ISO), `command`, `args`, `stdout`, `stderr`, `exitCode`, `timedOut`, `durationMs`.

Помилки запису в Output Channel і помилки слухачів ковтаються — логер не повинен ламати CLI.

## Доставка в UI

При `attach()` broker підписується на logger і шле `LOG_ENTRY_ADDED`. Вкладка Log при монтуванні просить повний зріз `GET_LOG_ENTRIES`.

`LogTab`: автоскрол вниз, рядок з часом / duration / командою / exit, перші 3 рядки виводу, решта за кнопкою розгортання.

Метод `Logger.show()` (показати Output Channel) у UI не викликається.
