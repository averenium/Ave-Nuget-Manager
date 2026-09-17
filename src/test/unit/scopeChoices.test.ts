import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildScopeChoices } from '../../scopeChoices';
import type { SolutionParser } from '../../solutionParser';
import type { ProjectInfo } from '../../types';

function makeSolutionParser(byPath: Record<string, ProjectInfo[]>): jest.Mocked<SolutionParser> {
  return {
    getProjects: jest.fn((p: string) => Promise.resolve(byPath[p] ?? [])),
  } as any;
}

/**
 * `findSolutionsInFolder` and `findProjectsInFolder` each call
 * `vscode.workspace.findFiles` with their own glob — this splits one `matches`
 * list between them by extension, the way each glob genuinely would.
 */
function mockDiscovery(matches: string[]) {
  const isSolution = (p: string) => /\.slnx?$/i.test(p);
  (vscode.workspace.findFiles as jest.Mock).mockImplementation((pattern: any) => {
    const solutionGlob = String(pattern.pattern).includes('sln');
    const files = matches.filter((p) => solutionGlob === isSolution(p));
    return Promise.resolve(files.map((p) => vscode.Uri.file(p)));
  });
}

describe('buildScopeChoices', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'scope-choices-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    (vscode.workspace.findFiles as jest.Mock).mockReset();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns null when the folder holds nothing to build a scope from', async () => {
    mockDiscovery([]);
    const choices = await buildScopeChoices(root, makeSolutionParser({}));
    expect(choices).toBeNull();
  });

  it('orders solutions root-first, then by depth', async () => {
    const appSln = path.join(root, 'App.sln');
    const toolsSln = path.join(root, 'tools', 'Tools.sln');
    const aCsproj = path.join(root, 'src', 'A.csproj');
    const bCsproj = path.join(root, 'src', 'B.csproj');
    mockDiscovery([appSln, toolsSln, aCsproj, bCsproj]);

    const parser = makeSolutionParser({
      [appSln]: [{ name: 'A', relativePath: 'src/A.csproj', absolutePath: aCsproj }],
      [toolsSln]: [
        { name: 'A', relativePath: 'src/A.csproj', absolutePath: aCsproj },
        { name: 'B', relativePath: 'src/B.csproj', absolutePath: bCsproj },
      ],
    });

    const choices = await buildScopeChoices(root, parser);
    expect(choices).not.toBeNull();
    expect(choices!.solutions.map((s) => s.relativeDir)).toEqual(['', 'tools']);
    expect(choices!.solutions[0].projectCount).toBe(1);
    expect(choices!.solutions[1].projectCount).toBe(2);
    expect(choices!.totalProjects).toBe(2);
    expect(choices!.offerAllProjects).toBe(true);
    expect(choices!.projects.map((p) => p.path)).toEqual([aCsproj, bCsproj]);
  });

  it('finds a nested solution even when one already sits directly in the folder root', async () => {
    // Reproduces the "demo" layout: Example.Shop.slnx at the root plus
    // multi-tfm/Example.MultiTarget.slnx one level down. A discovery that
    // stops the moment it finds a direct child (as `findDotnetTargetsInFolder`
    // does for single-target resolution) would report only the root one.
    const rootSln = path.join(root, 'Example.Shop.slnx');
    const nestedSln = path.join(root, 'multi-tfm', 'Example.MultiTarget.slnx');
    mockDiscovery([rootSln, nestedSln]);

    const choices = await buildScopeChoices(root, makeSolutionParser({}));
    expect(choices!.solutions.map((s) => s.path)).toEqual([rootSln, nestedSln]);
  });

  it('breaks a same-depth tie by modification time, most recent first', async () => {
    const older = path.join(root, 'Older.sln');
    const newer = path.join(root, 'Newer.sln');
    await fs.writeFile(older, '');
    await new Promise((r) => setTimeout(r, 10));
    await fs.writeFile(newer, '');
    mockDiscovery([older, newer]);

    const choices = await buildScopeChoices(root, makeSolutionParser({}));
    expect(choices!.solutions.map((s) => path.basename(s.path))).toEqual(['Newer.sln', 'Older.sln']);
  });

  it('does not offer "all projects" when the folder holds only one', async () => {
    const appSln = path.join(root, 'App.sln');
    const only = path.join(root, 'Only.csproj');
    mockDiscovery([appSln, only]);

    const parser = makeSolutionParser({
      [appSln]: [{ name: 'Only', relativePath: 'Only.csproj', absolutePath: only }],
    });

    const choices = await buildScopeChoices(root, parser);
    expect(choices!.totalProjects).toBe(1);
    expect(choices!.offerAllProjects).toBe(false);
  });
});
