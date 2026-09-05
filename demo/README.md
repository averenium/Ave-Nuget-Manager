# Example.Shop — the demo solution for screenshots

A throwaway .NET 10 solution that exists for one reason: to be the thing on screen
in the Marketplace and Open VSX assets listed in
[`../docs/marketplace-assets.md`](../docs/marketplace-assets.md). Every name in it
is invented, so nothing here can leak a real project, feed or host name.

Open **this folder** (`demo/`) as the workspace when recording — not the extension
repository around it.

## What it is shaped for

| The shot needs | What the solution provides |
|---|---|
| A multi-project solution | Five projects across `src/` and `tests/`, including an F# one, so the panel shows real per-project rows |
| Plenty of **↑** | Every project has outdated packages; nothing is on its latest version |
| Families worth batch-updating | Two of them, each across three projects: `Microsoft.Extensions.*` (4 packages) and `OpenTelemetry.*` (6). Everything else — Serilog, Swashbuckle, Dapper, Npgsql, RabbitMQ, xunit — lands in **Other**, so all three sides of the Groups tab have something in them |
| A **⚠** with a genuine advisory | Five of them. `Newtonsoft.Json` 12.0.3, `Microsoft.Extensions.Caching.Memory` 8.0.0 and `Npgsql` 8.0.0 are high severity and flagged directly, `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.9.0 is moderate, and `OpenTelemetry.Api` 1.9.0 is flagged **transitively** in three projects — which is what shows that the marks follow the restore graph rather than the manifest |
| A **⊘** blocked package | `RabbitMQ.Client` — see below |
| A `nuget.config` chain to edit | Two sources, one of them disabled, with `packageSourceMapping` patterns already in place |
| A failed command in **Log** | See "Producing a failure" below |

The second source (`example-internal`) points at a host that does not exist. It
is disabled and mapped to `Example.*` only, so restore never contacts it — but it
is there to be toggled, edited and shown in the Sources tab.

## The RabbitMQ trap

`Example.Shop.Infrastructure` references `RabbitMQ.Client` 6.8.1 directly and
`EasyNetQ` 7.8.0, which was built against `RabbitMQ.Client` 6.8.1 as well. Version
7.x of the client is not compatible with 6.x, and a great deal of the ecosystem is
still on 6.x.

The point of having it here is what happens when you take the bump: NuGet ranges
are minimums, so `EasyNetQ`'s `>= 6.8.1` is satisfied by 7.2.2 and **restore
succeeds without a single warning** — verified, not assumed. Nothing tells you the
library will fail at runtime. That is the case the **⊘** pin exists for, and the
one the dependency-review agent skill is meant to catch before it lands, so
`RabbitMQ.Client` is the package blocked in `.vscode/settings.json`.

## Before recording

```bash
dotnet restore
```

Restore reports five vulnerabilities and no errors. That is the point of the demo,
not a problem with it.

## Producing a failure for the Log shot

Add a direct reference to a package at a version lower than one already coming
through a project reference — for example put `Newtonsoft.Json` 11.0.2 in
`Example.Shop.Api`, which reaches 12.0.3 through
`Example.Shop.Infrastructure -> Example.Shop.Domain`. Restore then fails with
`NU1605` and prints both paths, which is exactly the row worth expanding in the
Log tab: the failure summary, the ordered output and the clickable code chip.

## After recording

Recording an update rewrites the `.csproj` files, which is what makes the demo
one-use. Put it back with:

```bash
git checkout -- demo/
```

Then `dotnet restore` again before the next take.
