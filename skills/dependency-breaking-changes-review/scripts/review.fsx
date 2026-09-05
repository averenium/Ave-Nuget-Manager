// review.fsx — dependency-breaking-changes-review helper script (#67).
//
// Mechanizes the most expensive/error-prone parts of the skill's manual workflow:
//
//   diff  [<base-ref>] [--no-notes]
//     `git diff` (working tree vs `<base-ref>`, or vs HEAD if omitted) over
//     `Directory.Packages.props`/`*.csproj`/`*.fsproj`/`*.vbproj`, parsed for
//     every `PackageReference`/`PackageVersion` whose `Version` attribute
//     actually changed. Replaces manually reading the diff to build the
//     "old → new per id" list Workflow step 1 asks for. By default it also
//     fetches release notes for every changed id in parallel (`--no-notes`
//     skips this for a quicker, version-list-only answer) — one invocation
//     covers Workflow steps 1 and 3 together instead of one `notes` call
//     per package afterward.
//
//   graph  <sln|slnx|csproj|fsproj>
//     One restore + one project.assets.json parse per project instead of a
//     `dotnet nuget why` round-trip per shared/transitive id. Reports
//     diamonds (same package id requested at different ranges by different
//     consumers within one project) and transitive major-version crossings
//     (a consumer asked for major N, NuGet resolved major M <> N) — the
//     exact check Rule 3 asks the agent to remember to do by hand.
//
//   notes  <packageId> <oldVersion> <newVersion>
//     Resolves the package's source repo from the already-restored local
//     NuGet cache (no extra fetch), lists releases/tags in the given range
//     from GitHub/GitLab/Bitbucket/Azure DevOps, and pre-scans each one for
//     risk markers. On GitHub the release list is scraped from the public
//     releases page (`/releases?page=N`), walking pages back until it passes
//     the old version — no token and no API quota, and unlike the Atom feed
//     it covers the whole range rather than only its recent end; the Atom
//     feed remains the fallback for when that scrape fails. When the target
//     version's own tag has no Release object at all (a repo can keep
//     tagging without publishing Releases — observed live on real bumps),
//     falls back to one `compare` call for the raw commit log across the
//     range instead of leaving that gap for the agent to fill by hand with
//     its own `gh api .../compare` call. Degrades explicitly (never
//     silently) when nothing can be resolved automatically. Standalone —
//     for re-checking one package id without re-running the whole diff.
//
// Usage (from the skill's own instructions, not run directly by this
// extension):
//   dotnet fsi review.fsx diff
//   dotnet fsi review.fsx diff origin/main
//   dotnet fsi review.fsx diff origin/main --no-notes
//   dotnet fsi review.fsx graph path/to/App.sln
//   dotnet fsi review.fsx notes Newtonsoft.Json 12.0.3 13.0.3
//
// Runs via `dotnet fsi` — no project file, no build step, no third-party
// NuGet packages (only in-box BCL types) — so it works wherever the .NET
// SDK already is, with zero extra setup. `dotnet fsi` has shipped with the
// SDK since .NET Core 2.1, well before the file-based single-file `dotnet
// run app.cs` apps (stable only from .NET 10) that would otherwise be the
// obvious "just one file" alternative — this script has to run standalone
// wherever an arbitrary target workspace's SDK happens to be, not just on
// whatever version this extension's own repo builds with.
//
// Output is JSON on stdout — meant to be dropped close to verbatim into the
// skill's report template, not reformatted by the agent first.

open System
open System.Collections.Concurrent
open System.IO
open System.Text
open System.Text.Json
open System.Text.RegularExpressions
open System.Diagnostics
open System.Net.Http
open System.Xml.Linq

// ───────────────────────── process / shell helpers ─────────────────────────

type ProcResult = { ExitCode: int; Stdout: string; Stderr: string }

/// Never throws — a bad `cwd` or a missing executable becomes a synthetic
/// failed result instead of an unhandled exception, so every caller further
/// down gets a normal "this failed" outcome to report instead of a raw .NET
/// stack trace on stdout (which would not be valid JSON for the agent to
/// parse).
///
/// Reads stdout and stderr on their own background threads instead of
/// `ReadToEnd()` one after the other — with both streams redirected, a
/// child that fills the OS pipe buffer on the stream being read *second*
/// (e.g. `git diff` outside a repo dumps its whole usage text to stdout)
/// blocks forever writing to it while this process is still blocked
/// reading the first stream to completion. This is the standard .NET
/// `Process` deadlock footgun, not a hypothetical one — it reproduced on
/// exactly that case while building this script.
let runCommand (fileName: string) (args: string list) (cwd: string) : ProcResult =
    try
        let psi = ProcessStartInfo(fileName)
        psi.RedirectStandardOutput <- true
        psi.RedirectStandardError <- true
        psi.UseShellExecute <- false
        psi.WorkingDirectory <- cwd
        for a in args do psi.ArgumentList.Add(a)
        use p = new Process()
        p.StartInfo <- psi
        p.Start() |> ignore
        let stdoutTask = p.StandardOutput.ReadToEndAsync()
        let stderrTask = p.StandardError.ReadToEndAsync()
        p.WaitForExit()
        let stdout = stdoutTask.GetAwaiter().GetResult()
        let stderr = stderrTask.GetAwaiter().GetResult()
        { ExitCode = p.ExitCode; Stdout = stdout; Stderr = stderr }
    with ex ->
        { ExitCode = -1; Stdout = ""; Stderr = sprintf "failed to start '%s': %s" fileName ex.Message }

// ───────────────────────────── version helpers ──────────────────────────────

/// Extracts the leading major version number from a NuGet version or range
/// string: "8.0.0", "[8.0.0, )", "[8.0.0]", "(8.0.0-preview.1, )" all yield 8.
let majorOf (versionOrRange: string) : int option =
    let m = Regex.Match(versionOrRange, @"(\d+)\.\d+")
    if m.Success then Some(int m.Groups.[1].Value) else None

// ─────────────────────────── JSON writer helpers ────────────────────────────
// Hand-rolled instead of System.Text.Json.Nodes' mutable writer API, so the
// exact shape of the output object is visible in one place per record type.

let jsonEscape (s: string) : string =
    let sb = StringBuilder(s.Length + 8)
    for c in s do
        match c with
        | '"' -> sb.Append("\\\"") |> ignore
        | '\\' -> sb.Append("\\\\") |> ignore
        | '\n' -> sb.Append("\\n") |> ignore
        | '\r' -> sb.Append("\\r") |> ignore
        | '\t' -> sb.Append("\\t") |> ignore
        | c when int c < 0x20 -> sb.AppendFormat("\\u{0:x4}", int c) |> ignore
        | c -> sb.Append(c) |> ignore
    sb.ToString()

let jstr (s: string) = "\"" + jsonEscape s + "\""
let jstrOpt (s: string option) = match s with Some v -> jstr v | None -> "null"
let jbool (b: bool) = if b then "true" else "false"
let jintOpt (i: int option) = match i with Some v -> string v | None -> "null"
let jboolOpt (b: bool option) = match b with Some v -> jbool v | None -> "null"
let jarr (items: string list) = "[" + String.Join(",", items) + "]"
let jobj (fields: (string * string) list) =
    "{" + String.Join(",", fields |> List.map (fun (k, v) -> jstr k + ":" + v)) + "}"

/// Re-indents an already-built compact JSON string via a round-trip through
/// `JsonDocument`/`JsonSerializer` — reuses every `jobj`/`jarr` call site
/// as-is instead of a second, structured writer just for the indented case.
/// Used only for `--out <dir>`: a large diff/graph result is meant for the
/// agent to grep/search in a file, where indentation earns its cost; a
/// single stdout line stays the (unchanged) default.
let prettyJson (compact: string) : string =
    use doc = JsonDocument.Parse(compact)
    JsonSerializer.Serialize(doc.RootElement, JsonSerializerOptions(WriteIndented = true))

/// `diff`/`graph`'s shared "where does the full result go" decision.
/// `None` (no `--out`) — unchanged default: the full compact JSON straight
/// to stdout. `outDir` is a **directory**, not a file: `<outDir>/<kind>.json` (the full,
/// machine-queryable result — grep/jq this, per nuget.md's "never Read an
/// --out file start-to-front") and `<outDir>/<kind>.md` (the same data as a
/// report skeleton — mechanical facts filled in, explicit `TODO`s where the
/// job needs the agent's own judgment or a codebase cross-check) land side
/// by side, so the skill's next step is opening the `.md` and filling in
/// the parts the script can't do itself, not reformatting JSON into prose
/// first. `kind` is `"diff"` or `"graph"` so a review running both into the
/// same directory doesn't collide.
/// `extraFiles` are `(fileName, content)` pairs written alongside the two
/// standard outputs and reported back by their own key, so a caller can hand
/// the agent a file meant to be moved around (appended to the report with a
/// shell redirect, say) rather than read.
let emitResult
    (kind: string)
    (fullJson: string)
    (markdown: string)
    (outDir: string option)
    (extraFiles: (string * string * string) list)
    (summaryFields: (string * string) list)
    : unit =
    match outDir with
    | None -> printfn "%s" fullJson
    | Some dir ->
        Directory.CreateDirectory(dir) |> ignore
        let jsonPath = Path.Combine(dir, kind + ".json")
        let mdPath = Path.Combine(dir, kind + ".md")
        File.WriteAllText(jsonPath, prettyJson fullJson)
        File.WriteAllText(mdPath, markdown)
        let extraFields =
            extraFiles
            |> List.map (fun (key, fileName, content) ->
                let path = Path.Combine(dir, fileName)
                File.WriteAllText(path, content)
                (key, jstr (Path.GetFullPath path)))
        printfn
            "%s"
            (jobj
                ([ ("outDir", jstr (Path.GetFullPath dir))
                   ("jsonFile", jstr (Path.GetFullPath jsonPath))
                   ("mdFile", jstr (Path.GetFullPath mdPath)) ]
                 @ extraFields
                 @ summaryFields))

// ───────────────────────────────── notes ────────────────────────────────────
// Defined before `diff` and `graph` further down: `diff` calls `resolveNotes`
// directly (fetching notes for every changed package as part of its own
// output), so this has to compile first — F# scripts have no forward
// declarations.

type Release =
    { Tag: string
      Url: string
      HasRiskMarker: bool
      /// True when the tag carries a monorepo-style component prefix
      /// ("Instrumentation.Process-1.2.0") that does *not* match the
      /// package this release list was resolved for — see
      /// `tagComponentPrefix`. Always `false` on a tag with no such prefix
      /// (a plain "v1.2.0"/"1.2.0" core-repo tag) and on every non-GitHub
      /// host (component-prefix filtering is GitHub-only so far).
      UnrelatedComponent: bool
      /// Empty unless `HasRiskMarker && not UnrelatedComponent` — the only
      /// case an agent actually reads this text; a risky-but-unrelated or a
      /// non-risky release costs output size for a body nobody opens.
      BodyPreview: string }

let riskMarkerPattern =
    Regex(
        @"\bbreaking\b|\bremov\w*\b|\brenam\w*\b|\bobsolete\b|major\s+(?:dependency\s+)?bump|\+semver:\s*major|\bCVE-\d|\bvulnerabilit(?:y|ies)\b",
        RegexOptions.IgnoreCase
    )

let hasRiskMarker (text: string) = riskMarkerPattern.IsMatch(text)

/// "Instrumentation.Process-1.2.0" -> Some "Instrumentation.Process";
/// "Instrumentation.Runtime-1.14.0-beta.1" -> Some "Instrumentation.Runtime"
/// (the version group also swallows a trailing pre-release suffix, so the
/// dash before it doesn't get mistaken for a second component boundary);
/// a plain "v1.2.0"/"1.2.0"/"9.0.0-preview.1" (no "-" immediately before a
/// full `\d+.\d+.\d+` version core) -> None, since there is no component
/// boundary to extract — a bare pre-release suffix after the version core
/// doesn't create one either (verified live against real
/// open-telemetry-dotnet-contrib tags, which use exactly this shape).
let tagComponentPrefix (tag: string) : string option =
    let m = Regex.Match(tag, @"^(.+)-v?\d+\.\d+\.\d+")
    if m.Success then Some m.Groups.[1].Value else None

/// Package ids for a monorepo component's NuGet package are conventionally
/// the git tag's component prefix with a publisher/org prefix of their own
/// added ("OpenTelemetry.Instrumentation.Runtime" for tag prefix
/// "Instrumentation.Runtime") — verified against the real
/// open-telemetry-dotnet-contrib tag/package-id pairing. `EndsWith` in
/// either direction covers that shape without needing an exact match.
let componentMatchesPackage (packageId: string) (prefix: string) : bool =
    packageId.EndsWith(prefix, StringComparison.OrdinalIgnoreCase)
    || prefix.EndsWith(packageId, StringComparison.OrdinalIgnoreCase)

/// Only the risky, related case is ever actually read — see `Release.BodyPreview`.
/// A `hasRiskMarker=false` release is not "nothing changed" — it just means
/// the crude keyword scan found nothing, which is a prioritization signal
/// for *which* releases need the full text, not a verdict that the rest are
/// contentless. A related release with no risk marker still gets a short
/// preview (enough to often cite directly as Compatible without opening the
/// link) — only a genuinely unrelated-component tag gets nothing at all.
let private bodyPreviewFor (unrelated: bool) (body: string) : string =
    if unrelated then
        ""
    else
        // Real release bodies are almost never this long; the cap exists only
        // to bound the rare pathological outlier (an embedded migration guide
        // pasted into one release), not to ration content by risk marker —
        // that scan is a sort/triage signal, not a reason to withhold text
        // the agent still has to read for every release in range anyway.
        let limit = 4000
        if body.Length > limit then body.Substring(0, limit) + "…" else body

