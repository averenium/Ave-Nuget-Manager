import * as fs from 'fs/promises';
import * as path from 'path';
import { maskXmlComments } from './xmlComments';

export interface FileSnapshot {
  path: string;
  content: string;
}

async function tryRead(filePath: string): Promise<FileSnapshot | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, content };
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Snapshot the project file and the nearest Directory.Packages.props (CPM)
 * so a failed `dotnet add` can restore the previous PackageReference.
 */
export async function snapshotProjectFiles(projectPath: string): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = [];
  const project = await tryRead(projectPath);
  if (project) snapshots.push(project);

  let dir = path.dirname(projectPath);
  for (;;) {
    const props = await tryRead(path.join(dir, 'Directory.Packages.props'));
    if (props) {
      snapshots.push(props);
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return snapshots;
}

export async function restoreFileSnapshots(snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    await fs.writeFile(snapshot.path, snapshot.content, 'utf8');
  }
}

/**
 * Whether central package management applies — a `Directory.Packages.props`
 * among `snapshots` (already the nearest one found by `snapshotProjectFiles`).
 * Under CPM a `Version` on a `PackageReference` is an error (NU1008), so
 * writing one directly is never an option; the CLI already handles CPM
 * projects correctly, override or not (#124).
 */
export function hasCentralPackageManagement(snapshots: readonly FileSnapshot[]): boolean {
  return snapshots.some((s) => path.basename(s.path).toLowerCase() === 'directory.packages.props');
}

/** The version a `Package(Reference|Version)` element states for `id` under one attribute, or `null`. */
function readVersionForAttribute(masked: string, id: string, attribute: 'Include' | 'Update'): string | null {
  const attrAfter = masked.match(
    new RegExp(
      `<Package(?:Reference|Version)\\b[^>]*${attribute}\\s*=\\s*["']${id}["'][^>]*Version\\s*=\\s*["']([^"']+)["']`,
      'i',
    ),
  );
  if (attrAfter?.[1]) return attrAfter[1].trim();

  const attrBefore = masked.match(
    new RegExp(
      `<Package(?:Reference|Version)\\b[^>]*Version\\s*=\\s*["']([^"']+)["'][^>]*${attribute}\\s*=\\s*["']${id}["']`,
      'i',
    ),
  );
  if (attrBefore?.[1]) return attrBefore[1].trim();

  const block = masked.match(
    new RegExp(
      `<Package(?:Reference|Version)\\b[^>]*${attribute}\\s*=\\s*["']${id}["'][^>]*>([\\s\\S]*?)</Package(?:Reference|Version)>`,
      'i',
    ),
  );
  const child = block?.[1]?.match(/<Version>\s*([^<]+?)\s*<\/Version>/i);
  if (child?.[1]) return child[1].trim();

  return null;
}

// Matches against a comment-masked copy (see #85): read-only, so there's no
// splice to corrupt, but a comment mentioning `Include="<this id>"` (the
// block fallback) or a phantom self-closing-looking `<PackageReference
// Include=... Version=... />` inside a comment could still read back the
// wrong version — worth guarding even though the trigger is narrower than
// the file-corrupting write-side case in legacyPackageReference.ts.
//
// `Include=` is tried first and `Update=` only as a fallback (#124): a file
// can state both — an ordinary reference plus an SDK-style override changing
// it — and `Include=` is the one `dotnet add` itself would edit, so it is
// the one this has to agree with when both are present.
export function readPackageVersionFromXml(xml: string, packageId: string): string | null {
  const id = escapeRegex(packageId);
  const masked = maskXmlComments(xml);
  return readVersionForAttribute(masked, id, 'Include') ?? readVersionForAttribute(masked, id, 'Update');
}

export function readPackageVersionFromSnapshots(
  snapshots: FileSnapshot[],
  packageId: string,
): string | null {
  for (const snapshot of snapshots) {
    const version = readPackageVersionFromXml(snapshot.content, packageId);
    if (version) return version;
  }
  return null;
}
