import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { collectScopeSnapshotFiles, findNearestFile, MAX_TRACE_PROJECTS } from '../../tracePack';
import type { WorkspaceScope } from '../../types';

describe('findNearestFile / collectScopeSnapshotFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-trace-pack-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('walks up to Directory.Packages.props once', async () => {
    const src = path.join(root, 'src');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(root, 'Directory.Packages.props'), '<Project/>');
    await fs.writeFile(path.join(src, 'A.csproj'), '<Project/>');
    const found = await findNearestFile(src, 'Directory.Packages.props');
    expect(found).toBe(path.join(root, 'Directory.Packages.props'));
  });

  it('caps projects and writes omitted when over the limit', async () => {
    const projects = [];
    for (let i = 0; i < MAX_TRACE_PROJECTS + 3; i++) {
      const abs = path.join(root, `P${i}.csproj`);
      await fs.writeFile(abs, '<Project/>');
      projects.push({ name: `P${i}`, relativePath: `P${i}.csproj`, absolutePath: abs });
    }
    const scope: WorkspaceScope = {
      kind: 'solution',
      solutionPath: path.join(root, 'App.sln'),
      projects,
    };
    await fs.writeFile(scope.solutionPath, 'Microsoft Visual Studio Solution File');
    const touched = [projects[0].absolutePath, projects[1].absolutePath];
    const { files, omitted } = await collectScopeSnapshotFiles(scope, touched, root);
    expect(omitted).toBe(3);
    expect(files.filter((f) => f.destName.endsWith('.csproj')).length).toBe(MAX_TRACE_PROJECTS);
    expect(files.some((f) => f.absPath === touched[0])).toBe(true);
  });

  it('prefixes dest names when two csproj share a filename', async () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    await fs.mkdir(a);
    await fs.mkdir(b);
    await fs.writeFile(path.join(a, 'Foo.csproj'), '<Project/>');
    await fs.writeFile(path.join(b, 'Foo.csproj'), '<Project/>');
    const scope: WorkspaceScope = {
      kind: 'solution',
      solutionPath: path.join(root, 'App.sln'),
      projects: [
        { name: 'Foo', relativePath: 'a/Foo.csproj', absolutePath: path.join(a, 'Foo.csproj') },
        { name: 'Foo', relativePath: 'b/Foo.csproj', absolutePath: path.join(b, 'Foo.csproj') },
      ],
    };
    const { files } = await collectScopeSnapshotFiles(scope, [], root);
    const names = files.filter((f) => f.destName.endsWith('.csproj')).map((f) => f.destName);
    expect(names.sort()).toEqual(['projects/p01.csproj', 'projects/p02.csproj']);
  });
});