let nugetPackagesRoot () =
    Environment.GetEnvironmentVariable("NUGET_PACKAGES")
    |> Option.ofObj
    |> Option.defaultValue (Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages"))

/// Local nuspec for the *new* version — already on disk after restore, zero
/// network calls. Checked before any remote API per the issue's refinement:
/// the nuspec's own `<releaseNotes>` counts on its own, not just as a
/// private-package fallback.
let findLocalNuspec (packageId: string) (version: string) : XElement option =
    let path =
        Path.Combine(nugetPackagesRoot (), packageId.ToLowerInvariant(), version, packageId.ToLowerInvariant() + ".nuspec")
    if File.Exists path then
        try Some(XDocument.Load(path).Root) with _ -> None
    else
        None

let nuspecNs (root: XElement) = root.Name.Namespace

let nuspecMetadata (root: XElement) : XElement option =
    let ns = nuspecNs root
    match root.Element(ns + "metadata") with
    | null -> None
    | m -> Some m

let nuspecField (root: XElement) (name: string) : string option =
    nuspecMetadata root
    |> Option.bind (fun m ->
        let ns = nuspecNs root
        match m.Element(ns + name) with
        | null -> None
        | e -> if String.IsNullOrWhiteSpace(e.Value) then None else Some(e.Value.Trim()))

let nuspecRepoUrl (root: XElement) : string option =
    let ns = nuspecNs root
    let fromRepositoryElement =
        nuspecMetadata root
        |> Option.bind (fun m ->
            match m.Element(ns + "repository") with
            | null -> None
            | r ->
                match r.Attribute(XName.Get "url") with
                | null -> None
                | a -> if String.IsNullOrWhiteSpace(a.Value) then None else Some(a.Value.Trim()))
    fromRepositoryElement |> Option.orElseWith (fun () -> nuspecField root "projectUrl")

/// `<dependencies>` — either flat `<dependency>` children (old-style nuspec)
/// or per-TFM `<group targetFramework="..."><dependency/></group>` (current
/// style, most packages). Collected across every group without picking a
/// single TFM to match against, since this is a cheap best-effort signal,
/// not a precise restore — a package multi-targeting frameworks with
/// genuinely different dependency majors is rare enough that "last group
/// wins" for a given id is an acceptable simplification here.
let nuspecDependencies (root: XElement) : (string * string) list =
    let ns = nuspecNs root
    nuspecMetadata root
    |> Option.map (fun m ->
        match m.Element(ns + "dependencies") with
        | null -> []
        | deps ->
            Seq.append
                (deps.Elements(ns + "dependency"))
                (deps.Elements(ns + "group") |> Seq.collect (fun g -> g.Elements(ns + "dependency")))
            |> Seq.choose (fun d ->
                match d.Attribute(XName.Get "id"), d.Attribute(XName.Get "version") with
                | null, _ -> None
                | idAttr, verAttr -> Some(idAttr.Value, (if isNull verAttr then "" else verAttr.Value)))
            |> Seq.toList)
    |> Option.defaultValue []

type TransitiveMajorHint =
    { PackageId: string
      DirectPackageId: string
      DirectOldVersion: string
      DirectNewVersion: string
      OldRequestedRange: string
      NewRequestedRange: string
      OldMajor: int
      NewMajor: int }

/// Cheapest possible signal for "did bumping this direct package silently
/// move a transitive to a new major" (the classic Rule 3 case — EF Core 9
/// requiring Npgsql 9, with Npgsql never appearing in the manifest diff)
/// **without** a `packages.lock.json` (rare in practice) and without a
/// second full restore of the pre-bump state (expensive, and requires
/// checking out old history): compare what the *old* and *new* versions of
/// the bumped package themselves declare as their own dependency ranges, via
/// their already-cached nuspecs. If both are cached (typically true — the
/// old version was restored before this bump, the new one just was) this
/// needs zero network and zero extra restore. If either nuspec isn't
/// cached, this candidate list is empty — not a hard failure, just no
/// signal; Rule 3's manual "read the notes of key transitives" remains the
/// authority regardless.
let findTransitiveMajorHints (directId: string) (directOldVersion: string) (directNewVersion: string) : TransitiveMajorHint list =
    match findLocalNuspec directId directOldVersion, findLocalNuspec directId directNewVersion with
    | Some oldRoot, Some newRoot ->
        // Multi-targeting packages repeat the same dependency once per
        // `<group targetFramework="...">` — `Map.ofList` collapses those
        // duplicates (last group wins) before comparing, otherwise the same
        // transitive would produce one hint per framework group.
        let oldDeps = nuspecDependencies oldRoot |> List.map (fun (id, r) -> id.ToLowerInvariant(), (id, r)) |> Map.ofList
        let newDeps = nuspecDependencies newRoot |> List.map (fun (id, r) -> id.ToLowerInvariant(), (id, r)) |> Map.ofList
        newDeps
        |> Map.toList
        |> List.choose (fun (key, (id, newRange)) ->
            match oldDeps.TryFind key with
            | Some(_, oldRange) ->
                match majorOf oldRange, majorOf newRange with
                | Some om, Some nm when om <> nm ->
                    Some
                        { PackageId = id
                          DirectPackageId = directId
                          DirectOldVersion = directOldVersion
                          DirectNewVersion = directNewVersion
                          OldRequestedRange = oldRange
                          NewRequestedRange = newRange
                          OldMajor = om
                          NewMajor = nm }
                | _ -> None
            | None -> None)
    | _ -> []

let transitiveMajorHintJson (h: TransitiveMajorHint) =
    jobj
        [ ("packageId", jstr h.PackageId)
          ("viaDirectPackage", jstr h.DirectPackageId)
          ("directOldVersion", jstr h.DirectOldVersion)
          ("directNewVersion", jstr h.DirectNewVersion)
          ("oldRequestedRange", jstr h.OldRequestedRange)
          ("newRequestedRange", jstr h.NewRequestedRange)
          ("oldMajor", string h.OldMajor)
          ("newMajor", string h.NewMajor)
          ("flag", jstr "breaking-candidate")
          ("note", jstr "Derived from the direct package's own nuspec dependency declarations (old vs new version), not a live restore — confirm with `graph` and this transitive's own release notes (Rule 3).") ]

let private changelogNamePattern =
    Regex(@"^(changelog|release[-_]?notes|history)(\.(md|txt))?$", RegexOptions.IgnoreCase)

/// `~/.nuget/packages/<id>/<version>/` — package root, `content/`,
/// `contentFiles/`, `lib/` (bounded depth, since `lib/<tfm>/…` nests one
/// level deeper) — for a bundled changelog file, the private/no-GitHub-repo
/// fallback the skill's own manual instructions already name. Read straight
/// from disk, no network, no `dotnet build`.
let findLocalChangelogFile (packageId: string) (version: string) : (string * string) option =
    let pkgDir = Path.Combine(nugetPackagesRoot (), packageId.ToLowerInvariant(), version)
    if not (Directory.Exists pkgDir) then
        None
    else
        let rec search (dir: string) (depth: int) : string option =
            if depth > 3 then
                None
            else
                try
                    match Directory.GetFiles(dir) |> Array.tryFind (fun f -> changelogNamePattern.IsMatch(Path.GetFileName(f))) with
                    | Some f -> Some f
                    | None -> Directory.GetDirectories(dir) |> Array.tryPick (fun d -> search d (depth + 1))
                with _ -> None
        search pkgDir 0
        |> Option.bind (fun path ->
            try
                let content = File.ReadAllText(path)
                let preview = if content.Length > 1000 then content.Substring(0, 1000) + "…" else content
                Some(Path.GetFileName(path), preview)
            with _ -> None)

type RepoRef = { Host: string; Owner: string; Repo: string }

/// `git+https://github.com/x/y.git`, trailing `.git`, `www.` — normalized away.
let parseRepoUrl (url: string) : RepoRef option =
    let cleaned = url.Trim().Replace("git+", "").TrimEnd('/')
    let cleaned = if cleaned.EndsWith(".git") then cleaned.Substring(0, cleaned.Length - 4) else cleaned
    try
        let uri = Uri(cleaned)
        let host = uri.Host.Replace("www.", "").ToLowerInvariant()
        let segments =
            uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries)
        if segments.Length >= 2 then
            let knownHost =
                if host = "github.com" then Some "github"
                elif host = "gitlab.com" then Some "gitlab"
                elif host = "bitbucket.org" then Some "bitbucket"
                elif host = "dev.azure.com" || host.EndsWith(".visualstudio.com") then Some "azure-devops"
                else None
            knownHost |> Option.map (fun h -> { Host = h; Owner = segments.[0]; Repo = segments.[1] })
        else
            None
    with _ -> None

/// The page releases/tags are actually published on for the resolved host —
/// not the repo root — built from `RepoRef` alone, no network. Bitbucket has
/// no dedicated "releases" concept; its tag list under Downloads is the
/// closest equivalent.
let releasesUrlFor (r: RepoRef) : string =
    match r.Host with
    | "github" -> sprintf "https://github.com/%s/%s/releases" r.Owner r.Repo
    | "gitlab" -> sprintf "https://gitlab.com/%s/%s/-/releases" r.Owner r.Repo
    | "bitbucket" -> sprintf "https://bitbucket.org/%s/%s/downloads/?tab=tags" r.Owner r.Repo
    | "azure-devops" -> sprintf "https://dev.azure.com/%s/_git/%s/tags" r.Owner r.Repo
    | _ -> sprintf "https://%s/%s/%s" r.Host r.Owner r.Repo

let httpClient =
    let c = new HttpClient()
    c.Timeout <- TimeSpan.FromSeconds(20.0)
    c.DefaultRequestHeaders.UserAgent.ParseAdd("ave-nuget-manager-dependency-review-script")
    c

let getStringAsync (url: string) (extraHeaders: (string * string) list) : string option =
    try
        use req = new HttpRequestMessage(HttpMethod.Get, url)
        for (k, v) in extraHeaders do
            req.Headers.TryAddWithoutValidation(k, v) |> ignore
        let resp = httpClient.SendAsync(req) |> Async.AwaitTask |> Async.RunSynchronously
        if resp.IsSuccessStatusCode then
            Some(resp.Content.ReadAsStringAsync() |> Async.AwaitTask |> Async.RunSynchronously)
        else
            None
    with _ -> None

/// True when `version` is in `(oldVersion, newVersion]` by simple numeric
/// comparison — inclusive of new, exclusive of old, per Rule 2.
/// Same core/pre-release precedence rule as `compareSemVer` in
/// `src/backend/cliBackend.ts`: numeric segments first — zero-padded to a
/// fixed 4, since comparing a 3-segment version against a 4-segment one
/// via `Seq.zip` alone silently drops the unmatched tail instead of
/// treating it as significant (a real bug: "1.0.0" vs "1.0.0.1" compared
/// equal) — then, for an equal numeric core, a release (no suffix)
/// outranks any pre-release suffix, and two pre-release suffixes compare
/// lexicographically. Good enough to place a `-preview.N`/`-rc.N` tag
/// correctly relative to the final release sharing its numeric core; not a
/// full SemVer 2.0 precedence comparison of dotted pre-release identifiers.
let private parseVersionForRange (v: string) : int[] * string =
    let dashIdx = v.IndexOf('-')
    let core, suffix = if dashIdx >= 0 then v.Substring(0, dashIdx), v.Substring(dashIdx + 1) else v, ""
    let parts =
        core.Split('.')
        |> Array.truncate 4
        |> Array.map (fun p -> match Int32.TryParse p with | true, n -> n | false, _ -> 0)
    Array.append parts (Array.zeroCreate (max 0 (4 - parts.Length))), suffix

let private compareVersionForRange (a: string) (b: string) : int =
    let (na, sa), (nb, sb) = parseVersionForRange a, parseVersionForRange b
    let numCmp = Seq.zip na nb |> Seq.tryPick (fun (x, y) -> if x <> y then Some(compare x y) else None) |> Option.defaultValue 0
    if numCmp <> 0 then numCmp
    elif sa = sb then 0
    elif sa = "" then 1 // release outranks pre-release
    elif sb = "" then -1
    else compare sa sb

/// True when `version` is in `(oldVersion, newVersion]` by SemVer-ish
/// precedence — inclusive of new, exclusive of old, per Rule 2.
let versionInRange (oldVersion: string) (newVersion: string) (version: string) : bool =
    compareVersionForRange version oldVersion > 0 && compareVersionForRange version newVersion <= 0

/// Only ever `GITHUB_TOKEN` set explicitly by whoever invoked the script —
/// never harvested automatically (e.g. by shelling out to `gh auth token`).
/// The script should not reach for a credential on its own; a token is used
/// only when its owner chose to hand it over for this run.
///
/// Release notes no longer need it at all — those come from the public
/// releases page (see `fetchGithubWebReleases`). It is still worth setting
/// for the two remaining `api.github.com` calls, both of which are only
/// reached on the *tags-without-Releases* path: `githubTags` and
/// `githubCompareCommits`.
let private resolvedGithubToken : Lazy<string option> =
    lazy (Environment.GetEnvironmentVariable("GITHUB_TOKEN") |> Option.ofObj)

let private githubAuthHeaders () : (string * string) list =
    [ ("Accept", "application/vnd.github+json") ]
    @ (resolvedGithubToken.Value |> Option.map (fun t -> [ ("Authorization", "Bearer " + t) ]) |> Option.defaultValue [])

type private RawGithubRelease = { Tag: string; HtmlUrl: string; Body: string }

/// GitHub's rendered release body (real markup, unlike Atom's escaped
/// `<content>`, which has to be decoded first and stripped second) back into
/// markdown. Structure is preserved rather than flattened: this text is what
/// the human-facing release-notes appendix prints verbatim, and a changelog
/// collapsed into one run-on paragraph is unreadable as a document even
/// though it scans identically for risk markers.
let private htmlFragmentToText (fragment: string) : string =
    let replace pattern (replacement: string) (input: string) =
        Regex.Replace(input, pattern, replacement, RegexOptions.IgnoreCase ||| RegexOptions.Singleline)
    // Keep link targets: release bodies routinely carry the one URL worth
    // following (GitHub's own "Full Changelog: vA...vB" compare link, a PR,
    // a migration guide), and plain tag-stripping would throw exactly those
    // away while keeping the now-meaningless anchor text.
    let withLinkTargets =
        Regex.Replace(
            fragment,
            "<a\\s[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>",
            (fun m ->
                let href = m.Groups.[1].Value
                let text = Regex.Replace(m.Groups.[2].Value, "<[^>]*>", "").Trim()
                if text = "" || text = href then href else sprintf "[%s](%s)" text href),
            RegexOptions.Singleline ||| RegexOptions.IgnoreCase)
    let structured =
        withLinkTargets
        |> replace "<li\\b[^>]*>" "\n- "
        |> replace "<h[1-6][^>]*>" "\n**"
        |> replace "</h[1-6]>" "**\n"
        // `\b` is load-bearing on the `b` alternative: without it `<b[^>]*>`
        // happily matches `<br>` (`b` then `r` as the "attributes"), turning
        // every line break into a stray `**`.
        // Swallow the source newline that usually follows a `<br>`, or the
        // two together become a blank line and split one list item into
        // several paragraphs. A single newline is a lazy continuation, which
        // keeps the wrapped text inside its bullet.
        |> replace "<(br|hr)\\b[^>]*>[ \\t]*\\r?\\n?" "\n"
        |> replace "</?(code|tt)\\b[^>]*>" "`"
        |> replace "</?(strong|b)\\b[^>]*>" "**"
        // No `</li>` here — `<li>` already opened its own line, and closing
        // it again would put a blank line between every bullet.
        |> replace "</(p|div|ul|ol|tr|blockquote|pre)>" "\n"
    let noTags = replace "<[^>]*>" " " structured
    // The body is cut at the opening `<div …>` that carries `Box-footer`, so
    // the tail can end mid-tag — a fragment `<[^>]*>` cannot match and would
    // otherwise survive stripping as literal "<div data" text in the body.
    let noPartialTag = replace "<[^>]*$" " " noTags
    Net.WebUtility.HtmlDecode(noPartialTag)
    // Collapse horizontal runs only — newlines are the structure being kept.
    |> replace "[ \\t]+" " "
    |> replace " *\n *" "\n"
    // The source newline between `</li>` and the next `<li>` survives as a
    // blank line, which renders every changelog list double-spaced.
    |> replace "\n{2,}(?=- )" "\n"
    // A "loose" list (`<li>` wrapping a `<p>`, as OpenTelemetry's notes use)
    // puts a newline straight after the bullet, stranding the marker alone
    // on its line with its text below it.
    |> replace "(?m)^-[ \\t]*\n+" "- "
    |> replace "\n{3,}" "\n\n"
    |> fun s -> s.Trim()

