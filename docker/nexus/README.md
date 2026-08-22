# Лабораторний Nexus (NuGet)

Локальний Sonatype Nexus OSS: **proxy nuget.org**, **приватний hosted** і **group** (hosted перший). Для ручної перевірки Sources, skip `list --vulnerable` (#7) і неповного v3 (#27). Не для CI.

## Підйом

З кореня репозиторію (Docker Desktop, ~2 ГБ RAM, перший старт 1–2 хв):

```powershell
docker compose -f docker/nexus/docker-compose.yml up
```

Дочекайся в логах `nexus-init`: `Nexus NuGet lab is ready`. UI: http://localhost:8081 (`admin` / `admin123`).

Якщо UI пише, що пароль у `/nexus-data/admin.password` — init ще не зміг його змінити (або volume з попереднього старту). Прочитай його з контейнера:

```powershell
docker compose -f docker/nexus/docker-compose.yml exec nexus cat /nexus-data/admin.password
```

Логін: `admin` + цей рядок. У майстрі постав `admin123` (або `down -v` і `up` знову — на порожньому volume `-Dnexus.security.randompassword=false` дає одразу `admin123`).

Повторний `up` ідемпотентний. З нуля: `docker compose -f docker/nexus/docker-compose.yml down -v`.

## Feeds

| Репо | URL v3 |
|---|---|
| group (звичайний corp-режим) | `http://localhost:8081/repository/nuget-group/index.json` |
| proxy nuget.org | `http://localhost:8081/repository/nuget.org-proxy/index.json` |
| hosted (лише приватні) | `http://localhost:8081/repository/nuget-hosted/index.json` |

Користувач для push / Basic: `nuget` / `nuget`. API key: `nuget:nuget`. Anonymous read увімкнений.

## Приватний пакет

```powershell
.\docker\nexus\push-private.ps1
```

Пушить `Ave.Nexus.Private` 1.0.0 у hosted (на nuget.org його немає). Пошук за id через group / hosted.

## nuget.config у тестовому solution

Скопіюй [`nuget.config.example`](nuget.config.example) в корінь тестового `.sln` (не в це розширення). За замовчуванням увімкнений лише **nexus-group** — без nuget.org як package source.

- Без `<auditSources>` → host **пропускає** `dotnet list --vulnerable` (CLI інакше б’є Nexus registration).
- Розкоментуй `auditSources` на **nuget.org** або **nexus-proxy** (не group) → CLI йде в VDB, ⚠ з’являються. nuget.org як package source не потрібен.

`allowInsecureConnections` потрібен для `http://localhost`.

Restore зразка (після push):

```powershell
dotnet restore docker/nexus/sample/Sample.NexusLab.csproj
```
