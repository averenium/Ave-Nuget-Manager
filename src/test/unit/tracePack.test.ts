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

  it('follows a ProjectReference to a sibling project outside the active scope (#38 review)', async () => {
    const app = path.join(root, 'App');
    const lib = path.join(root, 'Contoso.Internal.ModuleA');
    await fs.mkdir(app, { recursive: true });
    await fs.mkdir(lib, { recursive: true });
    const appCsproj = path.join(app, 'App.csproj');
    const libCsproj = path.join(lib, 'Contoso.Internal.ModuleA.csproj');
    await fs.writeFile(
      appCsproj,
      '<Project><ItemGroup><ProjectReference Include="..\\Contoso.Internal.ModuleA\\Contoso.Internal.ModuleA.csproj" /></ItemGroup></Project>',
    );
    await fs.writeFile(libCsproj, '<Project/>');

    const scope: WorkspaceScope = { kind: 'project', projectPath: appCsproj };
    const { files } = await collectScopeSnapshotFiles(scope, [], root);

    expect(files.some((f) => f.absPath === libCsproj)).toBe(true);
    const csprojDests = files.filter((f) => f.destName.endsWith('.csproj')).map((f) => f.destName);
    expect(csprojDests.sort()).toEqual(['projects/p01.csproj', 'projects/p02.csproj']);
  });

  it('does not follow a ProjectReference outside workspaceRoot (cross-repo checkout)', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-trace-pack-outside-'));
    try {
      const app = path.join(root, 'App');
      await fs.mkdir(app, { recursive: true });
      const appCsproj = path.join(app, 'App.csproj');
      const sharedDir = path.join(outside, 'SharedInternal');
      await fs.mkdir(sharedDir, { recursive: true });
      const sharedCsproj = path.join(sharedDir, 'SharedInternal.csproj');
      await fs.writeFile(
        appCsproj,
        `<Project><ItemGroup><ProjectReference Include="${path.relative(app, sharedCsproj)}" /></ItemGroup></Project>`,
      );
      await fs.writeFile(sharedCsproj, '<Project><PropertyGroup><ConnectionString>real-secret</ConnectionString></PropertyGroup></Project>');

      const scope: WorkspaceScope = { kind: 'project', projectPath: appCsproj };
      const { files } = await collectScopeSnapshotFiles(scope, [], root);

      expect(files.some((f) => f.absPath === sharedCsproj)).toBe(false);
      expect(files.filter((f) => f.destName.endsWith('.csproj'))).toHaveLength(1);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('does not expand at all when workspaceRoot is unknown (safer than assuming a reference is in-scope)', async () => {
    const app = path.join(root, 'App');
    const lib = path.join(root, 'Contoso.Internal.ModuleA');
    await fs.mkdir(app, { recursive: true });
    await fs.mkdir(lib, { recursive: true });
    const appCsproj = path.join(app, 'App.csproj');
    const libCsproj = path.join(lib, 'Contoso.Internal.ModuleA.csproj');
    await fs.writeFile(
      appCsproj,
      '<Project><ItemGroup><ProjectReference Include="..\\Contoso.Internal.ModuleA\\Contoso.Internal.ModuleA.csproj" /></ItemGroup></Project>',
    );
    await fs.writeFile(libCsproj, '<Project/>');

    const scope: WorkspaceScope = { kind: 'project', projectPath: appCsproj };
    const { files } = await collectScopeSnapshotFiles(scope, [], undefined);

    expect(files.some((f) => f.absPath === libCsproj)).toBe(false);
  });

  it('does not add a ProjectReference target that does not exist on disk', async () => {
    const app = path.join(root, 'App');
    await fs.mkdir(app, { recursive: true });
    const appCsproj = path.join(app, 'App.csproj');
    await fs.writeFile(
      appCsproj,
      '<Project><ItemGroup><ProjectReference Include="..\\Missing\\Missing.csproj" /></ItemGroup></Project>',
    );

    const scope: WorkspaceScope = { kind: 'project', projectPath: appCsproj };
    const { files } = await collectScopeSnapshotFiles(scope, [], root);

    expect(files.filter((f) => f.destName.endsWith('.csproj'))).toHaveLength(1);
  });

  it('expands ProjectReferences transitively, capped at MAX_TRACE_PROJECTS', async () => {
    // A -> B -> C, all outside the scope's own project list except A.
    const dirs = ['A', 'B', 'C'].map((n) => path.join(root, n));
    for (const d of dirs) await fs.mkdir(d, { recursive: true });
    const [aCsproj, bCsproj, cCsproj] = dirs.map((d, i) => path.join(d, `${['A', 'B', 'C'][i]}.csproj`));
    await fs.writeFile(aCsproj, `<Project><ItemGroup><ProjectReference Include="..\\B\\B.csproj" /></ItemGroup></Project>`);
    await fs.writeFile(bCsproj, `<Project><ItemGroup><ProjectReference Include="..\\C\\C.csproj" /></ItemGroup></Project>`);
    await fs.writeFile(cCsproj, '<Project/>');

    const scope: WorkspaceScope = { kind: 'project', projectPath: aCsproj };
    const { files, omitted } = await collectScopeSnapshotFiles(scope, [], root);

    expect(omitted).toBe(0);
    expect(files.some((f) => f.absPath === bCsproj)).toBe(true);
    expect(files.some((f) => f.absPath === cCsproj)).toBe(true);
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