/// One section per release, delimited by the screen-reader-only `<h2>` that
/// heads each entry. That heading — rather than the tag link — is the anchor
/// precisely because a release *body* can itself contain `releases/tag/…`
/// links (notes cross-referencing another version), which would otherwise
/// split one release into several bogus sections.
let private parseGithubReleasesHtml (html: string) : RawGithubRelease list =
    let sections = Regex.Split(html, "<h2[^>]*class=\"sr-only\"[^>]*>")
    if sections.Length <= 1 then
        []
    else
        sections
        |> Array.skip 1
        |> Array.choose (fun section ->
            let href = Regex.Match(section, "href=\"(/[^\"]*/releases/tag/([^\"/#]+))\"")
            if not href.Success then
                None
            else
                let body =
                    let start = Regex.Match(section, "class=\"[^\"]*markdown-body[^\"]*\"[^>]*>")
                    if not start.Success then
                        ""
                    else
                        let rest = section.Substring(start.Index + start.Length)
                        let footer = Regex.Match(rest, "<[a-zA-Z]+[^>]*Box-footer")
                        htmlFragmentToText (if footer.Success then rest.Substring(0, footer.Index) else rest)
                Some
                    { Tag = Net.WebUtility.UrlDecode(href.Groups.[2].Value)
                      HtmlUrl = "https://github.com" + href.Groups.[1].Value
                      Body = body })
        |> Array.toList

/// One fetch per (owner, repo, page) per script run, however many packages in
/// a `diff` batch resolve to it — a monorepo like open-telemetry-dotnet-contrib
/// is exactly this shape: dozens of packages sharing one repo, each of which
/// used to trigger its own independent releases fetch for what turns out to be
/// the same page every time. `Lazy` inside `ConcurrentDictionary` (rather than
/// a plain `Dictionary` + lock, or trusting `GetOrAdd` alone) specifically
/// because `diff` resolves packages in parallel (`Async.Parallel`):
/// `GetOrAdd`'s factory can itself run more than once under a race, but
/// forcing a `Lazy` value is what actually guarantees the expensive part —
/// the HTTP call — executes at most once even then. Keying by page (not just
/// repo) means two packages sharing a repo with different version ranges
/// still reuse every page they have in common.
let private githubWebReleasePageCache = ConcurrentDictionary<string, Lazy<RawGithubRelease list option>>()

let private fetchGithubWebReleasePage (owner: string) (repo: string) (page: int) : RawGithubRelease list option =
    let key = sprintf "%s/%s#%d" (owner.ToLowerInvariant()) (repo.ToLowerInvariant()) page
    let lazyValue =
        githubWebReleasePageCache.GetOrAdd(
            key,
            fun _ ->
                lazy
                    (let url = sprintf "https://github.com/%s/%s/releases?page=%d" owner repo page
                     getStringAsync url [] |> Option.map parseGithubReleasesHtml)
        )
    lazyValue.Value

/// Ten releases per page, so this is a 300-release ceiling — a guard against
/// walking the entire history of an ancient repo when `oldVersion` can't be
/// found at all, not a limit any realistic bump range should reach.
let private githubWebReleasesMaxPages = 30

/// The releases page (`github.com/<owner>/<repo>/releases?page=N`) is served
/// by the web app rather than `api.github.com`: no token, and not subject to
/// the REST quota that a batch of packages exhausts in one sitting. Unlike
/// the Atom feed — which is the same web-app origin but only ever exposes the
/// ~10 newest releases with no way to page back — this walks pages until it
/// passes `oldVersion`, so it can actually cover the whole reviewed range
/// rather than just its recent end. That coverage is what makes it the
/// primary source here and leaves Atom as the fallback for when it fails.
///
/// `Some(releases, complete)`; `complete = false` means the walk stopped at
/// the page cap without ever reaching a release at or below `oldVersion`, so
/// older in-range entries may be missing and the caller must not report the
/// result as authoritative.
let private fetchGithubWebReleases (owner: string) (repo: string) (oldVersion: string) : (RawGithubRelease list * bool) option =
    let reachesOldVersion (batch: RawGithubRelease list) =
        batch
        |> List.exists (fun r ->
            let m = Regex.Match(r.Tag, @"\d+\.\d+\.\d+(?:\.\d+)?")
            m.Success && compareVersionForRange m.Value oldVersion <= 0)
    let rec walk page acc =
        if page > githubWebReleasesMaxPages then
            Some(acc, false)
        else
            match fetchGithubWebReleasePage owner repo page with
            // A failed page mid-walk still leaves real releases in hand —
            // report them, but never as complete.
            | None -> if List.isEmpty acc then None else Some(acc, false)
            // Ran out of releases before `oldVersion` showed up: the repo
            // simply has no release that old, and the whole history was seen.
            | Some [] -> Some(acc, true)
            | Some batch ->
                let acc = acc @ batch
                if reachesOldVersion batch then Some(acc, true) else walk (page + 1) acc
    walk 1 []

let private atomNs = XNamespace.Get("http://www.w3.org/2005/Atom")

/// Fallback for when scraping the releases page itself fails (markup change,
/// a blocked/unavailable response): `releases.atom` is the same web-app
/// origin, needs no token either, and its fixed XML shape is far less likely
/// to break than HTML scraping — but it only ever lists the ~10 most recent
/// releases with no reliable way to page further back, so it can silently
/// miss an older `oldVersion` boundary. Callers must treat this as a
/// candidate needing the "may be incomplete" warning
/// (`githubReleases`/`resolveNotes` below), never as an authoritative range.
/// One fetch per (owner, repo) per run, same cache reasoning as the page
/// cache above.
let private githubAtomReleasesCache = ConcurrentDictionary<string, Lazy<RawGithubRelease list option>>()

let private fetchGithubAtomReleases (owner: string) (repo: string) : RawGithubRelease list option =
    let key = (owner + "/" + repo).ToLowerInvariant()
    let lazyValue =
        githubAtomReleasesCache.GetOrAdd(
            key,
            fun _ ->
                lazy
                    (let url = sprintf "https://github.com/%s/%s/releases.atom" owner repo
                     getStringAsync url []
                     |> Option.bind (fun xml ->
                         try
                             let doc = XDocument.Parse(xml)
                             doc.Descendants(atomNs + "entry")
                             |> Seq.map (fun e ->
                                 let tag = match e.Element(atomNs + "title") with null -> "" | t -> t.Value
                                 let htmlUrl =
                                     e.Elements(atomNs + "link")
                                     |> Seq.tryPick (fun l ->
                                         let rel = l.Attribute(XName.Get "rel")
                                         let href = l.Attribute(XName.Get "href")
                                         if (isNull rel || rel.Value = "alternate") && not (isNull href) then Some href.Value else None)
                                     |> Option.defaultValue (sprintf "https://github.com/%s/%s/releases/tag/%s" owner repo tag)
                                 // Atom's <content type="html"> is HTML-escaped markup, not
                                 // plain text — decode entities and strip tags so risk-marker
                                 // matching and any body preview read the same as a scraped body.
                                 let rawContent = match e.Element(atomNs + "content") with null -> "" | c -> c.Value
                                 let body = Regex.Replace(Net.WebUtility.HtmlDecode(rawContent), "<[^>]+>", " ")
                                 { Tag = tag; HtmlUrl = htmlUrl; Body = body })
                             |> Seq.toList
                             |> Some
                         with _ -> None))
        )
    lazyValue.Value

/// The full version a tag carries, prerelease suffix included
/// ("core-1.18.0-rc.1" → "1.18.0-rc.1") — the plain in-range check only needs
/// the numeric core, but matching a changelog heading needs the whole thing.
let private tagFullVersion (tag: string) : string option =
    let m = Regex.Match(tag, @"\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.\-]+)?")
    if m.Success then Some m.Value else None

let private componentChangelogCache = ConcurrentDictionary<string, Lazy<string option>>()

let private fetchComponentChangelog (url: string) : string option =
    (componentChangelogCache.GetOrAdd(url, fun _ -> lazy (getStringAsync url []))).Value

/// A repo that ships many packages under one umbrella tag usually still keeps
/// a per-component `CHANGELOG.md`, and links it from the release body itself
/// ("See CHANGELOG for details"). This picks the link whose directory *is*
/// this package — the path comes from the release upstream published, never
/// from a guessed convention — and rewrites it to `raw.githubusercontent.com`
/// at `preferredRef`, the newest tag in range, whose copy of the file holds
/// the whole history the range needs in one fetch.
let private componentChangelogRawUrl (packageId: string) (preferredRef: string) (body: string) : string option =
    Regex.Matches(body, @"https://github\.com/([^/\s)]+)/([^/\s)]+)/blob/[^/\s)]+/(\S*?)/CHANGELOG\.md")
    |> Seq.cast<Match>
    |> Seq.tryPick (fun m ->
        let path = m.Groups.[3].Value
        let leaf = path.Split('/') |> Array.last
        if leaf.Equals(packageId, StringComparison.OrdinalIgnoreCase) then
            Some(
                sprintf
                    "https://raw.githubusercontent.com/%s/%s/%s/%s/CHANGELOG.md"
                    m.Groups.[1].Value
                    m.Groups.[2].Value
                    preferredRef
                    path
            )
        else
            None)

/// `## 1.18.0` / `## [1.18.0] - 2026-01-01` / `## v1.18.0` sections, keyed by
/// the version each documents.
let private changelogSections (markdown: string) : Map<string, string> =
    let lines = markdown.Replace("\r\n", "\n").Split('\n')
    let heads =
        lines
        |> Array.mapi (fun i line -> (i, Regex.Match(line, @"^##\s+\[?v?(\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.\-]+)?)\]?")))
        |> Array.filter (fun (_, m) -> m.Success)
        |> Array.map (fun (i, m) -> (i, m.Groups.[1].Value))
    heads
    |> Array.mapi (fun idx (start, version) ->
        let stop = if idx + 1 < heads.Length then fst heads.[idx + 1] else lines.Length
        // Drop the `## <version>` line itself: the caller already prints the
        // release tag as that entry's heading, and an `h2` nested under it
        // would break the report's outline.
        (version, String.Join("\n", lines.[start + 1 .. stop - 1]).Trim()))
    |> Map.ofArray

/// Filters the cached raw release list to `(oldVersion, newVersion]` and
/// flags each entry `UnrelatedComponent` against `packageId` (see
/// `tagComponentPrefix`/`componentMatchesPackage`) — the only part of this
/// that's actually specific to one package; the network fetch above is not.
/// Shared by both the scraped releases page and the Atom-feed fallback.
let private filterGithubReleases (raw: RawGithubRelease list) (packageId: string) (oldVersion: string) (newVersion: string) : Release list =
    let inRange =
        raw
        |> List.choose (fun r ->
            // Filter by the version number embedded in the tag, tolerant of
            // any prefix ("v8.1.0", "Package_8.1.0") — a tag with no
            // recognizable version is skipped.
            let m = Regex.Match(r.Tag, @"\d+\.\d+\.\d+(?:\.\d+)?")
            if m.Success && versionInRange oldVersion newVersion m.Value then
                Some(r, tagComponentPrefix r.Tag)
            else
                None)
    // A component prefix only means "some *other* component's tag" when this
    // repo demonstrably tags this package too. If nothing in range names the
    // package, the prefix is an umbrella covering the whole repo rather than
    // a sibling component — `open-telemetry/opentelemetry-dotnet` ships
    // `OpenTelemetry.Extensions.Hosting` under `core-1.18.0`, and treating
    // `core` as "not my component" discarded all 17 in-range bodies and left
    // the reader a bare tag list, which is exactly what sent a real review
    // off to fetch the component CHANGELOG.md by hand. Keeping possibly-broad
    // notes beats keeping nothing; the narrowing still applies in the case it
    // was written for (`opentelemetry-dotnet-contrib`, where
    // `Instrumentation.Runtime-1.18.0` does name the package and the other 75
    // component tags really are noise).
    let tagsNamePackage =
        inRange
        |> List.exists (fun (_, prefix) ->
            match prefix with
            | Some p -> componentMatchesPackage packageId p
            | None -> true)
    // In the umbrella case the bodies are the *bundle's* notes, most of which
    // is other packages' changes. If the release links this package's own
    // `CHANGELOG.md`, that file answers both questions precisely and in one
    // fetch: what changed for this component, and whether a given release
    // touched it at all (no section for that version ⇒ it didn't). Measured
    // on `OpenTelemetry.Extensions.Hosting` 1.14.0 → 1.18.0: ~32KB of
    // umbrella bodies — which also produced 8 risk flags earned by sibling
    // packages' text — down to ~0.9KB of this component's own entries.
    let componentChangelog =
        if tagsNamePackage then
            None
        else
            let newestRef = inRange |> List.tryHead |> Option.map (fun (r, _) -> r.Tag)
            newestRef
            |> Option.bind (fun ref ->
                inRange |> List.tryPick (fun (r, _) -> componentChangelogRawUrl packageId ref r.Body))
            |> Option.bind fetchComponentChangelog
            |> Option.map changelogSections
            |> Option.filter (fun sections -> not sections.IsEmpty)

    inRange
    |> List.map (fun (r, prefix) ->
        let fromChangelog =
            componentChangelog
            |> Option.map (fun sections ->
                tagFullVersion r.Tag |> Option.bind (fun v -> sections.TryFind v))
        match fromChangelog with
        | Some(Some section) ->
            { Tag = r.Tag
              Url = r.HtmlUrl
              HasRiskMarker = hasRiskMarker section
              UnrelatedComponent = false
              BodyPreview = bodyPreviewFor false section }
        | Some None ->
            // The component changelog has no entry for this release, so this
            // release did not touch this package.
            { Tag = r.Tag
              Url = r.HtmlUrl
              HasRiskMarker = false
              UnrelatedComponent = true
              BodyPreview = "" }
        | None ->
            let unrelated =
                tagsNamePackage
                && (match prefix with
                    | Some p -> not (componentMatchesPackage packageId p)
                    | None -> false)
            { Tag = r.Tag
              Url = r.HtmlUrl
              HasRiskMarker = hasRiskMarker r.Body
              UnrelatedComponent = unrelated
              BodyPreview = bodyPreviewFor unrelated r.Body })
    |> List.sortBy (fun r -> r.Tag)

