import { scopeChoiceMemory, resolveRememberedChoice } from '../../scopeChoiceMemory';
import type { ScopeChoices } from '../../types';

function makeStore() {
  const data: Record<string, unknown> = {};
  return {
    get: jest.fn(<T>(key: string, def: T): T => (key in data ? (data[key] as T) : def)),
    update: jest.fn((key: string, value: unknown) => { data[key] = value; return Promise.resolve(); }),
  };
}

describe('scopeChoiceMemory', () => {
  it('remembers a choice per folder without clobbering another folder', async () => {
    const store = makeStore();
    const memory = scopeChoiceMemory(store);

    await memory.set('/root', { kind: 'file', path: '/root/App.sln' });
    await memory.set('/other', { kind: 'folder' });

    expect(memory.get('/root')).toEqual({ kind: 'file', path: '/root/App.sln' });
    expect(memory.get('/other')).toEqual({ kind: 'folder' });
  });

  it('returns undefined for a folder nothing was remembered for', () => {
    const memory = scopeChoiceMemory(makeStore());
    expect(memory.get('/never-asked')).toBeUndefined();
  });

  it('a later choice for the same folder replaces the earlier one', async () => {
    const store = makeStore();
    const memory = scopeChoiceMemory(store);
    await memory.set('/root', { kind: 'file', path: '/root/App.sln' });
    await memory.set('/root', { kind: 'folder' });
    expect(memory.get('/root')).toEqual({ kind: 'folder' });
  });
});

describe('resolveRememberedChoice', () => {
  const choices: ScopeChoices = {
    folderPath: '/root',
    totalProjects: 2,
    offerAllProjects: true,
    solutions: [
      { path: '/root/App.sln', relativeDir: '', projectCount: 1, projectPaths: ['/root/A.csproj'] },
    ],
    projects: [
      { path: '/root/A.csproj', name: 'A', relativePath: 'A.csproj' },
      { path: '/root/B.csproj', name: 'B', relativePath: 'B.csproj' },
    ],
  };

  it('keeps a remembered solution that is still there', () => {
    expect(resolveRememberedChoice({ kind: 'file', path: '/root/App.sln' }, choices))
      .toEqual({ kind: 'file', path: '/root/App.sln' });
  });

  it('keeps a remembered project that is still there', () => {
    expect(resolveRememberedChoice({ kind: 'file', path: '/root/B.csproj' }, choices))
      .toEqual({ kind: 'file', path: '/root/B.csproj' });
  });

  it('drops a remembered file no longer among the choices', () => {
    expect(resolveRememberedChoice({ kind: 'file', path: '/root/Gone.sln' }, choices)).toBeUndefined();
  });

  it('keeps a remembered "all projects" while more than one project remains', () => {
    expect(resolveRememberedChoice({ kind: 'folder' }, choices)).toEqual({ kind: 'folder' });
  });

  it('drops a remembered "all projects" once the folder is down to a single project', () => {
    const narrowed: ScopeChoices = { ...choices, totalProjects: 1, offerAllProjects: false, projects: [choices.projects[0]] };
    expect(resolveRememberedChoice({ kind: 'folder' }, narrowed)).toBeUndefined();
  });
});
