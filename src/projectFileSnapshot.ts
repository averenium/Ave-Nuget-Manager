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

// Matches against a comment-masked copy (see #85): read-only, so there's no
// splice to corrupt, but a comment mentioning `Include="<this id>"` (the
// block fallback) or a phantom self-closing-looking `<PackageReference
// Include=... Version=... />` inside a comment could still read back the
// wrong version — worth guarding even though the trigger is narrower than
// the file-corrupting write-side case in legacyPackageReference.ts.
export function readPackageVersionFromXml(xml: string, packageId: string): string | null {
  const id = escapeRegex(packageId);
  const masked = maskXmlComments(xml);

  const attrAfterInclude = masked.match(
    new RegExp(
      `<Package(?:Reference|Version)\\b[^>]*Include\\s*=\\s*["']${id}["'][^>]*Version\\s*=\\s*["']([^"']+)["']`,
      'i',
    ),
  );
  if (attrAfterInclude?.[1]) return attrAfterInclude[1].trim();

  const attrBeforeInclude = masked.match(
    new RegExp(
      `<Package(?:Reference|Version)\\b[^>]*Version\\s*=\\s*["']([^"']+)["'][^>]*Include\\s*=\\s*["']${id}["']`,
      'i',
    ),
  );
  if (attrBeforeInclude?.[1]) return attrBeforeInclude[1].trim();

  const block = masked.match(
    new RegExp(
      `<Package(?:Reference|Version)\\b[^>]*Include\\s*=\\s*["']${id}["'][^>]*>([\\s\\S]*?)</Package(?:Reference|Version)>`,
      'i',
    ),
  );
  const child = block?.[1]?.match(/<Version>\s*([^<]+?)\s*<\/Version>/i);
  if (child?.[1]) return child[1].trim();

  return null;
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