/// `Some(releases, incompleteSource)`. `incompleteSource = None` means the
/// source walked the whole reviewed range; `Some reason` marks a candidate
/// list that may be missing older in-range releases, which `resolveNotes`
/// must surface as a warning and never report as `"ok"`.
let githubReleases (owner: string) (repo: string) (packageId: string) (oldVersion: string) (newVersion: string) : (Release list * string option) option =
    match fetchGithubWebReleases owner repo oldVersion with
    | Some(raw, complete) ->
        Some(filterGithubReleases raw packageId oldVersion newVersion, (if complete then None else Some "page-limit"))
    | None ->
        fetchGithubAtomReleases owner repo
        |> Option.map (fun raw -> filterGithubReleases raw packageId oldVersion newVersion, Some "atom-feed")

/// Plain tags — not "Releases". Observed live on two different real repos
/// (TelegramBots/Telegram.Bot, npgsql/efcore.pg): a repo can keep tagging
/// every version while quietly no longer creating a GitHub "Release" object
/// for some/all of them, so `githubReleases` alone silently comes back
/// empty (or missing exactly the version being reviewed) even though the
/// tag — and its commits — are right there. Used only to check for that gap
/// and to resolve the exact tag string `githubCompareCommits` needs (a bare
/// version number is not a valid git ref).
let githubTags (owner: string) (repo: string) : string list option =
    let url = sprintf "https://api.github.com/repos/%s/%s/tags?per_page=100" owner repo
    getStringAsync url (githubAuthHeaders ())
    |> Option.map (fun json ->
        use doc = JsonDocument.Parse(json)
        doc.RootElement.EnumerateArray()
        |> Seq.choose (fun t -> match t.TryGetProperty("name") with | true, n -> Some(n.GetString()) | _ -> None)
        |> Seq.toList)

/// The tag whose embedded version number is an exact match for `version`
/// ("v10.0.3" for "10.0.3") — `compare` takes ref names, not bare numbers.
let private findTagForVersion (tags: string list) (version: string) : string option =
    tags
    |> List.tryFind (fun t ->
        let m = Regex.Match(t, @"\d+\.\d+\.\d+(?:\.\d+)?")
        m.Success && m.Value = version)

type CommitSummary = { Sha: string; Url: string; Message: string; HasRiskMarker: bool }

/// One `compare` call for the *whole* `baseTag..headTag` span instead of one
/// per tag missing its own Release — every commit in the range regardless of
/// which individual tags do or don't have a Release object, in a single
/// request. `message` is the commit's subject line: a monorepo compare can
/// run into the hundreds of commits, and the subject is what triage actually
/// reads. A flagged commit additionally carries a direct commit-page `url` —
/// the route to the *diff*, which is what a closer look genuinely needs —
/// and its full body only in the one case where the body is what earned the
/// flag (a `BREAKING CHANGE:` footer under a neutral subject). When the
/// subject already carries the marker the body is redundant with it:
/// verified live, the single flagged commit in a real 65-commit range
/// ("Removed AsyncEnumerableReceivers") had no body beyond that subject at
/// all, so carrying "the full message" bought exactly nothing.
/// One fetch per (owner, repo, baseTag, headTag) per script run — same
/// reasoning as the release-page cache, and just as real in practice: a
/// monorepo like `dotnet/dotnet` backs *many* NuGet package ids at once, and
/// a coordinated bump (EF Core + several `Microsoft.Extensions.*` ids, say)
/// typically moves them all between the exact same two tags, so without this
/// every one of those ids would independently re-run — and independently
/// embed — the identical multi-hundred-commit compare result (observed
/// live: 9 ids sharing one bump each carried their own copy of the same 250
/// commits before this cache/the output-level dedup in `runDiff` existed).
let private githubCompareCommitsCache = ConcurrentDictionary<string, Lazy<CommitSummary list option>>()

let githubCompareCommits (owner: string) (repo: string) (baseTag: string) (headTag: string) : CommitSummary list option =
    let key = sprintf "%s/%s/%s...%s" (owner.ToLowerInvariant()) (repo.ToLowerInvariant()) baseTag headTag
    let lazyValue =
        githubCompareCommitsCache.GetOrAdd(
            key,
            fun _ ->
                lazy
                    (let url =
                        sprintf "https://api.github.com/repos/%s/%s/compare/%s...%s"
                            owner repo (Uri.EscapeDataString baseTag) (Uri.EscapeDataString headTag)
                     getStringAsync url (githubAuthHeaders ())
                     |> Option.map (fun json ->
                         use doc = JsonDocument.Parse(json)
                         match doc.RootElement.TryGetProperty("commits") with
                         | true, commits ->
                             commits.EnumerateArray()
                             |> Seq.choose (fun c ->
                                 match c.TryGetProperty("sha"), c.TryGetProperty("commit") with
                                 | (true, shaEl), (true, commitEl) ->
                                     match commitEl.TryGetProperty("message") with
                                     | true, msgEl ->
                                         let fullMessage = msgEl.GetString()
                                         let firstLine = fullMessage.Split('\n').[0].Trim()
                                         let risky = hasRiskMarker fullMessage
                                         let sha = shaEl.GetString()
                                         let limit = 2000
                                         let message =
                                             // The body earns its place only when it is what
                                             // triggered the flag — a `BREAKING CHANGE:` footer
                                             // under a neutral subject — because then the subject
                                             // alone leaves an unexplained ⚠ the agent has to go
                                             // fetch. When the subject already carries the marker
                                             // the body adds nothing to the verdict (verified live:
                                             // the one flagged commit in a real 65-commit range had
                                             // no body beyond its subject at all), and a closer look
                                             // needs the diff, which `url` points at, not the prose.
                                             if not risky || hasRiskMarker firstLine then
                                                 firstLine
                                             elif fullMessage.Length > limit then
                                                 fullMessage.Substring(0, limit) + "…"
                                             else
                                                 fullMessage
                                         Some
                                             { Sha = sha.Substring(0, min 7 sha.Length)
                                               Url = sprintf "https://github.com/%s/%s/commit/%s" owner repo sha
                                               Message = message
                                               HasRiskMarker = risky }
                                     | _ -> None
                                 | _ -> None)
                             |> Seq.toList
                         | false, _ -> []))
        )
    lazyValue.Value

/// GitHub-only supplementary lookup, run *after* `githubReleases`: when the
/// target `newVersion` isn't covered by any Release object, resolve its tag
/// and the `oldVersion` tag and pull the raw commit log between them instead
/// of leaving that gap for the agent to notice and query by hand. Cheap to
/// skip in the common case — only fires when `releases` doesn't already
/// cover `newVersion`, not on every lookup.
let githubCommitFallback (owner: string) (repo: string) (oldVersion: string) (newVersion: string) (releases: Release list) : CommitSummary list * string option =
    let newVersionHasRelease =
        releases
        |> List.exists (fun r ->
            let m = Regex.Match(r.Tag, @"\d+\.\d+\.\d+(?:\.\d+)?")
            m.Success && m.Value = newVersion)
    if newVersionHasRelease then
        [], None
    else
        match githubTags owner repo with
        | None -> [], None
        | Some tags ->
            match findTagForVersion tags oldVersion, findTagForVersion tags newVersion with
            | Some baseTag, Some headTag ->
                let compareUrl = sprintf "https://github.com/%s/%s/compare/%s...%s" owner repo baseTag headTag
                match githubCompareCommits owner repo baseTag headTag with
                | Some commits -> commits, Some compareUrl
                | None -> [], Some compareUrl
            | _ -> [], None

let private isDotnetUmbrellaRepo (owner: string) (repo: string) : bool =
    owner.Equals("dotnet", StringComparison.OrdinalIgnoreCase) && repo.Equals("dotnet", StringComparison.OrdinalIgnoreCase)

/// `dotnet/dotnet` is an umbrella monorepo with no per-package Releases at
/// all — every `Microsoft.EntityFrameworkCore*`/`Microsoft.AspNetCore.*`/
/// `Microsoft.Extensions.*` id bumped as part of a .NET servicing release
/// resolves to this one repo, so `githubReleases`/`githubCommitFallback`
/// have nothing useful to fetch there. But that's the wrong question to ask
/// of this repo in the first place: within one .NET major, a servicing
/// release is contractually non-breaking (security/bug fixes only, per
/// Microsoft's own compatibility policy) — there is nothing to check.
/// Breaking changes only ever happen *across* a major, and Microsoft
/// documents those at two fixed, well-known URLs per major version rather
/// than per patch, so a *crossing* bump gets pointers to those instead of
/// any per-package lookup at all. Either way this needs zero network calls
/// — the whole point is that fetching this repo's own releases/commits was
/// always the wrong signal for this family.
type DotnetUmbrellaResult =
    { SameMajor: bool
      CompatibilityDocsUrl: string option
      AspNetCoreBreakingChangesUrl: string option }

let dotnetUmbrellaCheck (oldVersion: string) (newVersion: string) : DotnetUmbrellaResult option =
    match majorOf oldVersion, majorOf newVersion with
    | Some om, Some nm when om = nm -> Some { SameMajor = true; CompatibilityDocsUrl = None; AspNetCoreBreakingChangesUrl = None }
    | Some _, Some nm ->
        Some
            { SameMajor = false
              CompatibilityDocsUrl = Some(sprintf "https://learn.microsoft.com/en-us/dotnet/core/compatibility/%d" nm)
              AspNetCoreBreakingChangesUrl = Some(sprintf "https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/%d/overview?view=aspnetcore-%d.0" nm nm) }
    | _ -> None

let gitlabReleases (owner: string) (repo: string) (oldVersion: string) (newVersion: string) : Release list option =
    let projectPath = Uri.EscapeDataString(owner + "/" + repo)
    let url = sprintf "https://gitlab.com/api/v4/projects/%s/releases?per_page=100" projectPath
    getStringAsync url []
    |> Option.map (fun json ->
        use doc = JsonDocument.Parse(json)
        doc.RootElement.EnumerateArray()
        |> Seq.choose (fun r ->
            let tag = match r.TryGetProperty("tag_name") with | true, t -> t.GetString() | _ -> ""
            let m = Regex.Match(tag, @"\d+\.\d+\.\d+(?:\.\d+)?")
            if m.Success && versionInRange oldVersion newVersion m.Value then
                let body = match r.TryGetProperty("description") with | true, b when b.ValueKind = JsonValueKind.String -> b.GetString() | _ -> ""
                let risky = hasRiskMarker body
                Some
                    { Tag = tag
                      Url = sprintf "https://gitlab.com/%s/%s/-/releases/%s" owner repo tag
                      HasRiskMarker = risky
                      UnrelatedComponent = false
                      BodyPreview = bodyPreviewFor false body }
            else
                None)
        |> Seq.sortBy (fun r -> r.Tag)
        |> Seq.toList)

/// Neither host exposes a GitHub-style "release with a changelog body" — only
/// a tag list. Degrades to tags-only, each flagged as needing a manual read
/// since there is no body here to pre-scan for risk markers.
let tagsOnlyReleases (tags: string list) (oldVersion: string) (newVersion: string) (urlFor: string -> string) : Release list =
    tags
    |> List.choose (fun tag ->
        let m = Regex.Match(tag, @"\d+\.\d+\.\d+(?:\.\d+)?")
        if m.Success && versionInRange oldVersion newVersion m.Value then
            Some { Tag = tag; Url = urlFor tag; HasRiskMarker = false; UnrelatedComponent = false; BodyPreview = "" }
        else
            None)
    |> List.sortBy (fun r -> r.Tag)

let bitbucketReleases (owner: string) (repo: string) (oldVersion: string) (newVersion: string) : Release list option =
    let url = sprintf "https://api.bitbucket.org/2.0/repositories/%s/%s/refs/tags?pagelen=100" owner repo
    getStringAsync url []
    |> Option.map (fun json ->
        use doc = JsonDocument.Parse(json)
        let tags =
            match doc.RootElement.TryGetProperty("values") with
            | true, v -> v.EnumerateArray() |> Seq.choose (fun t -> match t.TryGetProperty("name") with | true, n -> Some(n.GetString()) | _ -> None) |> Seq.toList
            | false, _ -> []
        tagsOnlyReleases tags oldVersion newVersion (fun tag -> sprintf "https://bitbucket.org/%s/%s/src/%s" owner repo tag))

let azureDevOpsReleases (owner: string) (repo: string) (oldVersion: string) (newVersion: string) : Release list option =
    // `owner` here is "org/project" (Azure DevOps URLs are dev.azure.com/org/project/_git/repo).
    let url = sprintf "https://dev.azure.com/%s/_apis/git/repositories/%s/refs?filter=tags&api-version=7.0" owner repo
    getStringAsync url []
    |> Option.map (fun json ->
        use doc = JsonDocument.Parse(json)
        let tags =
            match doc.RootElement.TryGetProperty("value") with
            | true, v ->
                v.EnumerateArray()
                |> Seq.choose (fun t ->
                    match t.TryGetProperty("name") with
                    | true, n -> Some((n.GetString()).Replace("refs/tags/", ""))
                    | _ -> None)
                |> Seq.toList
            | false, _ -> []
        tagsOnlyReleases tags oldVersion newVersion (fun tag -> sprintf "https://dev.azure.com/%s/_git/%s/?version=GT%s" owner repo tag))

