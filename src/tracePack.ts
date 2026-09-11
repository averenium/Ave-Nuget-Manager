import * as fs from 'fs/promises';
import * as path from 'path';
import type { WorkspaceScope } from './types';
import { sanitizeFileName } from './traceSanitize';

export const MAX_TRACE_PROJECTS = 40;

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Walk parents of `startDir` for `fileName` (case-insensitive). */
export async function findNearestFile(startDir: string, fileName: string): Promise<string | undefined> {
  const want = fileName.toLowerCase();
  let current = path.resolve(startDir);
  const root = path.parse(current).root;
  for (;;) {
    let entries: string[];
    try {
      entries = await fs.readdir(current);
    } catch {
      entries = [];
    }
    const hit = entries.find((e) => e.toLowerCase() === want);
    if (hit) return path.join(current, hit);
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function projectPathsFromScope(scope: WorkspaceScope | undefined): string[] {
  if (!scope) return [];
  if (scope.kind === 'solution' || scope.kind === 'folder') return scope.projects.map((p) => p.absolutePath);
  return scope.projectPath ? [scope.projectPath] : [];
}

const PROJECT_REFERENCE_RE = /<ProjectReference\b[^>]*\bInclude\s*=\s*["']([^"']+)["']/gi;

/** `<ProjectReference Include="...">` targets of one project file, resolved to absolute paths. */
async function projectReferenceTargets(projectPath: string): Promise<string[]> {
  let xml: string;
  try {
    xml = await fs.readFile(projectPath, 'utf8');
  } catch {
    return [];
  }
  const dir = path.dirname(projectPath);
  const targets: string[] = [];
  const re = new RegExp(PROJECT_REFERENCE_RE.source, PROJECT_REFERENCE_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    targets.push(path.resolve(dir, m[1].replace(/\\/g, '/')));
  }
  return targets;
}

function isInsideRoot(p: string, rootNormalized: string): boolean {
  const norm = path.resolve(p).toLowerCase();
  return norm === rootNormalized || norm.startsWith(rootNormalized + path.sep);
}

/**
 * BFS through `<ProjectReference>` edges from `seed`, so sibling projects
 * outside the active `WorkspaceScope` (reachable only via a reference from a
 * project already in scope) also get a `pXX.csproj` alias — otherwise
 * `traceSanitize` has nothing to rewrite them to and their real names leak
 * into the trace unchanged (#38 review). Capped at `cap` entries total, same
 * as the existing project limit.
 *
 * Cross-repo `ProjectReference`s via relative paths (shared internal libs
 * checked out as a sibling folder, `..\..\SharedInternal\SharedInternal.csproj`)
 * are common — and `collectScopeSnapshotFiles` doesn't just alias a followed
 * reference's name, it bundles the referenced file's *full content* (plus
 * whatever `Directory.Build.props`/`Directory.Packages.props`/`packages.config`
 * a walk up from *its* directory finds) into the trace zip. Without a
 * `workspaceRoot` boundary, that turns a one-line name leak into a full
 * third-party project being archived. `workspaceRoot` unknown → don't expand
 * at all, rather than assume a reference target is safe to include.
 */
async function expandWithProjectReferences(
  seed: string[],
  cap: number,
  workspaceRoot: string | undefined,
): Promise<string[]> {
  const key = (p: string) => path.normalize(p).toLowerCase();
  const included = new Set(seed.map(key));
  const result = [...seed];
  if (!workspaceRoot) return result;
  const rootNormalized = path.resolve(workspaceRoot).toLowerCase();
  let frontier = seed;

  while (frontier.length > 0 && result.length < cap) {
    const next: string[] = [];
    for (const projectPath of frontier) {
      if (result.length >= cap) break;
      for (const ref of await projectReferenceTargets(projectPath)) {
        if (result.length >= cap) break;
        const refKey = key(ref);
        if (included.has(refKey)) continue;
        included.add(refKey);
        if (!isInsideRoot(ref, rootNormalized)) continue;
        if (!(await pathExists(ref))) continue;
        result.push(ref);
        next.push(ref);
      }
    }
    frontier = next;
  }
  return result;
}

async function pickProjects(
  scope: WorkspaceScope | undefined,
  touched: string[],
  workspaceRoot: string | undefined,
): Promise<{ include: string[]; omitted: number }> {
  const fromScope = projectPathsFromScope(scope);
  const seed = [...new Set([...fromScope, ...touched].filter(Boolean))];
  const unique = await expandWithProjectReferences(seed, MAX_TRACE_PROJECTS, workspaceRoot);
  if (unique.length <= MAX_TRACE_PROJECTS) return { include: unique, omitted: 0 };
  const touchedSet = new Set(touched.map((p) => path.normalize(p).toLowerCase()));
  const preferred = unique.filter((p) => touchedSet.has(path.normalize(p).toLowerCase()));
  const rest = unique.filter((p) => !touchedSet.has(path.normalize(p).toLowerCase()));
  const include = [...preferred, ...rest].slice(0, MAX_TRACE_PROJECTS);
  return { include, omitted: unique.length - include.length };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function destForCollected(
  absPath: string,
  counters: { p: number; s: number; pack: number; build: number },
  siblingProjectDest?: string,
): string {
  const base = path.basename(absPath).toLowerCase();
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.csproj' || ext === '.fsproj' || ext === '.vbproj') {
    counters.p += 1;
    return `projects/p${pad2(counters.p)}${ext}`;
  }
  if (ext === '.sln' || ext === '.slnx') {
    counters.s += 1;
    return `projects/s${pad2(counters.s)}${ext}`;
  }
  if (base === 'packages.config' && siblingProjectDest) {
    return siblingProjectDest.replace(/\.(csproj|fsproj|vbproj)$/i, '-packages.config');
  }
  if (base === 'directory.packages.props') {
    counters.pack += 1;
    return counters.pack === 1 ? 'projects/packages.props' : `projects/packages-${pad2(counters.pack)}.props`;
  }
  if (base === 'directory.build.props') {
    counters.build += 1;
    return counters.build === 1 ? 'projects/build.props' : `projects/build-${pad2(counters.build)}.props`;
  }
  if (base === 'global.json') return 'projects/global.json';
  if (base === 'packages.config') {
    counters.p += 1;
    return `projects/p${pad2(counters.p)}-packages.config`;
  }
  counters.p += 1;
  return `projects/p${pad2(counters.p)}-${sanitizeFileName(absPath)}`;
}

export interface CollectedTraceFile {
  destName: string;
  absPath: string;
}

/**
 * Scope project files + nearest Directory.*.props, global.json, packages.config, optional .sln.
 * Unique paths only. Cap {@link MAX_TRACE_PROJECTS}.
 */
export async function collectScopeSnapshotFiles(
  scope: WorkspaceScope | undefined,
  touched: string[],
  workspaceRoot?: string,
): Promise<{ files: CollectedTraceFile[]; omitted: number }> {
  const { include, omitted } = await pickProjects(scope, touched, workspaceRoot);
  const files: CollectedTraceFile[] = [];
  const seenAbs = new Set<string>();
  const counters = { p: 0, s: 0, pack: 0, build: 0 };

  const add = (absPath: string, siblingProjectDest?: string) => {
    const key = path.normalize(absPath).toLowerCase();
    if (seenAbs.has(key)) return undefined;
    seenAbs.add(key);
    const destName = destForCollected(absPath, counters, siblingProjectDest);
    files.push({ destName, absPath });
    return destName;
  };

  for (const proj of include) {
    const dest = add(proj);
    const dir = path.dirname(proj);
    const pkgConfig = path.join(dir, 'packages.config');
    if (await pathExists(pkgConfig)) add(pkgConfig, dest);

    const packagesProps = await findNearestFile(dir, 'Directory.Packages.props');
    if (packagesProps) add(packagesProps);
    const buildProps = await findNearestFile(dir, 'Directory.Build.props');
    if (buildProps) add(buildProps);
  }

  const start =
    scope?.kind === 'solution'
      ? path.dirname(scope.solutionPath)
      : scope?.kind === 'folder'
        ? scope.folderPath
        : scope?.kind === 'project' && scope.projectPath
          ? path.dirname(scope.projectPath)
          : workspaceRoot;
  if (start) {
    const globalJson = await findNearestFile(start, 'global.json');
    if (globalJson) add(globalJson);
  }
  if (workspaceRoot) {
    const atRoot = path.join(workspaceRoot, 'global.json');
    if (await pathExists(atRoot)) add(atRoot);
  }

  if (scope?.kind === 'solution') add(scope.solutionPath);

  return { files, omitted };
}