type NotesResolution =
    { RepoUrl: string option
      Host: string option
      /// Where releases/tags are actually published for the resolved host —
      /// e.g. `https://github.com/<owner>/<repo>/releases` — computed from
      /// `RepoUrl` alone (no network), so it's available even when the API
      /// call itself failed or the host has no releases endpoint this
      /// script can call. A concrete link to open by hand beats a bare repo
      /// root when the automatic fetch came up empty.
      ReleasesUrl: string option
      ReleaseNotesFromNuspec: string option
      Releases: Release list
      LocalChangelogFile: string option
      LocalChangelogPreview: string option
      /// GitHub-only: raw commit log for `oldVersion..newVersion`, only
      /// populated when `newVersion`'s own tag isn't covered by a Release
      /// object (see `githubCommitFallback`) — empty otherwise, including
      /// on every non-GitHub host.
      CommitFallback: CommitSummary list
      /// `https://github.com/<owner>/<repo>/compare/<oldTag>...<newTag>` —
      /// set whenever both tags were resolved, even if the compare call
      /// itself failed, so there is still a concrete link to open by hand.
      CommitsCompareUrl: string option
      /// Set when `"releases"` may be missing older in-range entries, so the
      /// list is a candidate rather than the authoritative range: `"atom-feed"`
      /// (scraping the releases page failed, so this came from the ~10-newest
      /// Atom feed) or `"page-limit"` (the page walk hit its cap without ever
      /// reaching `oldVersion`). `None` = the whole range was covered. See
      /// `githubReleases`/the `incompleteRangeWarning` hint text.
      IncompleteSource: string option
      /// `dotnet/dotnet` only (see `dotnetUmbrellaCheck`) — `true` when
      /// `oldVersion`/`newVersion` share a major: a .NET servicing release
      /// within one major is contractually non-breaking, so there is
      /// nothing further to check for this id. `false` on a major crossing
      /// (see the two URLs below); `None` on every other repo.
      DotnetSameMajor: bool option
      /// Set only on a `dotnet/dotnet` *major* crossing — Microsoft's fixed,
      /// per-major (not per-patch) breaking-changes reference. URL only, no
      /// fetch: `https://learn.microsoft.com/en-us/dotnet/core/compatibility/<major>`.
      CompatibilityDocsUrl: string option
      /// Same crossing, the ASP.NET Core-specific counterpart:
      /// `https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/<major>/overview?view=aspnetcore-<major>.0`.
      AspNetCoreBreakingChangesUrl: string option
      Resolution: string // "ok" | "partial" | "unresolved-manual-required"
      FallbackHints: string list }

/// The whole `notes` lookup as a pure(-ish) computation, shared by the
/// standalone `notes` subcommand and `diff`'s "fetch notes for every
/// changed package while I'm at it" mode — one place that knows how to
/// resolve a package's release notes, instead of two copies drifting apart.
type RepoInfo =
    { RepoUrl: string option
      Host: string option
      ReleasesUrl: string option
      ReleaseNotesFromNuspec: string option }

/// The zero-network half of `notes` — nuspec read only, no host API call —
/// so `diff --no-notes` can still hand back a concrete repo/releases link
/// (and the nuspec's own release notes, already on disk) instantly instead
/// of only the bare version bump with nothing to click on.
let resolveRepoInfo (packageId: string) (newVersion: string) : RepoInfo =
    let nuspec = findLocalNuspec packageId newVersion
    let releaseNotesFromNuspec =
        nuspec |> Option.bind (fun n -> nuspecField n "releaseNotes")
    let repoUrl = nuspec |> Option.bind nuspecRepoUrl
    let repoRef = repoUrl |> Option.bind parseRepoUrl
    let releasesUrl = repoRef |> Option.map releasesUrlFor
    { RepoUrl = repoUrl
      Host = repoRef |> Option.map (fun r -> r.Host)
      ReleasesUrl = releasesUrl
      ReleaseNotesFromNuspec = releaseNotesFromNuspec }

let repoInfoJson (r: RepoInfo) =
    jobj
        [ ("repoUrl", jstrOpt r.RepoUrl)
          ("host", jstrOpt r.Host)
          ("releasesUrl", jstrOpt r.ReleasesUrl)
          ("releaseNotesFromNuspec", jstrOpt r.ReleaseNotesFromNuspec) ]

let resolveNotes (packageId: string) (oldVersion: string) (newVersion: string) : NotesResolution =
    let repoInfo = resolveRepoInfo packageId newVersion
    let releaseNotesFromNuspec = repoInfo.ReleaseNotesFromNuspec
    let repoUrl = repoInfo.RepoUrl
    let repoRef = repoUrl |> Option.bind parseRepoUrl
    let releasesUrl = repoInfo.ReleasesUrl

    // `dotnet/dotnet` has no per-package Releases at all, but that's the
    // wrong question for this family anyway (see `dotnetUmbrellaCheck`) —
    // short-circuit entirely, zero network calls, before any of the
    // generic release/tag/commit-log machinery below even runs.
    let isDotnetUmbrella = repoRef |> Option.exists (fun r -> r.Host = "github" && isDotnetUmbrellaRepo r.Owner r.Repo)

    match if isDotnetUmbrella then dotnetUmbrellaCheck oldVersion newVersion else None with
    | Some check ->
        let resolution, fallbackHints =
            if check.SameMajor then
                "ok",
                [ sprintf
                    "%s and %s are the same .NET major — a servicing release within one major is contractually non-breaking (security/bug fixes only) per Microsoft's compatibility policy, so there is nothing further to check for this id."
                    oldVersion newVersion ]
            else
                "partial",
                [ "Major version crossing on a dotnet/dotnet-family id — breaking changes are possible and documented per-major (not per-patch) at the two URLs in \"compatibilityDocsUrl\"/\"aspNetCoreBreakingChangesUrl\"; read whichever applies to this package before concluding Compatible." ]
        { RepoUrl = repoUrl
          Host = repoRef |> Option.map (fun r -> r.Host)
          ReleasesUrl = releasesUrl
          ReleaseNotesFromNuspec = releaseNotesFromNuspec
          Releases = []
          LocalChangelogFile = None
          LocalChangelogPreview = None
          CommitFallback = []
          CommitsCompareUrl = None
          IncompleteSource = None
          DotnetSameMajor = Some check.SameMajor
          CompatibilityDocsUrl = check.CompatibilityDocsUrl
          AspNetCoreBreakingChangesUrl = check.AspNetCoreBreakingChangesUrl
          Resolution = resolution
          FallbackHints = fallbackHints }
    | None ->

    let releases, fetchFailed, incompleteSource =
        match repoRef with
        | Some r when r.Host = "github" ->
            match githubReleases r.Owner r.Repo packageId oldVersion newVersion with
            | Some(rs, incomplete) -> rs, false, incomplete
            | None -> [], true, None
        | Some r when r.Host = "gitlab" ->
            match gitlabReleases r.Owner r.Repo oldVersion newVersion with
            | Some rs -> rs, false, None
            | None -> [], true, None
        | Some r when r.Host = "bitbucket" ->
            match bitbucketReleases r.Owner r.Repo oldVersion newVersion with
            | Some rs -> rs, false, None
            | None -> [], true, None
        | Some r when r.Host = "azure-devops" ->
            match azureDevOpsReleases r.Owner r.Repo oldVersion newVersion with
            | Some rs -> rs, false, None
            | None -> [], true, None
        | _ -> [], false, None

    // GitHub only: a repo can keep tagging every version while no longer
    // creating a "Release" object for some/all of them (observed live on
    // TelegramBots/Telegram.Bot and npgsql/efcore.pg — both had tags for the
    // target version with zero matching Release). `githubReleases` alone
    // has no way to surface that gap; this fills it with the raw commit log
    // for the whole range in one extra call, only when actually needed.
    let commitFallback, commitsCompareUrl =
        match repoRef with
        | Some r when r.Host = "github" -> githubCommitFallback r.Owner r.Repo oldVersion newVersion releases
        | _ -> [], None

    // Private/no-public-repo fallback the skill's own manual instructions
    // already name — a changelog bundled inside the `.nupkg` itself, not
    // just the nuspec's own <releaseNotes> field. Only worth the disk walk
    // once the structured sources above came up empty.
    let localChangelog =
        if releases.IsEmpty && commitFallback.IsEmpty then findLocalChangelogFile packageId newVersion else None

    // Either incomplete source is real data that may still be missing older
    // in-range entries — never report one the same way as a full page walk.
    let incompleteRangeWarning =
        match incompleteSource with
        | Some "atom-feed" ->
            sprintf
                "Scraping the releases page failed, so this came from the releases Atom feed instead, which only lists the ~10 most recent releases. If %s predates that window, some releases in range may be missing here. Open %s/%s and check the range by hand."
                oldVersion
                (repoUrl |> Option.defaultValue "the repo")
                "releases"
        | Some "page-limit" ->
            sprintf
                "Walked %d pages of the releases page (~%d releases) without reaching %s, and stopped there — releases older than that point are missing. Either the range is genuinely enormous or %s has no release at all, in which case \"commitFallback\"/the tag list is the better source for the older end."
                githubWebReleasesMaxPages (githubWebReleasesMaxPages * 10) oldVersion oldVersion
        | Some other -> sprintf "The release list came from an incomplete source (%s) and may be missing older in-range entries." other
        | None -> ""

    // Only releases actually attributed to this package count as "resolved".
    // A list made entirely of other components' tags carries no body text at
    // all (see `bodyPreviewFor`), so calling that `"ok"` told the reader the
    // notes were in hand while handing them nothing to read.
    let relatedReleaseCount = releases |> List.filter (fun r -> not r.UnrelatedComponent) |> List.length

    let resolution, fallbackHints =
        if incompleteSource.IsNone && (relatedReleaseCount > 0 || not commitFallback.IsEmpty) then
            let hints =
                if commitFallback.IsEmpty then
                    []
                else
                    [ sprintf
                        "No GitHub Release object covers %s itself — \"commitFallback\" has the raw commit log for %s..%s instead (entries with hasRiskMarker=true are worth opening in full via their own commit page)."
                        newVersion oldVersion newVersion ]
            "ok", hints
        elif incompleteSource.IsSome && relatedReleaseCount > 0 then
            "partial", [ incompleteRangeWarning ]
        elif releaseNotesFromNuspec.IsSome || localChangelog.IsSome then
            let hints = ResizeArray<string>()
            hints.Add("No release/tag list was resolved automatically for this range.")
            if incompleteSource.IsSome then hints.Add(incompleteRangeWarning)
            if releaseNotesFromNuspec.IsSome then
                hints.Add("The nuspec's own <releaseNotes> is in \"releaseNotesFromNuspec\" — read it.")
            match localChangelog with
            | Some(file, _) -> hints.Add(sprintf "Found %s in the local NuGet cache — read the full file (\"localChangelogFile\" has the name, \"localChangelogPreview\" only the first ~1000 chars), it may cover more than this preview." file)
            | None -> ()
            "partial", (hints |> Seq.toList)
        else
            let hints = ResizeArray<string>()
            // "Fetch failed" and "fetch succeeded but nothing in this exact
            // range" are different situations — a package can legitimately
            // have zero GitHub Releases for a given patch, or `oldVersion =
            // newVersion` makes the (exclusive, inclusive] range empty by
            // definition. Saying "failed" when the fetch actually succeeded
            // with no matches misdirects the reader toward a retry for a
            // problem that isn't there.
            if incompleteSource.IsSome then
                hints.Add(incompleteRangeWarning)
                hints.Add("That source had nothing in range either — more likely the range falls outside what it covers than that nothing changed.")
            else
                match releasesUrl with
                | Some u when fetchFailed -> hints.Add(sprintf "Automatic fetch failed — open the releases page directly: %s" u)
                | Some u -> hints.Add(sprintf "No release/tag matched this exact range on the host — open the releases page directly to check by hand: %s" u)
                | None ->
                    match repoUrl with
                    | Some u -> hints.Add(sprintf "Repo URL from nuspec: %s — open it manually, host is not one of GitHub/GitLab/Bitbucket/Azure DevOps." u)
                    | None -> hints.Add(sprintf "No repository/projectUrl in the local nuspec. NuGet.org package page: https://www.nuget.org/packages/%s/%s" packageId newVersion)
                if fetchFailed then
                    let isGithub = repoRef |> Option.map (fun r -> r.Host = "github") |> Option.defaultValue false
                    if isGithub then
                        // Neither source uses the API or a token, so this is
                        // not a quota problem: the releases page failed to
                        // fetch/parse *and* the Atom feed failed too.
                        hints.Add("Both the releases page and its Atom feed failed — a network problem, or GitHub's release-page markup changed and the scraper no longer matches it. Open the releases URL above by hand; if the page loads fine in a browser, the parser needs updating.")
                    else
                        hints.Add("The release/tag API call failed or was rate-limited — retry.")
            hints.Add(sprintf "Local NuGet cache: %s" (Path.Combine(nugetPackagesRoot (), packageId.ToLowerInvariant())))
            "unresolved-manual-required", (hints |> Seq.toList)

    { RepoUrl = repoUrl
      Host = repoRef |> Option.map (fun r -> r.Host)
      ReleasesUrl = releasesUrl
      ReleaseNotesFromNuspec = releaseNotesFromNuspec
      Releases = releases
      LocalChangelogFile = localChangelog |> Option.map fst
      LocalChangelogPreview = localChangelog |> Option.map snd
      CommitFallback = commitFallback
      CommitsCompareUrl = commitsCompareUrl
      IncompleteSource = incompleteSource
      DotnetSameMajor = None
      CompatibilityDocsUrl = None
      AspNetCoreBreakingChangesUrl = None
      Resolution = resolution
      FallbackHints = fallbackHints }

let releaseJson (r: Release) =
    jobj
        ([ ("tag", jstr r.Tag)
           ("url", jstr r.Url)
           ("hasRiskMarker", jbool r.HasRiskMarker) ]
         @ (if r.UnrelatedComponent then [ ("unrelatedComponent", jbool true) ] else [])
         // Omitted (not just empty) when suppressed — the point of trimming
         // it is output size, and an empty `"bodyPreview":""` on every
         // uninteresting entry across a large monorepo release list still
         // adds up.
         @ (if r.BodyPreview = "" then [] else [ ("bodyPreview", jstr r.BodyPreview) ]))

let commitSummaryJson (c: CommitSummary) =
    jobj
        ([ ("sha", jstr c.Sha)
           ("message", jstr c.Message)
           ("hasRiskMarker", jbool c.HasRiskMarker) ]
         // Same reasoning as `releaseJson`'s omitted `bodyPreview`: a
         // long-patch-train compare can carry hundreds of these, so only the
         // (typically few) flagged ones — the only ones with a full,
         // multi-line message worth opening the source page for — pay for
         // the extra field.
         @ (if c.HasRiskMarker then [ ("url", jstr c.Url) ] else []))

/// Raw field list (not yet wrapped in `{ }`) so callers can merge it with
/// their own extra fields (`runNotes` adds packageId/old/new; `diff` embeds
/// this as-is under a `"notes"` key) without duplicating the field set.
let notesResolutionFields (n: NotesResolution) : (string * string) list =
    [ ("repoUrl", jstrOpt n.RepoUrl)
      ("host", jstrOpt n.Host)
      ("releasesUrl", jstrOpt n.ReleasesUrl)
      ("releaseNotesFromNuspec", jstrOpt n.ReleaseNotesFromNuspec)
      ("releases", jarr (n.Releases |> List.map releaseJson))
      ("localChangelogFile", jstrOpt n.LocalChangelogFile)
      ("localChangelogPreview", jstrOpt n.LocalChangelogPreview)
      ("commitFallback", jarr (n.CommitFallback |> List.map commitSummaryJson))
      ("commitsCompareUrl", jstrOpt n.CommitsCompareUrl)
      ("incompleteSource", jstrOpt n.IncompleteSource)
      ("dotnetSameMajor", jboolOpt n.DotnetSameMajor)
      ("compatibilityDocsUrl", jstrOpt n.CompatibilityDocsUrl)
      ("aspNetCoreBreakingChangesUrl", jstrOpt n.AspNetCoreBreakingChangesUrl)
      ("resolution", jstr n.Resolution)
      ("fallbackHints", jarr (n.FallbackHints |> List.map jstr)) ]

let notesResolutionJson (n: NotesResolution) = jobj (notesResolutionFields n)

let runNotes (packageId: string) (oldVersion: string) (newVersion: string) : unit =
    let resolved = resolveNotes packageId oldVersion newVersion
    let output =
        jobj
            ([ ("packageId", jstr packageId)
               ("oldVersion", jstr oldVersion)
               ("newVersion", jstr newVersion) ]
             @ notesResolutionFields resolved)
    printfn "%s" output

// ───────────────────────────────── graph ────────────────────────────────────

type ConsumerRequest = { Consumer: string; RequestedRange: string; RequestedMajor: int option }

type Diamond = { PackageId: string; ResolvedVersion: string; Consumers: ConsumerRequest list }

type MajorCrossing =
    { PackageId: string
      Consumer: string
      RequestedRange: string
      RequestedMajor: int
      ResolvedVersion: string
      ResolvedMajor: int
      Ambiguous: bool
      ResolvedAssemblyVersion: string option }

type ProjectGraph =
    { ProjectPath: string
      RestoreOk: bool
      RestoreError: string option
      AssetsFile: string option
      Diamonds: Diamond list
      MajorCrossings: MajorCrossing list }

/// `dotnet sln <path> list` for a solution; the path itself for a single project.
let listProjects (path: string) : string list =
    let ext = Path.GetExtension(path).ToLowerInvariant()
    let full = Path.GetFullPath(path)
    if ext = ".sln" || ext = ".slnx" then
        let r = runCommand "dotnet" [ "sln"; full; "list" ] (Path.GetDirectoryName(full))
        if r.ExitCode <> 0 then
            []
        else
            r.Stdout.Split([| '\r'; '\n' |], StringSplitOptions.RemoveEmptyEntries)
            |> Array.map (fun l -> l.Trim())
            |> Array.filter (fun l ->
                l.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)
                || l.EndsWith(".fsproj", StringComparison.OrdinalIgnoreCase)
                || l.EndsWith(".vbproj", StringComparison.OrdinalIgnoreCase))
            |> Array.map (fun rel -> Path.GetFullPath(Path.Combine(Path.GetDirectoryName(full), rel)))
            |> Array.toList
    else
        [ full ]

/// Best-effort tiebreaker for an ambiguous major crossing (range didn't parse
/// to a clean major on one side): read the resolved package's shipped DLL
/// metadata directly — `AssemblyName.GetAssemblyName` only reads the PE
/// header, it does not load/execute the assembly, so a TFM mismatch between
/// the script's own runtime and the package's target framework is not a
/// problem here. Never throws out of this function; absence just means the
/// caller reports the crossing without this extra confirmation.
let tryReadAssemblyVersion (packageId: string) (version: string) : string option =
    try
        let nugetRoot =
            Environment.GetEnvironmentVariable("NUGET_PACKAGES")
            |> Option.ofObj
            |> Option.defaultValue (Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages"))
        let pkgDir = Path.Combine(nugetRoot, packageId.ToLowerInvariant(), version)
        let libDir = Path.Combine(pkgDir, "lib")
        if not (Directory.Exists libDir) then
            None
        else
            Directory.GetDirectories(libDir)
            |> Array.collect (fun tfmDir -> Directory.GetFiles(tfmDir, packageId + ".dll"))
            |> Array.tryHead
            |> Option.bind (fun dll ->
                try Some((Reflection.AssemblyName.GetAssemblyName(dll)).Version.ToString())
                with _ -> None)
    with _ -> None

/// One project's `obj/project.assets.json`: diamonds + transitive major
/// crossings, in one pass — no per-id `dotnet nuget why` round-trip.
let analyzeProject (projectPath: string) : ProjectGraph =
    let dir = Path.GetDirectoryName(projectPath)
    let assetsPath = Path.Combine(dir, "obj", "project.assets.json")
    if not (File.Exists assetsPath) then
        { ProjectPath = projectPath
          RestoreOk = false
          RestoreError = Some "obj/project.assets.json not found — restore did not produce assets for this project"
          AssetsFile = None
          Diamonds = []
          MajorCrossings = [] }
    else
        use doc = JsonDocument.Parse(File.ReadAllText(assetsPath))
        let root = doc.RootElement

        let resolvedVersions =
            match root.TryGetProperty("libraries") with
            | true, libs ->
                libs.EnumerateObject()
                |> Seq.choose (fun p ->
                    let parts = p.Name.Split('/')
                    if parts.Length = 2 then Some(parts.[0].ToLowerInvariant(), parts.[1]) else None)
                |> Map.ofSeq
            | false, _ -> Map.empty

        // (consumer label, packageId, requestedRange) across every target framework.
        let edges = ResizeArray<string * string * string>()

        let addDependencyEdges (consumerLabel: string) (deps: JsonElement) =
            for d in deps.EnumerateObject() do
                let range =
                    match d.Value.ValueKind with
                    | JsonValueKind.String -> d.Value.GetString()
                    | JsonValueKind.Object ->
                        match d.Value.TryGetProperty("version") with
                        | true, v -> v.GetString()
                        | false, _ -> ""
                    | _ -> ""
                if not (String.IsNullOrWhiteSpace range) then
                    edges.Add(consumerLabel, d.Name, range)

        match root.TryGetProperty("project") with
        | true, proj ->
            match proj.TryGetProperty("frameworks") with
            | true, fws ->
                for fw in fws.EnumerateObject() do
                    match fw.Value.TryGetProperty("dependencies") with
                    | true, deps -> addDependencyEdges "(direct)" deps
                    | false, _ -> ()
            | false, _ -> ()
        | false, _ -> ()

        match root.TryGetProperty("targets") with
        | true, targets ->
            for tfm in targets.EnumerateObject() do
                for consumer in tfm.Value.EnumerateObject() do
                    match consumer.Value.TryGetProperty("dependencies") with
                    | true, deps -> addDependencyEdges consumer.Name deps
                    | false, _ -> ()
        | false, _ -> ()

        let byPackage =
            edges
            |> Seq.groupBy (fun (_, pkgId, _) -> pkgId)
            |> Seq.toList

        let diamonds =
            byPackage
            |> List.choose (fun (pkgId, reqs) ->
                let reqs = reqs |> Seq.toList
                let distinctRanges = reqs |> List.map (fun (_, _, r) -> r.Trim()) |> List.distinct
                match resolvedVersions.TryFind(pkgId.ToLowerInvariant()) with
                | Some resolved when distinctRanges.Length > 1 ->
                    Some
                        { PackageId = pkgId
                          ResolvedVersion = resolved
                          Consumers =
                            reqs
                            |> List.map (fun (consumer, _, range) ->
                                { Consumer = consumer; RequestedRange = range; RequestedMajor = majorOf range }) }
                | _ -> None)

        let majorCrossings =
            byPackage
            |> List.collect (fun (pkgId, reqs) ->
                match resolvedVersions.TryFind(pkgId.ToLowerInvariant()) with
                | None -> []
                | Some resolved ->
                    let resolvedMajor = majorOf resolved
                    reqs
                    |> Seq.toList
                    |> List.choose (fun (consumer, _, range) ->
                        match majorOf range, resolvedMajor with
                        | Some reqMajor, Some resMajor when reqMajor <> resMajor ->
                            let ambiguous = false
                            Some
                                { PackageId = pkgId
                                  Consumer = consumer
                                  RequestedRange = range
                                  RequestedMajor = reqMajor
                                  ResolvedVersion = resolved
                                  ResolvedMajor = resMajor
                                  Ambiguous = ambiguous
                                  ResolvedAssemblyVersion = None }
                        | (None, _) | (_, None) ->
                            // Range didn't parse cleanly — confirm with the shipped
                            // DLL's own assembly version instead of guessing (plan's
                            // "optional deeper check, only when ambiguous").
                            tryReadAssemblyVersion pkgId resolved
                            |> Option.bind (fun asmVer ->
                                majorOf asmVer
                                |> Option.bind (fun asmMajor ->
                                    majorOf range
                                    |> Option.filter (fun reqMajor -> reqMajor <> asmMajor)
                                    |> Option.map (fun reqMajor ->
                                        { PackageId = pkgId
                                          Consumer = consumer
                                          RequestedRange = range
                                          RequestedMajor = reqMajor
                                          ResolvedVersion = resolved
                                          ResolvedMajor = asmMajor
                                          Ambiguous = true
                                          ResolvedAssemblyVersion = Some asmVer })))
                        | _ -> None))

        { ProjectPath = projectPath
          RestoreOk = true
          RestoreError = None
          AssetsFile = Some assetsPath
          Diamonds = diamonds
          MajorCrossings = majorCrossings }

let consumerRequestJson (c: ConsumerRequest) =
    jobj
        [ "consumer", jstr c.Consumer
          "requestedRange", jstr c.RequestedRange
          // A JSON number (or null), matching `majorCrossingJson`'s
          // `requestedMajor` for the same conceptual field — was
          // `jstrOpt` over an already-stringified int, which quoted it
          // into a JSON string ("3") instead of a number (3).
          "requestedMajor", jintOpt c.RequestedMajor ]

let diamondJson (d: Diamond) =
    jobj
        [ "packageId", jstr d.PackageId
          "resolvedVersion", jstr d.ResolvedVersion
          "consumers", jarr (d.Consumers |> List.map consumerRequestJson) ]

let majorCrossingJson (m: MajorCrossing) =
    jobj
        [ "packageId", jstr m.PackageId
          "requestedBy", jstr m.Consumer
          "requestedRange", jstr m.RequestedRange
          "requestedMajor", string m.RequestedMajor
          "resolvedVersion", jstr m.ResolvedVersion
          "resolvedMajor", string m.ResolvedMajor
          "ambiguous", jbool m.Ambiguous
          "resolvedAssemblyVersion", jstrOpt m.ResolvedAssemblyVersion
          "flag", jstr "breaking-candidate" ]

let projectGraphJson (p: ProjectGraph) =
    jobj
        [ "projectPath", jstr p.ProjectPath
          "restoreOk", jbool p.RestoreOk
          "restoreError", jstrOpt p.RestoreError
          "assetsFile", jstrOpt p.AssetsFile
          "diamonds", jarr (p.Diamonds |> List.map diamondJson)
          "majorVersionCrossings", jarr (p.MajorCrossings |> List.map majorCrossingJson) ]

/// Report-skeleton view of one `graph` run — the mechanical facts filled
/// in, an explicit `TODO` left where only the agent can finish the job
/// (cross-checking a flagged diamond/crossing against actual code usage,
/// per Rule 4's "say which were in scope"). Meant to be opened and edited
/// in place for the review's own report, not read start-to-front like the
/// JSON companion file.
let graphMarkdown (target: string) (restore: ProcResult) (results: ProjectGraph list) : string =
    let sb = StringBuilder()
    sb.AppendLine(sprintf "# Dependency review — graph") |> ignore
    sb.AppendLine() |> ignore
    sb.AppendLine(sprintf "Target: `%s`" target) |> ignore
    sb.AppendLine(sprintf "Restore: %s" (if restore.ExitCode = 0 then "ok" else sprintf "**failed** (exit %d)" restore.ExitCode)) |> ignore
    if restore.ExitCode <> 0 && restore.Stderr.Trim() <> "" then
        sb.AppendLine() |> ignore
        sb.AppendLine("```") |> ignore
        sb.AppendLine(restore.Stderr.Trim()) |> ignore
        sb.AppendLine("```") |> ignore
    sb.AppendLine() |> ignore

    for p in results do
        sb.AppendLine(sprintf "## `%s`" p.ProjectPath) |> ignore
        sb.AppendLine() |> ignore
        if not p.RestoreOk then
            sb.AppendLine(sprintf "**Unverified** — %s" (p.RestoreError |> Option.defaultValue "restore did not succeed for this project")) |> ignore
            sb.AppendLine() |> ignore
        else
            if p.Diamonds.IsEmpty then
                sb.AppendLine("Diamonds: none.") |> ignore
            else
                sb.AppendLine(sprintf "Diamonds (%d):" p.Diamonds.Length) |> ignore
                for d in p.Diamonds do
                    let consumers = d.Consumers |> List.map (fun c -> sprintf "`%s` (%s)" c.Consumer c.RequestedRange) |> String.concat ", "
                    sb.AppendLine(sprintf "- `%s` resolved `%s` — requested by: %s" d.PackageId d.ResolvedVersion consumers) |> ignore
            sb.AppendLine() |> ignore
            if p.MajorCrossings.IsEmpty then
                sb.AppendLine("Major version crossings: none.") |> ignore
            else
                sb.AppendLine(sprintf "Major version crossings (%d) — 🔴 breaking-candidate:" p.MajorCrossings.Length) |> ignore
                for m in p.MajorCrossings do
                    let ambiguousNote = if m.Ambiguous then sprintf " (range didn't parse cleanly — confirmed via shipped assembly version `%s`)" (m.ResolvedAssemblyVersion |> Option.defaultValue "?") else ""
                    sb.AppendLine(sprintf "- 🔴 `%s`: `%s` requested major %d by `%s`, resolved `%s` (major %d)%s" m.PackageId m.RequestedRange m.RequestedMajor m.Consumer m.ResolvedVersion m.ResolvedMajor ambiguousNote) |> ignore
            sb.AppendLine() |> ignore

    sb.AppendLine("---") |> ignore
    sb.AppendLine() |> ignore
    sb.AppendLine("**TODO (agent):** for each diamond/crossing above, confirm whether the project's own code actually reaches the affected package (Rule 4) — note which were in scope in the final report, not just what the graph flagged.") |> ignore
    sb.ToString()

let private doRunGraph (full: string) (outPath: string option) : unit =
    let restoreDir = Path.GetDirectoryName(full)
    let restore = runCommand "dotnet" [ "restore"; full ] restoreDir
    let projects = listProjects full

    let results =
        if projects.IsEmpty then
            [ { ProjectPath = full
                RestoreOk = false
                RestoreError = Some "could not enumerate any project for this target (dotnet sln list failed or returned nothing)"
                AssetsFile = None
                Diamonds = []
                MajorCrossings = [] } ]
        else
            projects |> List.map analyzeProject

    let output =
        jobj
            [ "target", jstr full
              "restoreExitCode", string restore.ExitCode
              "restoreOk", jbool (restore.ExitCode = 0)
              "restoreStderr", jstr (restore.Stderr.Trim())
              "projects", jarr (results |> List.map projectGraphJson) ]

    let diamondCount = results |> List.sumBy (fun p -> p.Diamonds.Length)
    let crossingCount = results |> List.sumBy (fun p -> p.MajorCrossings.Length)
    emitResult
        "graph"
        output
        (graphMarkdown full restore results)
        outPath
        []
        [ ("projectCount", string results.Length)
          ("diamondCount", string diamondCount)
          ("majorVersionCrossingCount", string crossingCount) ]

let runGraph (targetPath: string) (outDir: string option) : unit =
    let full = Path.GetFullPath(targetPath)
    if not (File.Exists full) then
        printfn "%s" (jobj [ ("target", jstr full)
                             ("restoreOk", jbool false)
                             ("restoreStderr", jstr (sprintf "target does not exist: %s" full))
                             ("projects", jarr []) ])
    else
        doRunGraph full outDir

// ────────────────────────────────── diff ─────────────────────────────────────

type ManifestChange =
    { PackageId: string
      OldVersion: string option
      NewVersion: string option
      ChangeType: string // "changed" | "added" | "removed"
      Files: string list }

/// Matches a `PackageReference`/`PackageVersion` element's `Include`/`Version`
/// attribute pair regardless of which one comes first in the tag.
let private packageElementPattern =
    Regex(
        """<Package(?:Reference|Version)\b(?:(?:\s+Include="([^"]+)")|(?:\s+Version="([^"]+)"))+[^>]*/?>"""
    )

/// A dedicated attribute scan run only on lines the element pattern already
/// matched — order-independent, and tolerant of extra attributes in between
/// (`PrivateAssets`, `IncludeAssets`, …) that a single combined regex would
/// otherwise have to explicitly skip over.
let private extractIncludeAndVersion (tag: string) : (string * string) option =
    let inc = Regex.Match(tag, "Include=\"([^\"]+)\"")
    let ver = Regex.Match(tag, "Version=\"([^\"]+)\"")
    if inc.Success && ver.Success then Some(inc.Groups.[1].Value, ver.Groups.[1].Value) else None

/// `git diff` (working tree vs `baseRef`, or vs HEAD when `baseRef` is
/// `None`) over the manifest files this skill triggers on, parsed for every
/// package whose `Version` attribute changed. A package that only gained or
/// lost a `PackageReference`/`PackageVersion` line (no matching old/new
/// pair) is reported too, tagged `"added"`/`"removed"` — Rule 1 still wants
/// every id in the diff, not only the ones that changed version.
/// `git diff`'s pathspecs are resolved relative to the invoking cwd and
/// restricted to it and below — invoked from a project subdirectory rather
/// than the repo root, a manifest change *above* that directory (a root
/// `Directory.Packages.props` is the common case) is silently missed
/// entirely, with no error to notice. Always diff from the repo root
/// instead, regardless of where the script itself was launched from, so
/// nothing above the invocation directory can go unseen this way.
let private repoRoot (cwd: string) : string option =
    let r = runCommand "git" [ "rev-parse"; "--show-toplevel" ] cwd
    if r.ExitCode = 0 then Some(r.Stdout.Trim()) else None

let runDiff (baseRef: string option) (fetchNotes: bool) (outPath: string option) : unit =
    let cwd = Directory.GetCurrentDirectory()
    let gitCwd = repoRoot cwd |> Option.defaultValue cwd
    let diffArgs =
        (match baseRef with
         | Some r -> [ "diff"; r ]
         | None -> [ "diff" ])
        @ [ "--"; "*.csproj"; "*.fsproj"; "*.vbproj"; "*Directory.Packages.props" ]
    let result = runCommand "git" diffArgs gitCwd

    if result.ExitCode <> 0 then
        printfn "%s" (jobj [ ("ok", jbool false)
                             ("error", jstr (result.Stderr.Trim()))
                             ("changes", jarr []) ])
    else
        let fileHeaderRe = Regex(@"^\+\+\+ b/(.+)$")
        // Original-case display id, keyed by lowercase for lookup.
        let displayId = Collections.Generic.Dictionary<string, string>()
        let removedVersion = Collections.Generic.Dictionary<string, string>()
        let addedVersion = Collections.Generic.Dictionary<string, string>()
        let filesByPackage = Collections.Generic.Dictionary<string, ResizeArray<string>>()
        let mutable currentFile = ""

        let noteFile (key: string) =
            match filesByPackage.TryGetValue key with
            | true, list -> if not (list.Contains currentFile) then list.Add currentFile
            | false, _ ->
                let list = ResizeArray<string>()
                list.Add currentFile
                filesByPackage.[key] <- list

        for line in result.Stdout.Split('\n') do
            let fh = fileHeaderRe.Match(line)
            if fh.Success then
                currentFile <- fh.Groups.[1].Value
            elif line.StartsWith("+++") || line.StartsWith("---") then
                () // file headers, not content — handled above / irrelevant for "-"
            elif line.Length > 0 && (line.[0] = '+' || line.[0] = '-') then
                let sign = line.[0]
                let body = line.Substring(1)
                if packageElementPattern.IsMatch(body) then
                    match extractIncludeAndVersion body with
                    | Some(pkgId, version) ->
                        let key = pkgId.ToLowerInvariant()
                        displayId.[key] <- pkgId
                        (if sign = '-' then removedVersion else addedVersion).[key] <- version
                        noteFile key
                    | None -> ()

        let allKeys =
            Set.ofSeq (Seq.append removedVersion.Keys addedVersion.Keys)

        let changes =
            allKeys
            |> Seq.choose (fun key ->
                let oldV = match removedVersion.TryGetValue key with true, v -> Some v | false, _ -> None
                let newV = match addedVersion.TryGetValue key with true, v -> Some v | false, _ -> None
                let files = match filesByPackage.TryGetValue key with true, l -> List.ofSeq l | false, _ -> []
                match oldV, newV with
                | Some o, Some n when o = n -> None // touched the line, version unchanged — not a real bump
                | Some o, Some n -> Some { PackageId = displayId.[key]; OldVersion = Some o; NewVersion = Some n; ChangeType = "changed"; Files = files }
                | None, Some n -> Some { PackageId = displayId.[key]; OldVersion = None; NewVersion = Some n; ChangeType = "added"; Files = files }
                | Some o, None -> Some { PackageId = displayId.[key]; OldVersion = Some o; NewVersion = None; ChangeType = "removed"; Files = files }
                | None, None -> None)
            |> Seq.sortBy (fun c -> c.PackageId)
            |> Seq.toList

        // Fetch notes for every "changed" entry (the only ones with an
        // old→new range to check) up front, in parallel — one script
        // invocation should hand back Workflow steps 1 *and* 3 together
        // instead of making the agent call `notes` once per package after
        // reading this. `added`/`removed` entries have no range, so no
        // notes lookup applies to them. Each lookup still blocks its own
        // thread on network I/O internally, but running them concurrently
        // rather than one after another is the whole point on a bump that
        // touches more than a couple of ids. Pass `-- diff --no-notes` to
        // skip this and get just the version list back quickly.
        let notesByPackage =
            if fetchNotes then
                changes
                |> List.filter (fun c -> c.ChangeType = "changed")
                |> List.map (fun c ->
                    async { return c.PackageId, resolveNotes c.PackageId c.OldVersion.Value c.NewVersion.Value })
                |> Async.Parallel
                |> Async.RunSynchronously
                |> Map.ofArray
            else
                Map.empty

        // A monorepo bump (OpenTelemetry .NET Contrib is the observed real
        // case: dozens of packages, one repo) has every one of those
        // packages resolve to the same `repoUrl` — `fetchGithubRawReleases`'s
        // cache already means that only fetches the repo's release page
        // once, but each package's own `NotesResolution.Releases` still
        // carried its own full copy of the (now much smaller, thanks to the
        // component-relatedness filter above) list. For a repo shared by 2+
        // changed packages, list its releases exactly once under
        // `"sharedRepos"` and have each package's own `"notes"` point at it
        // (`"sharedReleasesRef"`) plus which of those releases are relevant
        // to *it* specifically (`"relevantTags"`/`"unrelatedTags"`, tag
        // names only) instead of repeating the release objects again.
        let sharedRepoUrls =
            notesByPackage
            |> Map.toList
            |> List.choose (fun (_, n) -> n.RepoUrl)
            |> List.countBy id
            |> List.choose (fun (url, count) -> if count >= 2 then Some url else None)
            |> Set.ofList

        let sharedReleasesByUrl =
            sharedRepoUrls
            |> Set.toList
            |> List.map (fun url ->
                let releases =
                    notesByPackage
                    |> Map.toList
                    |> List.filter (fun (_, n) -> n.RepoUrl = Some url)
                    |> List.collect (fun (_, n) -> n.Releases)
                    // A tag can be "related" (full body) for one package and
                    // "unrelated" (body suppressed) for another sharing the
                    // same repo — prefer whichever copy carried a body over
                    // one that didn't before collapsing to one entry per tag,
                    // so the shared blob never loses the one instance that
                    // was actually worth reading.
                    |> List.sortBy (fun r -> if r.BodyPreview <> "" then 0 else 1)
                    |> List.distinctBy (fun r -> r.Tag)
                    |> List.map (fun r -> { r with UnrelatedComponent = false })
                    |> List.sortBy (fun r -> r.Tag)
                url, releases)
            |> Map.ofList

        // Same duplication, different field: a monorepo bump can move many
        // package ids between the *exact same two tags* (observed live: 9
        // `Microsoft.*`/`OpenTelemetry.*`-adjacent ids on `dotnet/dotnet`,
        // one shared `compare` range) — `githubCompareCommitsCache` already
        // stops that from being 9 separate API calls, but each package's
        // own `NotesResolution.CommitFallback` still carried its own full
        // copy of the identical (multi-hundred-entry, in the observed case)
        // commit list. `"commitsCompareUrl"` is already a stable, unique key
        // per (repo, oldTag, newTag) — reuse it directly instead of a
        // separate grouping key.
        let sharedCommitLogUrls =
            notesByPackage
            |> Map.toList
            |> List.choose (fun (_, n) -> n.CommitsCompareUrl)
            |> List.countBy id
            |> List.choose (fun (url, count) -> if count >= 2 then Some url else None)
            |> Set.ofList

        let sharedCommitLogsByUrl =
            sharedCommitLogUrls
            |> Set.toList
            |> List.map (fun url ->
                let commits =
                    notesByPackage
                    |> Map.toList
                    |> List.tryPick (fun (_, n) -> if n.CommitsCompareUrl = Some url then Some n.CommitFallback else None)
                    |> Option.defaultValue []
                url, commits)
            |> Map.ofList

        /// Same field set as `notesResolutionFields`, except a package whose
        /// repo is shared with another changed package gets a
        /// `"sharedReleasesRef"` + tag-name-only relevance split instead of
        /// its own full `"releases"` array (see `sharedReleasesByUrl` above),
        /// and likewise `"sharedCommitLogRef"` instead of a full
        /// `"commitFallback"` when the compare range is also shared.
        /// `runNotes` (standalone `notes`, always exactly one package) keeps
        /// using the original `notesResolutionFields` unchanged — there is
        /// nothing to share with there.
        let notesFieldsForChange (n: NotesResolution) : (string * string) list =
            let releasesFields =
                match n.RepoUrl with
                | Some url when sharedRepoUrls.Contains url ->
                    let related, unrelated = n.Releases |> List.partition (fun r -> not r.UnrelatedComponent)
                    [ ("sharedReleasesRef", jstr url)
                      ("relevantTags", jarr (related |> List.map (fun r -> jstr r.Tag)))
                      ("unrelatedTags", jarr (unrelated |> List.map (fun r -> jstr r.Tag))) ]
                | _ -> [ ("releases", jarr (n.Releases |> List.map releaseJson)) ]
            let commitFallbackFields =
                match n.CommitsCompareUrl with
                | Some url when sharedCommitLogUrls.Contains url -> [ ("sharedCommitLogRef", jstr url) ]
                | _ -> [ ("commitFallback", jarr (n.CommitFallback |> List.map commitSummaryJson)) ]
            [ ("repoUrl", jstrOpt n.RepoUrl)
              ("host", jstrOpt n.Host)
              ("releasesUrl", jstrOpt n.ReleasesUrl)
              ("releaseNotesFromNuspec", jstrOpt n.ReleaseNotesFromNuspec) ]
            @ releasesFields
            @ [ ("localChangelogFile", jstrOpt n.LocalChangelogFile)
                ("localChangelogPreview", jstrOpt n.LocalChangelogPreview) ]
            @ commitFallbackFields
            @ [ ("commitsCompareUrl", jstrOpt n.CommitsCompareUrl)
                ("incompleteSource", jstrOpt n.IncompleteSource)
                ("dotnetSameMajor", jboolOpt n.DotnetSameMajor)
                ("compatibilityDocsUrl", jstrOpt n.CompatibilityDocsUrl)
                ("aspNetCoreBreakingChangesUrl", jstrOpt n.AspNetCoreBreakingChangesUrl)
                ("resolution", jstr n.Resolution)
                ("fallbackHints", jarr (n.FallbackHints |> List.map jstr)) ]

        // `--no-notes` skips the network-bound release fetch, but the repo
        // and its releases page cost nothing beyond a local nuspec read —
        // still worth handing back so there is something to click on
        // instead of a bare version bump. Covers `"added"` too (a brand new
        // dependency's repo link), not just `"changed"`, since it needs
        // only a package id + version either way.
        let repoInfoByPackage =
            if fetchNotes then
                Map.empty
            else
                changes
                |> List.choose (fun c -> c.NewVersion |> Option.map (fun v -> c.PackageId, resolveRepoInfo c.PackageId v))
                |> Map.ofList

        // A direct major bump (Rule 3's trigger) — cheap nuspec-to-nuspec
        // candidates for a transitive that silently moved a major with it,
        // computed regardless of `--no-notes` since it's local-only (no
        // network). See `findTransitiveMajorHints`'s own comment for why
        // this exists instead of (or alongside) `graph`'s crossing check.
        let transitiveMajorHintsFor (c: ManifestChange) : TransitiveMajorHint list =
            match c.OldVersion, c.NewVersion with
            | Some o, Some n when majorOf o <> majorOf n -> findTransitiveMajorHints c.PackageId o n
            | _ -> []

        let changeJson (c: ManifestChange) =
            let extraField =
                match notesByPackage.TryFind c.PackageId with
                | Some resolved -> [ ("notes", jobj (notesFieldsForChange resolved)) ]
                | None ->
                    match repoInfoByPackage.TryFind c.PackageId with
                    | Some info -> [ ("repo", repoInfoJson info) ]
                    | None -> []
            let hints = transitiveMajorHintsFor c
            let hintsField = if hints.IsEmpty then [] else [ ("transitiveMajorHints", jarr (hints |> List.map transitiveMajorHintJson)) ]
            jobj
                ([ ("packageId", jstr c.PackageId)
                   ("oldVersion", jstrOpt c.OldVersion)
                   ("newVersion", jstrOpt c.NewVersion)
                   ("changeType", jstr c.ChangeType)
                   ("files", jarr (c.Files |> List.map jstr)) ]
                 @ extraField
                 @ hintsField)

        /// Report-skeleton view of one changed id — same underlying data as
        /// `changeJson`, rendered for a human/agent to read and edit in
        /// place rather than parse. Deliberately doesn't bother with the
        /// JSON side's shared-repo/commit-log dedup (`sharedReleasesRef`
        /// etc.) — that exists to keep the *machine-readable* file small,
        /// but each package's own filtered (component-relevant) view here
        /// is usually short already, and a markdown report reads better
        /// self-contained per section than split across a shared appendix.
        /// `diff.md` is the agent's triage sheet, not the reader's document.
        /// A non-flagged release's body is more often Dependabot noise than
        /// signal (one real section carried ~30 consecutive "Bump …" lines,
        /// measured as the single largest line item in that review's token
        /// spend), so here it is cut to a one-line excerpt. Nothing is lost
        /// to the reader: `release-notes.md` still carries every release's
        /// text in full, and the agent doesn't pay for it on the way there.
        let releaseMdLine (r: Release) =
            let marker = if r.HasRiskMarker then "⚠" else "-"
            let body =
                if r.BodyPreview = "" then
                    ""
                elif r.HasRiskMarker then
                    r.BodyPreview.Split('\n')
                    |> Array.map (fun line -> "    > " + line)
                    |> String.concat "\n"
                    |> sprintf "\n%s"
                else
                    // Link targets are dropped from the excerpt (kept in
                    // full elsewhere): in a short budget they crowd out the
                    // actual words — a "Bump …" changelog line is mostly
                    // `[@dependabot](url)` and `[#301](url)` by character
                    // count, and none of that helps decide whether to look
                    // closer.
                    let flat =
                        Regex.Replace(r.BodyPreview, @"\[([^\]]*)\]\([^)]*\)", "$1")
                        |> fun s -> Regex.Replace(s, @"\s+", " ").Trim()
                    sprintf "\n    > %s" (if flat.Length > 180 then flat.Substring(0, 180) + "…" else flat)
            sprintf "%s [`%s`](%s)%s" marker r.Tag r.Url body

        let commitMdLine (c: CommitSummary) =
            // Only ever called for flagged commits (see the `flagged` filter
            // below) — those already carry a full message and a direct URL.
            sprintf "%s [`%s`](%s) %s" (if c.HasRiskMarker then "⚠" else "-") c.Sha c.Url c.Message

        let notesMarkdown (n: NotesResolution) : string =
            let sb = StringBuilder()
            match n.DotnetSameMajor with
            | Some true ->
                sb.AppendLine("Same .NET major — servicing release, non-breaking per Microsoft's compatibility policy. **No further check needed.**") |> ignore
            | Some false ->
                sb.AppendLine("**Major version crossing** — breaking changes are documented per-major, not per-patch:") |> ignore
                n.CompatibilityDocsUrl |> Option.iter (fun u -> sb.AppendLine(sprintf "- %s" u) |> ignore)
                n.AspNetCoreBreakingChangesUrl |> Option.iter (fun u -> sb.AppendLine(sprintf "- %s" u) |> ignore)
            | None ->
                let related = n.Releases |> List.filter (fun r -> not r.UnrelatedComponent)
                if not related.IsEmpty then
                    match n.IncompleteSource with
                    | Some "atom-feed" ->
                        sb.AppendLine("⚠️ **Via the Atom feed (scraping the releases page failed) — only the ~10 most recent releases were checked; older releases in range may be missing. Check the releases page by hand before concluding.**") |> ignore
                    | Some "page-limit" ->
                        sb.AppendLine("⚠️ **The releases-page walk hit its page cap before reaching the old version — releases older than that point are missing from this list.**") |> ignore
                    | Some other ->
                        sb.AppendLine(sprintf "⚠️ **Release list came from an incomplete source (%s) — older releases in range may be missing.**" other) |> ignore
                    | None -> ()
                    sb.AppendLine(sprintf "Releases in range (%d, %d flagged):" related.Length (related |> List.filter (fun r -> r.HasRiskMarker) |> List.length)) |> ignore
                    for r in related |> List.sortByDescending (fun r -> r.HasRiskMarker) do
                        sb.AppendLine(releaseMdLine r) |> ignore
                if not n.CommitFallback.IsEmpty then
                    let flagged = n.CommitFallback |> List.filter (fun c -> c.HasRiskMarker)
                    sb.AppendLine(sprintf "Commit log fallback (%d commits, %d flagged) — [compare](%s):" n.CommitFallback.Length flagged.Length (n.CommitsCompareUrl |> Option.defaultValue "")) |> ignore
                    for c in flagged do
                        sb.AppendLine(commitMdLine c) |> ignore
                if related.IsEmpty && n.CommitFallback.IsEmpty then
                    for h in n.FallbackHints do
                        sb.AppendLine(sprintf "- %s" h) |> ignore
            sb.AppendLine(sprintf "Resolution: `%s`" n.Resolution) |> ignore
            sb.ToString()

        let changeMarkdown (c: ManifestChange) : string =
            let sb = StringBuilder()
            let arrow =
                match c.ChangeType with
                | "added" -> sprintf "*(new)* → `%s`" (c.NewVersion |> Option.defaultValue "?")
                | "removed" -> sprintf "`%s` → *(removed)*" (c.OldVersion |> Option.defaultValue "?")
                | _ -> sprintf "`%s` → `%s`" (c.OldVersion |> Option.defaultValue "?") (c.NewVersion |> Option.defaultValue "?")
            sb.AppendLine(sprintf "## %s — %s" c.PackageId arrow) |> ignore
            sb.AppendLine() |> ignore
            sb.AppendLine(sprintf "Files: %s" (c.Files |> List.map (sprintf "`%s`") |> String.concat ", ")) |> ignore
            sb.AppendLine() |> ignore
            match notesByPackage.TryFind c.PackageId with
            | Some n -> sb.Append(notesMarkdown n) |> ignore
            | None ->
                match repoInfoByPackage.TryFind c.PackageId with
                | Some info ->
                    sb.AppendLine(sprintf "Repo: %s" (info.RepoUrl |> Option.defaultValue "(unknown)")) |> ignore
                    info.ReleasesUrl |> Option.iter (fun u -> sb.AppendLine(sprintf "Releases: %s" u) |> ignore)
                    sb.AppendLine("(`--no-notes` run — notes not fetched; re-run `notes` for this id, or open the link above.)") |> ignore
                | None ->
                    sb.AppendLine("No range to check notes for (`added`/`removed` entry).") |> ignore
            let hints = transitiveMajorHintsFor c
            if not hints.IsEmpty then
                sb.AppendLine() |> ignore
                sb.AppendLine("🔴 **Transitive major hint(s)** — a dependency of this bump may have silently moved a major too (Rule 3):") |> ignore
                for h in hints do
                    sb.AppendLine(sprintf "- `%s`: `%s` → `%s` (via `%s` %s → %s)" h.PackageId h.OldRequestedRange h.NewRequestedRange h.DirectPackageId h.DirectOldVersion h.DirectNewVersion) |> ignore
            sb.AppendLine() |> ignore
            // A same-.NET-major dotnet/dotnet id already has its verdict —
            // Microsoft's own compatibility policy *is* the citation, there
            // is nothing left for the agent to read or decide. Every other
            // case still needs the agent's own judgment (reading what's
            // flagged above, cross-checking actual code usage) before a
            // verdict is safe to write.
            let alreadyVerdict = notesByPackage.TryFind(c.PackageId) |> Option.bind (fun n -> n.DotnetSameMajor) = Some true
            if alreadyVerdict then
                sb.AppendLine("**Verdict: Compatible** — same .NET major, no breaking changes possible per policy (see above). Nothing further needed for this id.") |> ignore
            else
                sb.AppendLine("**TODO (agent):** Breaking / Compatible / Unverified — read what's flagged above, cross-check actual code usage (Rule 3/5), then replace this line with the verdict + remediation or citation.") |> ignore
            sb.ToString()

        let diffMarkdown () : string =
            let sb = StringBuilder()
            sb.AppendLine("# Dependency review — diff") |> ignore
            sb.AppendLine() |> ignore
            sb.AppendLine(sprintf "Base ref: %s" (baseRef |> Option.defaultValue "HEAD (working tree)")) |> ignore
            sb.AppendLine() |> ignore
            for c in changes do
                sb.AppendLine(changeMarkdown c) |> ignore
                sb.AppendLine("---") |> ignore
                sb.AppendLine() |> ignore
            sb.ToString()

        /// The reader's half of the split: every release's notes in full, for
        /// a human reading the finished review, while `diff.md` keeps only
        /// what the agent needs to reach a verdict. Written as its own file
        /// precisely so it can be appended to the report with a shell
        /// redirect instead of being read into the conversation first — the
        /// text reaches the reader without any of it passing through the
        /// agent's context.
        let releaseNotesMarkdown () : string =
            let sb = StringBuilder()
            sb.AppendLine("# Release notes (full text)") |> ignore
            sb.AppendLine() |> ignore
            sb.AppendLine("Every release in each bumped range, as published upstream. Verdicts and impact analysis are in the review itself; this is the source material behind them.") |> ignore
            sb.AppendLine() |> ignore
            for c in changes do
                match notesByPackage.TryFind(c.PackageId) with
                | None -> ()
                | Some n ->
                    let related = n.Releases |> List.filter (fun r -> not r.UnrelatedComponent && r.BodyPreview <> "")
                    if not related.IsEmpty then
                        sb.AppendLine(sprintf "## %s — `%s` → `%s`" c.PackageId (c.OldVersion |> Option.defaultValue "—") (c.NewVersion |> Option.defaultValue "—")) |> ignore
                        sb.AppendLine() |> ignore
                        for r in related do
                            sb.AppendLine(sprintf "### [%s](%s)%s" r.Tag r.Url (if r.HasRiskMarker then " ⚠" else "")) |> ignore
                            sb.AppendLine() |> ignore
                            sb.AppendLine(r.BodyPreview) |> ignore
                            sb.AppendLine() |> ignore
            sb.ToString()

        let sharedReposField =
            if sharedReleasesByUrl.IsEmpty then
                []
            else
                [ ("sharedRepos",
                   jobj
                       (sharedReleasesByUrl
                        |> Map.toList
                        |> List.map (fun (url, releases) -> (url, jarr (releases |> List.map releaseJson))))) ]

        let sharedCommitLogsField =
            if sharedCommitLogsByUrl.IsEmpty then
                []
            else
                [ ("sharedCommitLogs",
                   jobj
                       (sharedCommitLogsByUrl
                        |> Map.toList
                        |> List.map (fun (url, commits) -> (url, jarr (commits |> List.map commitSummaryJson))))) ]

        let output =
            jobj
                ([ ("ok", jbool true)
                   ("baseRef", jstrOpt baseRef) ]
                 @ sharedReposField
                 @ sharedCommitLogsField
                 @ [ ("changes", jarr (changes |> List.map changeJson)) ])

        let riskMarkerCount =
            notesByPackage
            |> Map.toList
            |> List.sumBy (fun (_, n) -> n.Releases |> List.filter (fun r -> r.HasRiskMarker) |> List.length)
        let unresolvedCount =
            notesByPackage |> Map.toList |> List.filter (fun (_, n) -> n.Resolution = "unresolved-manual-required") |> List.length
        let transitiveMajorHintCount = changes |> List.sumBy (transitiveMajorHintsFor >> List.length)

        emitResult
            "diff"
            output
            (diffMarkdown ())
            outPath
            [ ("releaseNotesFile", "release-notes.md", releaseNotesMarkdown ()) ]
            [ ("changeCount", string changes.Length)
              ("riskMarkerReleaseCount", string riskMarkerCount)
              ("unresolvedNotesCount", string unresolvedCount)
              ("transitiveMajorHintCount", string transitiveMajorHintCount) ]

// ────────────────────────────────── main ────────────────────────────────────

// `fsi.CommandLineArgs.[0]` is the script path itself; everything after the
// `--` on the command line follows it. `Environment.GetCommandLineArgs()`
// instead reflects the `dotnet`/fsi host process's own args and does not
// reliably expose what came after `--` the same way.
let scriptArgs = fsi.CommandLineArgs.[1..] |> Array.toList

let private isNoNotes (a: string) = a = "--no-notes"

/// Pulls `--<name> <value>` out of an arg list (wherever it appears),
/// returning the value and the remaining args with both tokens removed.
let private extractValueFlag (name: string) (args: string list) : string option * string list =
    let rec loop acc remaining =
        match remaining with
        | flag :: value :: rest when flag = name -> Some value, (List.rev acc) @ rest
        | x :: rest -> loop (x :: acc) rest
        | [] -> None, List.rev acc
    loop [] args

match scriptArgs with
| "diff" :: rest0 ->
    let outPath, rest1 = extractValueFlag "--out" rest0
    let fetchNotes = not (rest1 |> List.exists isNoNotes)
    let baseRef = rest1 |> List.tryFind (fun a -> not (isNoNotes a))
    runDiff baseRef fetchNotes outPath
| "graph" :: path :: rest0 ->
    let outPath, _ = extractValueFlag "--out" rest0
    runGraph path outPath
| "notes" :: packageId :: oldVersion :: newVersion :: _ -> runNotes packageId oldVersion newVersion
| _ ->
    eprintfn "Usage:"
    eprintfn "  dotnet fsi review.fsx -- diff [<base-ref>] [--no-notes] [--out <dir>]"
    eprintfn "  dotnet fsi review.fsx -- graph <sln|slnx|csproj|fsproj> [--out <dir>]"
    eprintfn "  dotnet fsi review.fsx -- notes <packageId> <oldVersion> <newVersion>"
    exit 1
