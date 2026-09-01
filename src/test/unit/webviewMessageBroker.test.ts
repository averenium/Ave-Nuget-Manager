import { WebviewMessageBroker } from '../../webviewMessageBroker';
import { Logger } from '../../logger';
import * as vscode from 'vscode';
import * as projectFiles from '../../projectFileSnapshot';
import * as projectAssets from '../../projectAssets';
import * as config from '../../config';
import * as legacyPr from '../../legacyPackageReference';
import * as projectStyle from '../../projectPackageStyle';
import type { INuGetBackend } from '../../backend/INuGetBackend';
import { DOTNET_PROJECT_EXCLUDE_GLOB } from '../../dotnetWorkspace';
import type { NuGetConfigChainResolver } from '../../nugetConfigChainResolver';
import type { SolutionParser } from '../../solutionParser';
import type { ExtensionMessage } from '../../messages';
import type {
  WorkspaceScope,
  InstalledPackage,
  ImplicitPackage,
  AvailablePackage,
  PackageMetadata,
  CliResult,
} from '../../types';

jest.mock('../../cliRetry', () => {
  const actual = jest.requireActual('../../cliRetry') as typeof import('../../cliRetry');
  return {
    ...actual,
    delayInstallRetry: jest.fn().mockResolvedValue(undefined),
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCliResult(overrides?: Partial<CliResult>): CliResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...overrides };
}

function makeInstalledPkg(id: string, projectPath: string): InstalledPackage {
  return { id, requestedVersion: '1.0.0', resolvedVersion: '1.0.0', projectPath };
}

function makeImplicitPkg(id: string, projectPath: string): ImplicitPackage {
  return { id, resolvedVersion: '1.0.0', projectPath };
}

function makeAvailablePkg(id: string): AvailablePackage {
  return { id, latestVersion: '2.0.0', sourceName: 'nuget.org' };
}

function makeMetadata(id: string): PackageMetadata {
  return {
    id,
    version: '2.0.0',
    authors: 'Author',
    description: 'Desc',
    tags: [],
    dependencies: [],
    targetFrameworks: [],
  };
}

// ─── Stubs ────────────────────────────────────────────────────────────────────

function makeProvider(scope?: WorkspaceScope) {
  const posted: ExtensionMessage[] = [];
  let messageHandler: ((msg: unknown) => void) | undefined;

  return {
    stub: {
      getCurrentScope: jest.fn(() => scope),
      postMessage: jest.fn((msg: ExtensionMessage) => posted.push(msg)),
      onDidReceiveMessage: jest.fn((handler: (msg: unknown) => void) => {
        messageHandler = handler;
        return { dispose: jest.fn() };
      }),
      setOnViewReady: jest.fn((cb: () => void) => cb()),
      setScope: jest.fn(),
      markClientReady: jest.fn(),
      isClientReady: false,
    } as any,
    posted,
    simulateMessage(msg: unknown) { messageHandler?.(msg); },
  };
}

function makeBackend(): jest.Mocked<INuGetBackend> {
  return {
    listInstalled: jest.fn().mockResolvedValue([]),
    listTransitive: jest.fn().mockResolvedValue([]),
    listAllForSolution: jest.fn().mockResolvedValue({ installed: [], implicit: [] }),
    listAllForProject: jest.fn().mockResolvedValue({ installed: [], implicit: [] }),
    searchPackages: jest.fn().mockResolvedValue([]),
    getAllVersions: jest.fn().mockResolvedValue([]),
    getMetadata: jest.fn().mockResolvedValue(makeMetadata('Pkg')),
    installPackage: jest.fn().mockResolvedValue(makeCliResult()),
    installPackageNoRestore: jest.fn().mockResolvedValue(makeCliResult()),
    removePackage: jest.fn().mockResolvedValue(makeCliResult()),
    restoreProject: jest.fn().mockResolvedValue(makeCliResult()),
    enrichPackage: jest.fn().mockResolvedValue({ latestVersion: '', sourceName: '', versions: [] }),
    listVulnerable: jest.fn().mockResolvedValue([]),
  };
}

function makeConfigResolver(): jest.Mocked<NuGetConfigChainResolver> {
  return {
    resolve: jest.fn().mockResolvedValue([]),
  } as any;
}

function makeSolutionParser(): jest.Mocked<SolutionParser> {
  return { getProjects: jest.fn().mockResolvedValue([]) } as any;
}

const PROJECT_SCOPE: WorkspaceScope = { kind: 'project', projectPath: '/p/App.csproj' };
const SOLUTION_SCOPE: WorkspaceScope = {
  kind: 'solution',
  solutionPath: '/sol/My.sln',
  projects: [
    { name: 'A', relativePath: 'A/A.csproj', absolutePath: '/sol/A/A.csproj' },
    { name: 'B', relativePath: 'B/B.csproj', absolutePath: '/sol/B/B.csproj' },
  ],
};
const FOLDER_SCOPE: WorkspaceScope = {
  kind: 'folder',
  folderPath: '/tools',
  projects: [
    { name: 'A', relativePath: 'A/A.csproj', absolutePath: '/tools/A/A.csproj' },
    { name: 'B', relativePath: 'B/B.csproj', absolutePath: '/tools/B/B.csproj' },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebviewMessageBroker', () => {
  let logger: Logger;

  beforeEach(() => { logger = new Logger(); });
  afterEach(() => { logger.dispose(); });

  // ── WEBVIEW_READY ──────────────────────────────────────────────────────────

  it('responds to WEBVIEW_READY with INIT_STATE for project scope', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{ name: 'nuget.org', url: 'https://api.nuget.org', enabled: true, configFilePath: '/p/nuget.config' }],
    }]);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), resolver, logger);
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 10));

    const initMsg = posted.find((m) => m.type === 'INIT_STATE') as any;
    expect(initMsg).toBeDefined();
    expect(initMsg.scope).toEqual(PROJECT_SCOPE);
    expect(initMsg.sources).toHaveLength(1);
    expect(initMsg.snapshot.effectivePackageSources).toHaveLength(1);
    expect(initMsg.blockedPackages).toEqual([]);
    expect(initMsg.roslynCap).toBeNull();
    expect(initMsg.isWindows).toBe(process.platform === 'win32');
  });

  it('includes skill fields on INIT_STATE when detection is empty', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const skill = {
      readStatus: jest.fn().mockResolvedValue({
        bundledVersion: '1.0.6',
        detected: [],
        installs: [],
      }),
      install: jest.fn(),
    };
    const broker = new WebviewMessageBroker(
      stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger,
      undefined, undefined, skill,
    );
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 20));
    const initMsg = posted.find((m) => m.type === 'INIT_STATE') as any;
    expect(initMsg.bundledVersion).toBe('1.0.6');
    expect(initMsg.detected).toEqual([]);
    expect(initMsg.installs).toEqual([]);
  });

  it('INSTALL_AGENT_SKILL invokes install and posts SKILL_STATUS', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const status = {
      bundledVersion: '1.0.6',
      detected: [],
      installs: [{ label: 'Cursor (user)', destDir: '/c', version: '1.0.6', outdated: false }],
    };
    const skill = {
      readStatus: jest.fn().mockResolvedValue(status),
      install: jest.fn().mockResolvedValue(undefined),
    };
    const broker = new WebviewMessageBroker(
      stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger,
      undefined, undefined, skill,
    );
    broker.attach();
    simulateMessage({ type: 'INSTALL_AGENT_SKILL' });
    await new Promise((r) => setTimeout(r, 20));
    expect(skill.install).toHaveBeenCalledWith({ updateExisting: false });
    const postedStatus = posted.find((m) => m.type === 'SKILL_STATUS') as any;
    expect(postedStatus).toMatchObject(status);
  });

  it('INSTALL_AGENT_SKILL updateExisting updates in place', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const skill = {
      readStatus: jest.fn().mockResolvedValue({ bundledVersion: '1.0.6', detected: [], installs: [] }),
      install: jest.fn().mockResolvedValue(undefined),
    };
    const broker = new WebviewMessageBroker(
      stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger,
      undefined, undefined, skill,
    );
    broker.attach();
    simulateMessage({ type: 'INSTALL_AGENT_SKILL', updateExisting: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(skill.install).toHaveBeenCalledWith({ updateExisting: true });
    expect(posted.some((m) => m.type === 'SKILL_STATUS')).toBe(true);
  });

  // ── _detectWorkspaceScope auto-detect (no scope set yet) ───────────────────
  // The common "one subfolder per project" layout has nothing directly at the
  // workspace root, so auto-detect must fall back to a recursive scan too —
  // otherwise opening the panel on such a workspace silently shows nothing.

  describe('auto-detects a scope on the first WEBVIEW_READY', () => {
    const fsPromises = jest.requireActual('fs/promises') as typeof import('fs/promises');

    afterEach(() => {
      jest.restoreAllMocks();
      (vscode.workspace as any).workspaceFolders = [];
      (vscode.workspace.findFiles as jest.Mock).mockReset();
    });

    it('builds a folder scope when the root has no direct matches but several loose projects recursively', async () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: vscode.Uri.file('/root'), name: 'root', index: 0 },
      ];
      jest.spyOn(fsPromises, 'readdir').mockResolvedValue([] as any);
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
        vscode.Uri.file('/root/ServiceA/A.csproj'),
        vscode.Uri.file('/root/ServiceB/B.csproj'),
      ]);

      const { stub, posted, simulateMessage } = makeProvider(undefined);
      const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({ type: 'WEBVIEW_READY' });
      await new Promise((r) => setTimeout(r, 10));

      const expected: WorkspaceScope = {
        kind: 'folder',
        folderPath: '/root',
        projects: [
          { name: 'A', relativePath: 'ServiceA/A.csproj', absolutePath: '/root/ServiceA/A.csproj' },
          { name: 'B', relativePath: 'ServiceB/B.csproj', absolutePath: '/root/ServiceB/B.csproj' },
        ],
      };
      expect(stub.setScope).toHaveBeenCalledWith(expected);
      const initMsg = posted.find((m) => m.type === 'INIT_STATE') as any;
      expect(initMsg?.scope).toEqual(expected);

      // Must scope the scan to workspaceFolders[0], not the whole (possibly
      // multi-root) workspace — a bare glob with no RelativePattern searches
      // every root folder, which could pick up projects from an unrelated root.
      const [pattern, exclude] = (vscode.workspace.findFiles as jest.Mock).mock.calls[0];
      expect(pattern).toBeInstanceOf(vscode.RelativePattern);
      expect(pattern.base).toBe('/root');
      expect(exclude).toBe(DOTNET_PROJECT_EXCLUDE_GLOB);
    });

    it('builds a plain project scope when only one loose project is found recursively', async () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: vscode.Uri.file('/root'), name: 'root', index: 0 },
      ];
      jest.spyOn(fsPromises, 'readdir').mockResolvedValue([] as any);
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
        vscode.Uri.file('/root/ServiceA/A.csproj'),
      ]);

      const { stub, simulateMessage } = makeProvider(undefined);
      const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({ type: 'WEBVIEW_READY' });
      await new Promise((r) => setTimeout(r, 10));

      expect(stub.setScope).toHaveBeenCalledWith({ kind: 'project', projectPath: '/root/ServiceA/A.csproj' });
    });

    it('does not pick up a second workspace root\'s files (scan is scoped to root[0])', async () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: vscode.Uri.file('/root'), name: 'root', index: 0 },
        { uri: vscode.Uri.file('/other-root'), name: 'other-root', index: 1 },
      ];
      jest.spyOn(fsPromises, 'readdir').mockResolvedValue([] as any);
      // A real findFiles(RelativePattern('/root', …)) would only ever return
      // URIs under /root; simulate that instead of a workspace-wide glob's result.
      (vscode.workspace.findFiles as jest.Mock).mockImplementation((pattern: any) => {
        const base = typeof pattern === 'string' ? undefined : pattern.base;
        return Promise.resolve(base === '/root' ? [] : [vscode.Uri.file('/other-root/Other.csproj')]);
      });

      const { stub, simulateMessage } = makeProvider(undefined);
      const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({ type: 'WEBVIEW_READY' });
      await new Promise((r) => setTimeout(r, 10));

      expect(stub.setScope).not.toHaveBeenCalled();
    });

    it('does nothing when the recursive scan also finds nothing', async () => {
      (vscode.workspace as any).workspaceFolders = [
        { uri: vscode.Uri.file('/root'), name: 'root', index: 0 },
      ];
      jest.spyOn(fsPromises, 'readdir').mockResolvedValue([] as any);
      (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([]);

      const { stub, simulateMessage } = makeProvider(undefined);
      const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({ type: 'WEBVIEW_READY' });
      await new Promise((r) => setTimeout(r, 10));

      expect(stub.setScope).not.toHaveBeenCalled();
    });
  });

  it('runs onFirstWebviewReady once, then still inits on a later WEBVIEW_READY', async () => {
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    const onFirst = jest.fn().mockResolvedValue(undefined);
    const broker = new WebviewMessageBroker(
      stub, backend, makeSolutionParser(), makeConfigResolver(), logger, onFirst,
    );
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 20));
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(backend.listAllForProject).toHaveBeenCalledTimes(1);

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 20));
    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(backend.listAllForProject).toHaveBeenCalledTimes(2);
  });

  it('sends INSTALLED_PACKAGES and IMPLICIT_PACKAGES after WEBVIEW_READY', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')],
      implicit:  [makeImplicitPkg('Microsoft.Extensions.Logging', '/p/App.csproj')],
    });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 10));

    const installed = posted.find((m) => m.type === 'INSTALLED_PACKAGES') as any;
    const implicit = posted.find((m) => m.type === 'IMPLICIT_PACKAGES') as any;
    expect(installed?.packages[0].id).toBe('Newtonsoft.Json');
    expect(implicit?.packages[0].id).toBe('Microsoft.Extensions.Logging');
  });

  it('restores the project in parallel with list on WEBVIEW_READY', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')],
      implicit: [],
    });
    backend.restoreProject.mockResolvedValue(makeCliResult({
      exitCode: 1,
      stdout: 'error: NU1605: Warning As Error: Detected package downgrade',
      stderr: '',
    }));

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 10));

    expect(backend.restoreProject).toHaveBeenCalledWith('/p/App.csproj');
    expect(backend.listAllForProject).toHaveBeenCalled();
    expect(posted.some((m) => m.type === 'INSTALLED_PACKAGES')).toBe(true);
    const err = posted.find((m) => m.type === 'ERROR') as any;
    expect(err?.message).toBe('Restore failed');
    expect(err?.details).toContain('NU1605');
  });

  it('restores the solution once (not each project) on WEBVIEW_READY', async () => {
    const { stub, simulateMessage } = makeProvider(SOLUTION_SCOPE);
    const backend = makeBackend();
    backend.listAllForSolution.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/sol/A/A.csproj')],
      implicit: [],
    });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 10));

    expect(backend.restoreProject).toHaveBeenCalledTimes(1);
    expect(backend.restoreProject).toHaveBeenCalledWith('/sol/My.sln');
    expect(backend.restoreProject).not.toHaveBeenCalledWith('/sol/A/A.csproj');
  });

  it('restores and lists every project independently for a folder scope (no .sln to pass to dotnet)', async () => {
    const { stub, posted, simulateMessage } = makeProvider(FOLDER_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockImplementation(async (p: string) => ({
      installed: [makeInstalledPkg('Newtonsoft.Json', p)],
      implicit: [],
    }));

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 10));

    expect(backend.restoreProject).toHaveBeenCalledTimes(2);
    expect(backend.restoreProject).toHaveBeenCalledWith('/tools/A/A.csproj', undefined);
    expect(backend.restoreProject).toHaveBeenCalledWith('/tools/B/B.csproj', undefined);
    expect(backend.listAllForProject).toHaveBeenCalledTimes(2);

    const installed = posted.find((m) => m.type === 'INSTALLED_PACKAGES') as any;
    expect(installed?.packages.map((p: InstalledPackage) => p.projectPath).sort()).toEqual([
      '/tools/A/A.csproj',
      '/tools/B/B.csproj',
    ]);
  });

  it('reports a restore failure for the current folder scope even though only one project failed', async () => {
    const { stub, posted, simulateMessage } = makeProvider(FOLDER_SCOPE);
    const backend = makeBackend();
    backend.restoreProject.mockImplementation(async (p: string) =>
      p === '/tools/B/B.csproj'
        ? makeCliResult({ exitCode: 1, stdout: 'error: NU1605 in B', stderr: '' })
        : makeCliResult(),
    );

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 10));

    const err = posted.find((m) => m.type === 'ERROR') as any;
    expect(err?.message).toBe('Restore failed');
    expect(err?.details).toContain('NU1605 in B');
  });

  it('does not restore again after a successful install refresh', async () => {
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.installPackage.mockResolvedValue(makeCliResult());
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')],
      implicit: [],
    });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'INSTALL_PACKAGE',
      projectPath: '/p/App.csproj',
      packageId: 'Newtonsoft.Json',
      version: '13.0.3',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(backend.restoreProject).not.toHaveBeenCalled();
  });

  it('FORCE_REFRESH posts REFRESH_STARTED before a restore failure', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')],
      implicit: [],
    });
    backend.restoreProject.mockResolvedValue(makeCliResult({
      exitCode: 1,
      stdout: 'error: NU1605 restore',
    }));

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'FORCE_REFRESH' });
    await new Promise((r) => setTimeout(r, 20));

    expect(posted[0]?.type).toBe('REFRESH_STARTED');
    expect((posted[0] as { kind?: string }).kind).toBe('refresh');
    const err = posted.find((m) => m.type === 'ERROR') as { message?: string; details?: string } | undefined;
    expect(err?.message).toBe('Restore failed');
    expect(err?.details).toContain('NU1605');
  });

  it('posts ENRICH_PROGRESS complete when latest versions are already cached', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')],
      implicit: [],
    });
    backend.enrichPackage.mockResolvedValue({
      latestVersion: '13.0.3',
      sourceName: 'nuget.org',
      versions: ['13.0.3'],
    });
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{
        name: 'nuget.org',
        url: 'https://api.nuget.org',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
    }]);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), resolver, logger);
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 30));

    posted.length = 0;
    simulateMessage({ type: 'REFRESH_PACKAGES' });
    await new Promise((r) => setTimeout(r, 30));

    expect(backend.enrichPackage).toHaveBeenCalledTimes(1);
    expect(posted.some((m) => m.type === 'ENRICH_PROGRESS' && (m as any).done === 1 && (m as any).total === 1)).toBe(true);
  });

  it('RESTORE_PACKAGES restores without clearing the latest-version cache', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')],
      implicit: [],
    });
    backend.enrichPackage.mockResolvedValue({
      latestVersion: '13.0.3',
      sourceName: 'nuget.org',
      versions: ['13.0.3'],
    });
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{
        name: 'nuget.org',
        url: 'https://api.nuget.org',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
    }]);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), resolver, logger);
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 30));
    expect(backend.enrichPackage).toHaveBeenCalledTimes(1);
    const restoresAfterReady = backend.restoreProject.mock.calls.length;

    posted.length = 0;
    simulateMessage({ type: 'RESTORE_PACKAGES' });
    await new Promise((r) => setTimeout(r, 30));

    expect(posted[0]?.type).toBe('REFRESH_STARTED');
    expect((posted[0] as { kind?: string }).kind).toBe('restore');
    expect(backend.restoreProject.mock.calls.length).toBe(restoresAfterReady + 1);
    expect(backend.enrichPackage).toHaveBeenCalledTimes(1);
    expect(posted.some((m) => m.type === 'REFRESH_FINISHED')).toBe(true);
    expect(posted.some((m) => m.type === 'PACKAGE_INFO_UPDATE')).toBe(false);
    expect(posted.some((m) => m.type === 'ENRICH_PROGRESS')).toBe(false);
    const listed = posted.find((m) => m.type === 'INSTALLED_PACKAGES') as { packages?: Array<{ latestVersion?: string }> } | undefined;
    expect(listed?.packages?.[0].latestVersion).toBe('13.0.3');
  });

  it('RESTORE_PACKAGES lists packages only after restore finishes', async () => {
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    let restoreDone = false;
    backend.restoreProject.mockImplementation(async () => {
      expect(backend.listAllForProject).not.toHaveBeenCalled();
      restoreDone = true;
      return makeCliResult();
    });
    backend.listAllForProject.mockImplementation(async () => {
      expect(restoreDone).toBe(true);
      return { installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')], implicit: [] };
    });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'RESTORE_PACKAGES' });
    await new Promise((r) => setTimeout(r, 30));

    expect(restoreDone).toBe(true);
    expect(backend.listAllForProject).toHaveBeenCalled();
  });

  it('retries enrichPackage once after the rest of the wave finishes', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [
        makeInstalledPkg('FailPkg', '/p/App.csproj'),
        makeInstalledPkg('OkPkg', '/p/App.csproj'),
      ],
      implicit: [],
    });
    const calls: string[] = [];
    let failAttempts = 0;
    backend.enrichPackage.mockImplementation(async (id: string) => {
      calls.push(id);
      if (id === 'FailPkg') {
        failAttempts += 1;
        if (failAttempts === 1) throw new Error('search failed');
        return { latestVersion: '2.0.0', sourceName: 'nuget.org', versions: ['2.0.0'] };
      }
      return { latestVersion: '1.0.0', sourceName: 'nuget.org', versions: ['1.0.0'] };
    });
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{
        name: 'nuget.org',
        url: 'https://api.nuget.org',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
    }]);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), resolver, logger);
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 50));

    expect(calls.filter((id) => id === 'FailPkg')).toHaveLength(2);
    expect(calls.filter((id) => id === 'OkPkg')).toHaveLength(1);
    expect(calls.lastIndexOf('FailPkg')).toBeGreaterThan(calls.indexOf('OkPkg'));

    const updates = posted.filter((m) => m.type === 'PACKAGE_INFO_UPDATE') as Array<{
      packageId: string;
      latestVersion: string;
    }>;
    expect(updates.some((u) => u.packageId === 'FailPkg' && u.latestVersion === '2.0.0')).toBe(true);
    expect(updates.some((u) => u.packageId === 'OkPkg')).toBe(true);
  });

  it('retries an empty enrich search once', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('EmptyThenOk', '/p/App.csproj')],
      implicit: [],
    });
    backend.enrichPackage
      .mockResolvedValueOnce({ latestVersion: '', sourceName: '', versions: [] })
      .mockResolvedValueOnce({ latestVersion: '3.0.0', sourceName: 'nuget.org', versions: ['3.0.0'] });
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{
        name: 'nuget.org',
        url: 'https://api.nuget.org',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
    }]);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), resolver, logger);
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 50));

    expect(backend.enrichPackage).toHaveBeenCalledTimes(2);
    const updates = posted.filter((m) => m.type === 'PACKAGE_INFO_UPDATE') as Array<{
      packageId: string;
      latestVersion: string;
    }>;
    expect(updates.some((u) => u.packageId === 'EmptyThenOk' && u.latestVersion === '3.0.0')).toBe(true);
  });

  it('does not call enrichPackage a third time when retry also fails', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('AlwaysFail', '/p/App.csproj')],
      implicit: [],
    });
    backend.enrichPackage.mockRejectedValue(new Error('search failed'));
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{
        name: 'nuget.org',
        url: 'https://api.nuget.org',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
    }]);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), resolver, logger);
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 50));

    expect(backend.enrichPackage).toHaveBeenCalledTimes(2);
    expect(posted.some((m) => m.type === 'PACKAGE_INFO_UPDATE')).toBe(false);
    expect(posted.some((m) => m.type === 'ENRICH_PROGRESS' && (m as { done: number; total: number }).done === 1)).toBe(true);
  });

  it('posts VULNERABILITIES after listing packages', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')],
      implicit: [],
    });
    backend.listVulnerable.mockResolvedValue([{
      packageId: 'Newtonsoft.Json',
      version: '1.0.0',
      severity: 'high',
      id: 'GHSA-test',
      url: 'https://github.com/advisories/GHSA-test',
      source: 'dotnet',
    }]);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 30));

    expect(backend.listVulnerable).toHaveBeenCalledWith('/p/App.csproj', expect.any(AbortSignal));
    const vuln = posted.find((m) => m.type === 'VULNERABILITIES') as { findings?: unknown[] } | undefined;
    expect(vuln?.findings).toHaveLength(1);
  });

  it('starts listVulnerable without waiting for restore on WEBVIEW_READY', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('SharpCompress', '/p/App.csproj')],
      implicit: [],
    });
    let finishRestore!: (result: CliResult) => void;
    backend.restoreProject.mockReturnValue(new Promise((resolve) => {
      finishRestore = resolve;
    }));

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 30));

    expect(posted.some((m) => m.type === 'INSTALLED_PACKAGES')).toBe(true);
    expect(backend.listVulnerable).toHaveBeenCalled();
    expect(backend.restoreProject).toHaveBeenCalled();
    finishRestore(makeCliResult());
  });

  // ── SEARCH_PACKAGES ────────────────────────────────────────────────────────

  it('responds to SEARCH_PACKAGES with SEARCH_RESULTS', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.searchPackages.mockResolvedValue([makeAvailablePkg('Newtonsoft.Json')]);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'SEARCH_PACKAGES', query: 'New', configFiles: ['/a/nuget.config'], enabledSourceNames: ['nuget.org'] });
    await new Promise((r) => setTimeout(r, 10));

    const result = posted.find((m) => m.type === 'SEARCH_RESULTS') as any;
    expect(result?.query).toBe('New');
    expect(result?.packages[0].id).toBe('Newtonsoft.Json');
  });

  it('GET_ALL_VERSIONS uses enrich cache without a second search', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')],
      implicit: [],
    });
    backend.enrichPackage.mockResolvedValue({
      latestVersion: '13.0.3',
      sourceName: 'nuget.org',
      versions: ['13.0.3', '13.0.1'],
    });
    backend.getAllVersions.mockResolvedValue(['14.0.0']);
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{
        name: 'nuget.org',
        url: 'https://api.nuget.org',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
    }]);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), resolver, logger);
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 30));

    posted.length = 0;
    simulateMessage({
      type: 'GET_ALL_VERSIONS',
      packageId: 'Newtonsoft.Json',
      configFiles: ['/p/nuget.config'],
      prerelease: false,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(backend.getAllVersions).not.toHaveBeenCalled();
    const msg = posted.find((m) => m.type === 'ALL_VERSIONS') as { versions?: string[] } | undefined;
    expect(msg?.versions).toEqual(['13.0.3', '13.0.1']);
  });

  it('GET_ALL_VERSIONS fetches when the cache is empty', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.getAllVersions.mockResolvedValue(['2.0.0', '1.0.0']);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();
    simulateMessage({
      type: 'GET_ALL_VERSIONS',
      packageId: 'Pkg',
      configFiles: ['/p/nuget.config'],
      prerelease: false,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(backend.getAllVersions).toHaveBeenCalledWith('Pkg', ['/p/nuget.config'], false);
    const msg = posted.find((m) => m.type === 'ALL_VERSIONS') as { versions?: string[] } | undefined;
    expect(msg?.versions).toEqual(['2.0.0', '1.0.0']);
  });

  // ── INSTALL_PACKAGE ────────────────────────────────────────────────────────

  it('responds to INSTALL_PACKAGE with OPERATION_SUCCESS on exit 0', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'INSTALL_PACKAGE', projectPath: '/p/App.csproj', packageId: 'Pkg', version: '1.0.0' });
    await new Promise((r) => setTimeout(r, 10));

    const success = posted.find((m) => m.type === 'OPERATION_SUCCESS') as any;
    expect(success?.operation).toBe('install');
    expect(success?.packageId).toBe('Pkg');
  });

  it('responds to INSTALL_PACKAGE with OPERATION_ERROR on non-zero exit', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.installPackage.mockResolvedValue(makeCliResult({ exitCode: 1, stderr: 'error' }));

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'INSTALL_PACKAGE', projectPath: '/p/App.csproj', packageId: 'Pkg', version: '1.0.0' });
    await new Promise((r) => setTimeout(r, 10));

    const err = posted.find((m) => m.type === 'OPERATION_ERROR') as any;
    expect(err?.failures[0].stderr).toBe('error');
  });

  it('summarizes NU1605 from stdout when stderr is empty', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.installPackage.mockResolvedValue(makeCliResult({
      exitCode: 1,
      stderr: '',
      stdout: 'error: NU1605: Warning As Error: Detected package downgrade\nlog  : Failed to restore App.csproj',
    }));
    backend.listAllForProject.mockResolvedValue({
      installed: [],
      implicit: [],
      error: 'Restore failed. Run `dotnet restore` for more details on the issue.',
    });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'INSTALL_PACKAGE', projectPath: '/p/App.csproj', packageId: 'Pkg', version: '1.0.0' });
    await new Promise((r) => setTimeout(r, 20));

    const err = posted.find((m) => m.type === 'OPERATION_ERROR') as any;
    expect(err?.failures[0].stderr).toContain('NU1605');
    expect(posted.filter((m) => m.type === 'INSTALLED_PACKAGES')).toHaveLength(0);
  });

  it('treats exit 0 add with NU1605 stdout as OPERATION_ERROR, not list restore JSON', async () => {
    const addOutput = `info : X.509 certificate chain validation will use the default trust store selected by .NET for code signing.
info : Adding PackageReference for package 'EFCore.NamingConventions' into project '/p/Data.csproj'.
error: NU1605: Warning As Error: Detected package downgrade: Microsoft.EntityFrameworkCore from 10.0.1 to 10.0.0.
error:  Data -> EFCore.NamingConventions 10.0.1 -> Microsoft.EntityFrameworkCore (>= 10.0.1 && < 11.0.0)
error:  Data -> Microsoft.EntityFrameworkCore (>= 10.0.0)
info : PackageReference for package 'EFCore.NamingConventions' version '10.0.1' updated in file '/p/Data.csproj'.
log  : Failed to restore /p/Data.csproj (in 236 ms).`;

    const { stub, posted, simulateMessage } = makeProvider(SOLUTION_SCOPE);
    const backend = makeBackend();
    backend.installPackage.mockResolvedValue(makeCliResult({
      exitCode: 0,
      stdout: addOutput,
      stderr: '',
    }));
    backend.listAllForSolution.mockResolvedValue({
      installed: [],
      implicit: [],
      error: 'Restore failed. Run `dotnet restore` for more details on the issue.',
    });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'INSTALL_PACKAGE_MULTI',
      projects: ['/sol/A/A.csproj'],
      packageId: 'EFCore.NamingConventions',
      version: '10.0.1',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(posted.some((m) => m.type === 'OPERATION_SUCCESS')).toBe(false);
    const err = posted.find((m) => m.type === 'OPERATION_ERROR') as any;
    expect(err?.failures[0].stderr).toContain('NU1605');
    expect(err?.failures[0].stderr).toContain('EFCore.NamingConventions 10.0.1');
    expect(err?.failures[0].stderr).not.toContain('Run `dotnet restore`');
    expect(posted.filter((m) => m.type === 'ERROR')).toHaveLength(0);
    expect(err?.rollbackApplied).toBe(true);
  });

  it('rolls back project files after a failed add when onFailedUpdate is rollback', async () => {
    const restoreSpy = jest.spyOn(projectFiles, 'restoreFileSnapshots').mockResolvedValue(undefined);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
      { path: '/sol/A/A.csproj', content: '<Project Sdk="Microsoft.NET.Sdk"><PackageReference Include="EFCore.NamingConventions" Version="10.0.0" /></Project>' },
    ]);

    try {
      const { stub, posted, simulateMessage } = makeProvider(SOLUTION_SCOPE);
      const backend = makeBackend();
      backend.installPackage.mockResolvedValue(makeCliResult({
        exitCode: 1,
        stdout: 'error: NU1605: Warning As Error: Detected package downgrade',
        stderr: '',
      }));
      backend.listAllForSolution.mockResolvedValue({
        installed: [makeInstalledPkg('EFCore.NamingConventions', '/sol/A/A.csproj')],
        implicit: [],
      });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'INSTALL_PACKAGE_MULTI',
        projects: ['/sol/A/A.csproj'],
        packageId: 'EFCore.NamingConventions',
        version: '10.0.1',
      });
      await new Promise((r) => setTimeout(r, 30));

      expect(restoreSpy).toHaveBeenCalled();
      expect(backend.restoreProject).toHaveBeenCalledWith('/sol/A/A.csproj');
      const err = posted.find((m) => m.type === 'OPERATION_ERROR') as any;
      expect(err?.rollbackApplied).toBe(true);
      expect(err?.canRollback).toBe(false);
      expect(posted.filter((m) => m.type === 'INSTALLED_PACKAGES_PATCH')).toHaveLength(0);
    } finally {
      restoreSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  it('patches installed version and offers rollback when onFailedUpdate is keep', async () => {
    const cfgSpy = jest.spyOn(config, 'getConfig').mockReturnValue({
      dotnetConcurrency: 4,
      cacheTtlMs: 1000,
      includePrerelease: true,
      onFailedUpdate: 'keep',
      vulnerabilityScript: '',
      blockedPackages: [],
    });
    const restoreSpy = jest.spyOn(projectFiles, 'restoreFileSnapshots').mockResolvedValue(undefined);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
      { path: '/sol/A/A.csproj', content: '<PackageReference Include="EFCore.NamingConventions" Version="10.0.0" />' },
    ]);
    const verSpy = jest.spyOn(projectFiles, 'readPackageVersionFromSnapshots').mockReturnValue('10.0.0');

    try {
      const { stub, posted, simulateMessage } = makeProvider(SOLUTION_SCOPE);
      const backend = makeBackend();
      backend.installPackage.mockResolvedValue(makeCliResult({
        exitCode: 1,
        stdout: 'error: NU1605: Warning As Error: Detected package downgrade',
        stderr: '',
      }));
      backend.listAllForSolution.mockResolvedValue({
        installed: [],
        implicit: [],
        error: 'Restore failed',
      });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'INSTALL_PACKAGE_MULTI',
        projects: ['/sol/A/A.csproj'],
        packageId: 'EFCore.NamingConventions',
        version: '10.0.1',
      });
      await new Promise((r) => setTimeout(r, 30));

      expect(restoreSpy).not.toHaveBeenCalled();
      const err = posted.find((m) => m.type === 'OPERATION_ERROR') as any;
      expect(err?.rollbackApplied).toBe(false);
      expect(err?.canRollback).toBe(true);
      const patch = posted.find((m) => m.type === 'INSTALLED_PACKAGES_PATCH') as any;
      expect(patch?.packages[0].resolvedVersion).toBe('10.0.1');
    } finally {
      cfgSpy.mockRestore();
      restoreSpy.mockRestore();
      snapSpy.mockRestore();
      verSpy.mockRestore();
    }
  });

  it('responds to INSTALL_PACKAGE with OPERATION_TIMEOUT on timedOut', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.installPackage.mockResolvedValue(makeCliResult({ timedOut: true, exitCode: null }));

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'INSTALL_PACKAGE', projectPath: '/p/App.csproj', packageId: 'Pkg', version: '1.0.0' });
    await new Promise((r) => setTimeout(r, 10));

    expect(posted.some((m) => m.type === 'OPERATION_TIMEOUT')).toBe(true);
  });

  it('edits PackageReference and restores on a legacy csproj instead of dotnet add', async () => {
    const writeSpy = jest.spyOn(legacyPr, 'writeProjectXml').mockResolvedValue(undefined);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([{
      path: '/p/Legacy.csproj',
      content: `<Project ToolsVersion="4.0">
  <ItemGroup>
    <PackageReference Include="MongoDB.Driver" Version="3.4.0" />
    <PackageReference Include="MongoDB.Driver" Version="3.11.0" />
  </ItemGroup>
</Project>`,
    }]);
    try {
      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.restoreProject.mockResolvedValue(makeCliResult());
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'INSTALL_PACKAGE',
        projectPath: '/p/Legacy.csproj',
        packageId: 'MongoDB.Driver',
        version: '3.11.0',
      });
      await new Promise((r) => setTimeout(r, 30));

      expect(backend.installPackage).not.toHaveBeenCalled();
      expect(writeSpy).toHaveBeenCalledTimes(1);
      const written = writeSpy.mock.calls[0][1];
      expect(written.match(/MongoDB\.Driver/g)).toHaveLength(1);
      expect(written).toContain('Version="3.11.0"');
      expect(backend.restoreProject).toHaveBeenCalledWith('/p/Legacy.csproj', undefined);
      expect(posted.some((m) => m.type === 'OPERATION_SUCCESS')).toBe(true);
    } finally {
      writeSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  it('rolls back the legacy csproj snapshot when restore after XML edit fails', async () => {
    const writeSpy = jest.spyOn(legacyPr, 'writeProjectXml').mockResolvedValue(undefined);
    const restoreSpy = jest.spyOn(projectFiles, 'restoreFileSnapshots').mockResolvedValue(undefined);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([{
      path: '/p/Legacy.csproj',
      content: `<Project ToolsVersion="4.0"><ItemGroup><PackageReference Include="Pkg" Version="1.0.0" /></ItemGroup></Project>`,
    }]);
    try {
      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.restoreProject.mockResolvedValue(makeCliResult({
        exitCode: 1,
        stdout: 'error: NU1202: Package is not compatible',
      }));
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'INSTALL_PACKAGE',
        projectPath: '/p/Legacy.csproj',
        packageId: 'Pkg',
        version: '2.0.0',
      });
      await new Promise((r) => setTimeout(r, 30));

      expect(restoreSpy).toHaveBeenCalled();
      const err = posted.find((m) => m.type === 'OPERATION_ERROR') as any;
      expect(err?.rollbackApplied).toBe(true);
    } finally {
      writeSpy.mockRestore();
      restoreSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  it('rolls back the legacy snapshot when restore times out after XML edit', async () => {
    const writeSpy = jest.spyOn(legacyPr, 'writeProjectXml').mockResolvedValue(undefined);
    const restoreSpy = jest.spyOn(projectFiles, 'restoreFileSnapshots').mockResolvedValue(undefined);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([{
      path: '/p/Legacy.csproj',
      content: `<Project ToolsVersion="4.0"><ItemGroup><PackageReference Include="Pkg" Version="1.0.0" /></ItemGroup></Project>`,
    }]);
    try {
      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.restoreProject.mockResolvedValue(makeCliResult({ timedOut: true, exitCode: null }));
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'INSTALL_PACKAGE',
        projectPath: '/p/Legacy.csproj',
        packageId: 'Pkg',
        version: '2.0.0',
      });
      await new Promise((r) => setTimeout(r, 30));

      expect(writeSpy).toHaveBeenCalled();
      expect(restoreSpy).toHaveBeenCalled();
      const timeout = posted.find((m) => m.type === 'OPERATION_TIMEOUT') as { command?: string } | undefined;
      expect(timeout?.command).toContain('dotnet restore');
    } finally {
      writeSpy.mockRestore();
      restoreSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  it('keeps dotnet add for SDK-style net48', async () => {
    const writeSpy = jest.spyOn(legacyPr, 'writeProjectXml').mockResolvedValue(undefined);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([{
      path: '/p/App.csproj',
      content: `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="MongoDB.Driver" Version="3.4.0" />
  </ItemGroup>
</Project>`,
    }]);
    try {
      const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.installPackage.mockResolvedValue(makeCliResult());
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'INSTALL_PACKAGE',
        projectPath: '/p/App.csproj',
        packageId: 'MongoDB.Driver',
        version: '3.11.0',
      });
      await new Promise((r) => setTimeout(r, 30));

      expect(backend.installPackage).toHaveBeenCalledWith(
        '/p/App.csproj', 'MongoDB.Driver', '3.11.0', undefined,
      );
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  it('skips packages.config projects without writing', async () => {
    const writeSpy = jest.spyOn(legacyPr, 'writeProjectXml').mockResolvedValue(undefined);
    const cfgSpy = jest.spyOn(projectStyle, 'packagesConfigExists').mockResolvedValue(true);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([{
      path: '/p/Old.csproj',
      content: '<Project ToolsVersion="4.0"><PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup></Project>',
    }]);
    try {
      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'INSTALL_PACKAGE',
        projectPath: '/p/Old.csproj',
        packageId: 'Newtonsoft.Json',
        version: '13.0.3',
      });
      await new Promise((r) => setTimeout(r, 30));

      expect(backend.installPackage).not.toHaveBeenCalled();
      expect(backend.restoreProject).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
      const err = posted.find((m) => m.type === 'OPERATION_ERROR') as any;
      expect(err?.failures[0].stderr).toContain('packages.config');
    } finally {
      writeSpy.mockRestore();
      cfgSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  it('does not fail a Groups item when only a packages.config project is skipped', async () => {
    const writeSpy = jest.spyOn(legacyPr, 'writeProjectXml').mockResolvedValue(undefined);
    const cfgSpy = jest.spyOn(projectStyle, 'packagesConfigExists').mockImplementation(async (projectPath) =>
      projectPath.includes('/A/'),
    );
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockImplementation(async (projectPath) => [{
      path: projectPath,
      content: projectPath.includes('/A/')
        ? '<Project ToolsVersion="4.0"><PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup></Project>'
        : '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Pkg" Version="1.0.0" /></ItemGroup></Project>',
    }]);
    try {
      const { stub, posted, simulateMessage } = makeProvider(SOLUTION_SCOPE);
      const backend = makeBackend();
      backend.installPackage.mockResolvedValue(makeCliResult());
      backend.listAllForSolution.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: [{
          packageId: 'Pkg',
          fromVersion: '1.0.0',
          toVersion: '2.0.0',
          projects: ['/sol/A/A.csproj', '/sol/B/B.csproj'],
        }],
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(writeSpy).not.toHaveBeenCalled();
      expect(backend.installPackage).toHaveBeenCalledTimes(1);
      expect(backend.installPackage).toHaveBeenCalledWith('/sol/B/B.csproj', 'Pkg', '2.0.0', expect.anything());
      const finals = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status !== 'running' && (m as any).status !== 'pending') as any[];
      expect(finals.map((m) => m.status)).toEqual(['ok']);
      expect(finals[0].succeededProjects).toEqual(['/sol/B/B.csproj']);
      expect(posted.some((m) => m.type === 'OPERATION_ERROR')).toBe(false);
    } finally {
      writeSpy.mockRestore();
      cfgSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  it('uses XML edit on legacy and dotnet add on SDK in a mixed solution', async () => {
    const writeSpy = jest.spyOn(legacyPr, 'writeProjectXml').mockResolvedValue(undefined);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockImplementation(async (projectPath) => [{
      path: projectPath,
      content: projectPath.includes('/A/')
        ? `<Project ToolsVersion="4.0"><ItemGroup><PackageReference Include="Pkg" Version="1.0.0" /></ItemGroup></Project>`
        : `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Pkg" Version="1.0.0" /></ItemGroup></Project>`,
    }]);
    try {
      const { stub, simulateMessage } = makeProvider(SOLUTION_SCOPE);
      const backend = makeBackend();
      backend.installPackage.mockResolvedValue(makeCliResult());
      backend.restoreProject.mockResolvedValue(makeCliResult());
      backend.listAllForSolution.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'INSTALL_PACKAGE_MULTI',
        projects: ['/sol/A/A.csproj', '/sol/B/B.csproj'],
        packageId: 'Pkg',
        version: '2.0.0',
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(writeSpy.mock.calls[0][0]).toBe('/sol/A/A.csproj');
      expect(backend.restoreProject).toHaveBeenCalledWith('/sol/A/A.csproj', undefined);
      expect(backend.installPackage).toHaveBeenCalledTimes(1);
      expect(backend.installPackage).toHaveBeenCalledWith('/sol/B/B.csproj', 'Pkg', '2.0.0', undefined);
    } finally {
      writeSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  // ── INSTALL_PACKAGE_MULTI (partial success) ────────────────────────────────

  it('handles partial failure in INSTALL_PACKAGE_MULTI', async () => {
    const { stub, posted, simulateMessage } = makeProvider(SOLUTION_SCOPE);
    const backend = makeBackend();

    backend.installPackage
      .mockResolvedValueOnce(makeCliResult())                           // A succeeds
      .mockResolvedValueOnce(makeCliResult({ exitCode: 1, stderr: 'fail B' })); // B fails

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'INSTALL_PACKAGE_MULTI', projects: ['/sol/A/A.csproj', '/sol/B/B.csproj'], packageId: 'Pkg', version: '1.0.0' });
    await new Promise((r) => setTimeout(r, 30));

    const err = posted.find((m) => m.type === 'OPERATION_ERROR') as any;
    expect(err?.failures).toHaveLength(1);
    expect(err?.failures[0].stderr).toBe('fail B');
    expect(err?.succeededProjects).toContain('/sol/A/A.csproj');
    const patch = posted.find((m) => m.type === 'INSTALLED_PACKAGES_PATCH') as any;
    expect(patch?.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectPath: '/sol/A/A.csproj', resolvedVersion: '1.0.0' }),
      ]),
    );
    expect(patch?.packages.some((p: { projectPath: string }) => p.projectPath === '/sol/B/B.csproj')).toBe(false);
  });

  it('INSTALL_PACKAGE_MULTI skips projects already on the target version', async () => {
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockImplementation(async (projectPath) => [
      { path: projectPath, content: '' },
    ]);
    const verSpy = jest.spyOn(projectFiles, 'readPackageVersionFromSnapshots').mockImplementation((snapshots) => {
      const projectPath = snapshots[0]?.path ?? '';
      return projectPath.includes('A.csproj') ? '2.0.0' : '1.0.0';
    });

    try {
      const { stub, posted, simulateMessage } = makeProvider(SOLUTION_SCOPE);
      const backend = makeBackend();
      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'INSTALL_PACKAGE_MULTI',
        projects: ['/sol/A/A.csproj', '/sol/B/B.csproj'],
        packageId: 'Pkg',
        version: '2.0.0',
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(backend.installPackage).toHaveBeenCalledTimes(1);
      expect(backend.installPackage.mock.calls[0][0]).toBe('/sol/B/B.csproj');
      expect(posted.some((m) => m.type === 'OPERATION_SUCCESS')).toBe(true);
    } finally {
      snapSpy.mockRestore();
      verSpy.mockRestore();
    }
  });

  it('INSTALL_PACKAGE skips dotnet add when the project is already on the version', async () => {
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
      { path: '/p/App.csproj', content: '' },
    ]);
    const verSpy = jest.spyOn(projectFiles, 'readPackageVersionFromSnapshots').mockReturnValue('1.0.0');

    try {
      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({ type: 'INSTALL_PACKAGE', projectPath: '/p/App.csproj', packageId: 'Pkg', version: '1.0.0' });
      await new Promise((r) => setTimeout(r, 20));

      expect(backend.installPackage).not.toHaveBeenCalled();
      expect(posted.some((m) => m.type === 'OPERATION_SUCCESS')).toBe(true);
    } finally {
      snapSpy.mockRestore();
      verSpy.mockRestore();
    }
  });

  it('INSTALL_PACKAGE_MULTI never runs more than dotnetConcurrency installs at once', async () => {
    const cfgSpy = jest.spyOn(config, 'getConfig').mockReturnValue({
      dotnetConcurrency: 2,
      cacheTtlMs: 1000,
      includePrerelease: false,
      onFailedUpdate: 'rollback',
      vulnerabilityScript: '',
      blockedPackages: [],
    });
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([]);
    const { stub, posted, simulateMessage } = makeProvider(SOLUTION_SCOPE);
    const backend = makeBackend();
    let inFlight = 0;
    let maxInFlight = 0;
    backend.installPackage.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
      return makeCliResult();
    });

    try {
      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      const projects = ['/sol/A/A.csproj', '/sol/B/B.csproj', '/sol/C/C.csproj', '/sol/D/D.csproj', '/sol/E/E.csproj', '/sol/F/F.csproj'];
      simulateMessage({ type: 'INSTALL_PACKAGE_MULTI', projects, packageId: 'Pkg', version: '1.0.0' });

      for (let i = 0; i < 50; i++) {
        if (posted.some((m) => m.type === 'OPERATION_SUCCESS' || m.type === 'OPERATION_ERROR')) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(maxInFlight).toBeGreaterThan(0);
      expect(maxInFlight).toBeLessThanOrEqual(2);
      expect(backend.installPackage).toHaveBeenCalledTimes(6);
      const success = posted.find((m) => m.type === 'OPERATION_SUCCESS') as any;
      expect(success?.affectedProjects).toHaveLength(6);
    } finally {
      cfgSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  it('REMOVE_PACKAGE_MULTI never runs more than dotnetConcurrency removes at once', async () => {
    const cfgSpy = jest.spyOn(config, 'getConfig').mockReturnValue({
      dotnetConcurrency: 2,
      cacheTtlMs: 1000,
      includePrerelease: false,
      onFailedUpdate: 'rollback',
      vulnerabilityScript: '',
      blockedPackages: [],
    });
    const { stub, posted, simulateMessage } = makeProvider(SOLUTION_SCOPE);
    const backend = makeBackend();
    let inFlight = 0;
    let maxInFlight = 0;
    backend.removePackage.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight--;
      return makeCliResult();
    });

    try {
      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      const projects = ['/sol/A/A.csproj', '/sol/B/B.csproj', '/sol/C/C.csproj', '/sol/D/D.csproj', '/sol/E/E.csproj', '/sol/F/F.csproj'];
      simulateMessage({ type: 'REMOVE_PACKAGE_MULTI', projects, packageId: 'Pkg' });

      for (let i = 0; i < 50; i++) {
        if (posted.some((m) => m.type === 'OPERATION_SUCCESS' || m.type === 'OPERATION_ERROR')) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(maxInFlight).toBeGreaterThan(0);
      expect(maxInFlight).toBeLessThanOrEqual(2);
      expect(backend.removePackage).toHaveBeenCalledTimes(6);
      const success = posted.find((m) => m.type === 'OPERATION_SUCCESS') as any;
      expect(success?.operation).toBe('remove');
      expect(success?.affectedProjects).toHaveLength(6);
    } finally {
      cfgSpy.mockRestore();
    }
  });

  it('does not wipe INSTALLED_PACKAGES when all updates fail and list reports restore failure', async () => {
    const { stub, posted, simulateMessage } = makeProvider(SOLUTION_SCOPE);
    const backend = makeBackend();
    backend.installPackage.mockResolvedValue(makeCliResult({
      exitCode: 1,
      stdout: 'error: NU1605: Warning As Error: Detected package downgrade',
      stderr: '',
    }));
    backend.listAllForSolution.mockResolvedValue({
      installed: [],
      implicit: [],
      error: 'Restore failed. Run `dotnet restore` for more details on the issue.',
    });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'INSTALL_PACKAGE_MULTI',
      projects: ['/sol/A/A.csproj'],
      packageId: 'EFCore.NamingConventions',
      version: '10.0.1',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(posted.some((m) => m.type === 'OPERATION_ERROR')).toBe(true);
    expect(posted.filter((m) => m.type === 'INSTALLED_PACKAGES')).toHaveLength(0);
    expect(backend.listAllForSolution).toHaveBeenCalled();
  });

  // ── REMOVE_PACKAGE ─────────────────────────────────────────────────────────

  it('responds to REMOVE_PACKAGE with OPERATION_SUCCESS', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'REMOVE_PACKAGE', projectPath: '/p/App.csproj', packageId: 'Pkg' });
    await new Promise((r) => setTimeout(r, 10));

    const success = posted.find((m) => m.type === 'OPERATION_SUCCESS') as any;
    expect(success?.operation).toBe('remove');
  });

  // ── GET_LOG_ENTRIES ────────────────────────────────────────────────────────

  it('responds to GET_LOG_ENTRIES with LOG_ENTRIES', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'GET_LOG_ENTRIES' });
    await new Promise((r) => setTimeout(r, 10));

    expect(posted.some((m) => m.type === 'LOG_ENTRIES')).toBe(true);
  });

  it('CLEAR_LOG wipes Logger and posts LOG_CLEARED', async () => {
    logger.logCliOperation({
      timestamp: new Date(),
      command: 'dotnet --version',
      args: ['--version'],
      stdout: '9',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
    });
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'CLEAR_LOG' });
    await new Promise((r) => setTimeout(r, 10));

    expect(logger.getEntries()).toHaveLength(0);
    expect(posted.some((m) => m.type === 'LOG_CLEARED')).toBe(true);
  });

  // ── OPEN_CONFIG_FILE ───────────────────────────────────────────────────────

  it('calls openTextDocument for OPEN_CONFIG_FILE', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode');
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);

    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'OPEN_CONFIG_FILE', filePath: '/p/nuget.config' });
    await new Promise((r) => setTimeout(r, 10));

    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith('/p/nuget.config');
  });

  it('reveals the source add line for OPEN_CONFIG_FILE with sourceName', async () => {
    const vscode = require('vscode');
    const xml = `<?xml version="1.0"?>
<configuration>
  <packageSources>
    <add key="nexus" value="https://nexus.example/index.json" />
  </packageSources>
</configuration>`;
    const editor = { selection: undefined as unknown, revealRange: jest.fn() };
    vscode.workspace.openTextDocument.mockResolvedValueOnce({
      getText: () => xml,
      lineAt: (n: number) => ({ range: { end: { line: n, character: 10 } } }),
    });
    vscode.window.showTextDocument.mockResolvedValueOnce(editor);
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'OPEN_CONFIG_FILE', filePath: '/p/nuget.config', sourceName: 'nexus' });
    await new Promise((r) => setTimeout(r, 20));

    expect(editor.revealRange).toHaveBeenCalled();
    expect(editor.selection).toBeDefined();
  });

  it('writes clipboard for COPY_TEXT', async () => {
    const vscode = require('vscode');
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'COPY_TEXT', text: 'https://api.nuget.org/v3/index.json' });
    await new Promise((r) => setTimeout(r, 10));

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('https://api.nuget.org/v3/index.json');
  });

  it('opens http URLs in the browser for OPEN_URL', async () => {
    const vscode = require('vscode');
    vscode.env.openExternal.mockClear();
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'OPEN_URL', url: 'https://api.nuget.org/v3/index.json' });
    await new Promise((r) => setTimeout(r, 10));

    expect(vscode.env.openExternal).toHaveBeenCalled();
    const uri = vscode.env.openExternal.mock.calls[0][0];
    expect(uri.scheme).toBe('https');
  });

  it('ignores non-http OPEN_URL', async () => {
    const vscode = require('vscode');
    vscode.env.openExternal.mockClear();
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'OPEN_URL', url: 'D:\\\\packages' });
    await new Promise((r) => setTimeout(r, 10));

    expect(vscode.env.openExternal).not.toHaveBeenCalled();
  });

  it('warns on SET_SOURCE_SECRETS when the path is not a writable nuget.config', async () => {
    const vscode = require('vscode');
    vscode.window.showWarningMessage.mockClear();
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'SET_SOURCE_SECRETS',
      name: 'nexus',
      configFilePath: '/p/Directory.Build.props',
      url: 'https://nexus.example/index.json',
      username: 'ci',
      password: 'hunter2',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    expect(vscode.window.showWarningMessage.mock.calls[0][0]).toMatch(/writable nuget\.config/i);
  });

  // ── UPDATE_PACKAGES_BATCH ──────────────────────────────────────────────────

  it('updates packages sequentially and reports BATCH_UPDATE progress', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'UPDATE_PACKAGES_BATCH',
      kind: 'all',
      includePrerelease: false,
      items: [
        { packageId: 'A', fromVersion: '1.0.0', toVersion: '2.0.0', projects: ['/p/App.csproj'] },
        { packageId: 'B', fromVersion: '1.0.0', toVersion: '1.1.0', projects: ['/p/App.csproj'] },
      ],
    });
    await new Promise((r) => setTimeout(r, 40));

    expect(backend.installPackage.mock.calls.map((c: unknown[]) => c[1])).toEqual(['A', 'B']);
    expect(posted.some((m) => m.type === 'BATCH_UPDATE_STARTED')).toBe(true);
    expect(posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'ok')).toHaveLength(2);
    expect(posted.some((m) => m.type === 'BATCH_UPDATE_FINISHED')).toBe(true);
    expect(posted.some((m) => m.type === 'OPERATION_SUCCESS')).toBe(false);
  });

  it('reports per-project progress while a batch package installs', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'UPDATE_PACKAGES_BATCH',
      kind: 'all',
      includePrerelease: false,
      items: [{
        packageId: 'A',
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        projects: ['/p/App.csproj', '/p/Lib.csproj'],
      }],
    });
    await new Promise((r) => setTimeout(r, 40));

    const running = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'running') as any[];
    expect(running.some((m) => m.completedProjects?.length === 1)).toBe(true);
    expect(running.some((m) => m.completedProjects?.length === 2)).toBe(true);
    const ok = posted.find((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'ok') as any;
    expect(ok.succeededProjects).toEqual(['/p/App.csproj', '/p/Lib.csproj']);
    expect(ok.completedProjects).toEqual(['/p/App.csproj', '/p/Lib.csproj']);
  });

  it('continues the batch when one package fails', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.installPackage
      .mockResolvedValueOnce(makeCliResult({ exitCode: 1, stderr: 'error: NU1605 fail A' }))
      .mockResolvedValueOnce(makeCliResult());
    backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'UPDATE_PACKAGES_BATCH',
      kind: 'family',
      family: 'Microsoft.Extensions',
      includePrerelease: true,
      items: [
        { packageId: 'A', fromVersion: '8.0.0', toVersion: '9.0.0', projects: ['/p/App.csproj'] },
        { packageId: 'B', fromVersion: '8.0.0', toVersion: '9.0.0', projects: ['/p/App.csproj'] },
      ],
    });
    await new Promise((r) => setTimeout(r, 40));

    const items = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM') as any[];
    const finals = items.filter((m) => m.status === 'error' || m.status === 'ok');
    expect(finals.map((m) => [m.packageId, m.status])).toEqual([
      ['A', 'error'],
      ['B', 'ok'],
    ]);
    expect(finals[0].error).toContain('NU1605');
    expect(posted.some((m) => m.type === 'OPERATION_ERROR')).toBe(false);
    expect(backend.installPackage).toHaveBeenCalledTimes(2);
  });

  it('retries a timed-out group add once and succeeds without rollback', async () => {
    const restoreSpy = jest.spyOn(projectFiles, 'restoreFileSnapshots').mockResolvedValue(undefined);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([]);
    try {
      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.installPackage
        .mockResolvedValueOnce(makeCliResult({ timedOut: true, exitCode: null, stderr: 'Operation timed out' }))
        .mockResolvedValueOnce(makeCliResult());
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: [{
          packageId: 'MongoDB.Driver',
          fromVersion: '2.0.0',
          toVersion: '3.0.0',
          projects: ['/p/App.csproj'],
        }],
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(backend.installPackage).toHaveBeenCalledTimes(2);
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(backend.restoreProject).not.toHaveBeenCalled();
      const finals = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status !== 'running' && (m as any).status !== 'pending') as any[];
      expect(finals.map((m) => [m.packageId, m.status])).toEqual([['MongoDB.Driver', 'ok']]);
    } finally {
      restoreSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  it('retries NU1301 once, then rolls back only after the second failure', async () => {
    const restoreSpy = jest.spyOn(projectFiles, 'restoreFileSnapshots').mockResolvedValue(undefined);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
      { path: '/p/App.csproj', content: '<Project Sdk="Microsoft.NET.Sdk" />' },
    ]);
    try {
      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.installPackage.mockResolvedValue(makeCliResult({
        exitCode: 1,
        stderr: 'error NU1301: Unable to load the service index for source https://api.nuget.org/v3/index.json',
      }));
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: [{
          packageId: 'A',
          fromVersion: '1.0.0',
          toVersion: '2.0.0',
          projects: ['/p/App.csproj'],
        }],
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(backend.installPackage).toHaveBeenCalledTimes(2);
      expect(restoreSpy).toHaveBeenCalledTimes(1);
      const finals = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'error') as any[];
      expect(finals).toHaveLength(1);
      expect(finals[0].error).toContain('NU1301');
    } finally {
      restoreSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  it('does not retry NU1605 during a group update', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.installPackage.mockResolvedValue(makeCliResult({
      exitCode: 1,
      stderr: 'error: NU1605 fail A',
    }));
    backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'UPDATE_PACKAGES_BATCH',
      kind: 'all',
      includePrerelease: false,
      items: [{
        packageId: 'A',
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        projects: ['/p/App.csproj'],
      }],
    });
    await new Promise((r) => setTimeout(r, 40));

    expect(backend.installPackage).toHaveBeenCalledTimes(1);
    expect(posted.some((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'error')).toBe(true);
  });

  // ── Entangled clusters (#38): a ProjectReference version floor makes every
  // restore fail until every package it (transitively) affects lands together.

  describe('UPDATE_PACKAGES_BATCH — entangled clusters (#38)', () => {
    const APP_XML =
      '<PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.15.3" />'
      + '<PackageReference Include="Swashbuckle.AspNetCore.SwaggerGen" Version="10.1.7" />';

    const clusterItems = [
      { packageId: 'OpenTelemetry.Extensions.Hosting', fromVersion: '1.15.3', toVersion: '1.18.0', projects: ['/p/App.csproj'] },
      { packageId: 'Swashbuckle.AspNetCore.SwaggerGen', fromVersion: '10.1.7', toVersion: '10.2.3', projects: ['/p/App.csproj'] },
    ];

    function mockFloors(): void {
      jest.spyOn(projectAssets, 'readProjectAssets').mockResolvedValue({
        dependencies: new Map(),
        floors: new Map([
          ['opentelemetry.extensions.hosting', '1.18.0'],
          ['swashbuckle.aspnetcore.swaggergen', '10.2.3'],
        ]),
      });
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('applies both entangled packages with --no-restore, then a single shared restore', async () => {
      mockFloors();
      jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
        { path: '/p/App.csproj', content: APP_XML },
      ]);

      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.installPackageNoRestore.mockResolvedValue(makeCliResult());
      backend.restoreProject.mockResolvedValue(makeCliResult());
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: clusterItems,
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(backend.installPackageNoRestore).toHaveBeenCalledTimes(2);
      expect(backend.installPackageNoRestore).toHaveBeenCalledWith(
        '/p/App.csproj', 'OpenTelemetry.Extensions.Hosting', '1.18.0', expect.anything(),
      );
      expect(backend.installPackageNoRestore).toHaveBeenCalledWith(
        '/p/App.csproj', 'Swashbuckle.AspNetCore.SwaggerGen', '10.2.3', expect.anything(),
      );
      expect(backend.restoreProject).toHaveBeenCalledTimes(1);
      expect(backend.installPackage).not.toHaveBeenCalled();

      const finals = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'ok') as any[];
      expect(finals.map((m) => m.packageId).sort()).toEqual([
        'OpenTelemetry.Extensions.Hosting', 'Swashbuckle.AspNetCore.SwaggerGen',
      ].sort());
      expect(finals.every((m) => m.succeededProjects.includes('/p/App.csproj'))).toBe(true);
    });

    it('rolls back both packages together when the shared restore still fails (onFailedUpdate: rollback)', async () => {
      mockFloors();
      jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
        { path: '/p/App.csproj', content: APP_XML },
      ]);
      const restoreSnapshotSpy = jest.spyOn(projectFiles, 'restoreFileSnapshots').mockResolvedValue(undefined);

      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.installPackageNoRestore.mockResolvedValue(makeCliResult());
      backend.restoreProject.mockResolvedValue(makeCliResult({
        exitCode: 1,
        stdout: 'error NU1605: still broken',
      }));
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: clusterItems,
      });
      await new Promise((r) => setTimeout(r, 40));

      // One shared snapshot, rolled back once per clustered package sharing it —
      // still correct (idempotent), just not deduplicated.
      expect(restoreSnapshotSpy).toHaveBeenCalled();
      const finished = posted.find((m) => m.type === 'BATCH_UPDATE_FINISHED') as any;
      expect(finished.canRollback).toBe(false);
      const finals = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'error') as any[];
      expect(finals).toHaveLength(2);
    });

    it('keeps the shared restore failure and offers Rollback (onFailedUpdate: keep)', async () => {
      jest.spyOn(config, 'getConfig').mockReturnValue({
        dotnetConcurrency: 4,
        cacheTtlMs: 1000,
        includePrerelease: false,
        onFailedUpdate: 'keep',
        vulnerabilityScript: '',
        blockedPackages: [],
      });
      mockFloors();
      jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
        { path: '/p/App.csproj', content: APP_XML },
      ]);
      const restoreSnapshotSpy = jest.spyOn(projectFiles, 'restoreFileSnapshots').mockResolvedValue(undefined);

      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.installPackageNoRestore.mockResolvedValue(makeCliResult());
      backend.restoreProject.mockResolvedValue(makeCliResult({
        exitCode: 1,
        stdout: 'error NU1605: still broken',
      }));
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: clusterItems,
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(restoreSnapshotSpy).not.toHaveBeenCalled();
      const finished = posted.find((m) => m.type === 'BATCH_UPDATE_FINISHED') as any;
      expect(finished.canRollback).toBe(true);
    });

    it('retries a transient failure on the no-restore add step, then succeeds', async () => {
      mockFloors();
      jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
        { path: '/p/App.csproj', content: APP_XML },
      ]);

      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.installPackageNoRestore
        .mockResolvedValueOnce(makeCliResult({ exitCode: 1, stderr: 'HTTP 503 Service Unavailable' }))
        .mockResolvedValue(makeCliResult());
      backend.restoreProject.mockResolvedValue(makeCliResult());
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: clusterItems,
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(backend.installPackageNoRestore).toHaveBeenCalledTimes(3); // 1 retried + 1 clean
      expect(backend.restoreProject).toHaveBeenCalledTimes(1);
      const finals = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'ok') as any[];
      expect(finals).toHaveLength(2);
    });

    it('retries a transient failure on the shared restore step, then succeeds', async () => {
      mockFloors();
      jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
        { path: '/p/App.csproj', content: APP_XML },
      ]);

      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.installPackageNoRestore.mockResolvedValue(makeCliResult());
      backend.restoreProject
        .mockResolvedValueOnce(makeCliResult({ exitCode: 1, stderr: 'HTTP 503 Service Unavailable' }))
        .mockResolvedValue(makeCliResult());
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: clusterItems,
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(backend.restoreProject).toHaveBeenCalledTimes(2);
      const finals = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'ok') as any[];
      expect(finals).toHaveLength(2);
    });

    it('runs a non-clustered item on the same project through the normal one-by-one flow', async () => {
      mockFloors();
      jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
        { path: '/p/App.csproj', content: APP_XML },
      ]);

      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.installPackageNoRestore.mockResolvedValue(makeCliResult());
      backend.installPackage.mockResolvedValue(makeCliResult());
      backend.restoreProject.mockResolvedValue(makeCliResult());
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: [
          ...clusterItems,
          { packageId: 'Scalar.AspNetCore', fromVersion: '2.12.46', toVersion: '2.17.1', projects: ['/p/App.csproj'] },
        ],
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(backend.installPackageNoRestore).toHaveBeenCalledTimes(2);
      expect(backend.installPackage).toHaveBeenCalledWith(
        '/p/App.csproj', 'Scalar.AspNetCore', '2.17.1', expect.anything(),
      );
      const finals = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'ok') as any[];
      expect(finals).toHaveLength(3);
    });

    it('does not touch a batch with no floor violation (the common case)', async () => {
      jest.spyOn(projectAssets, 'readProjectAssets').mockResolvedValue({ dependencies: new Map(), floors: new Map() });
      jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([]);

      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.installPackage.mockResolvedValue(makeCliResult());
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: [
          { packageId: 'A', fromVersion: '1.0.0', toVersion: '2.0.0', projects: ['/p/App.csproj'] },
        ],
      });
      await new Promise((r) => setTimeout(r, 40));

      expect(backend.installPackageNoRestore).not.toHaveBeenCalled();
      expect(backend.installPackage).toHaveBeenCalledTimes(1);
      expect(posted.some((m) => m.type === 'BATCH_UPDATE_ITEM' && (m as any).status === 'ok')).toBe(true);
    });
  });

  it('does not retry a cancelled group add', async () => {
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([]);

    backend.installPackage.mockImplementation((_project, _packageId, _version, signal) => {
      return new Promise((resolve) => {
        const finishCancelled = () => resolve(makeCliResult({
          exitCode: null,
          stderr: 'Cancelled',
          cancelled: true,
        }));
        if (signal?.aborted) {
          finishCancelled();
          return;
        }
        signal?.addEventListener('abort', finishCancelled);
      });
    });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'UPDATE_PACKAGES_BATCH',
      kind: 'all',
      includePrerelease: false,
      items: [{
        packageId: 'A',
        fromVersion: '1.0.0',
        toVersion: '2.0.0',
        projects: ['/p/App.csproj'],
      }],
    });
    await new Promise((r) => setTimeout(r, 20));
    simulateMessage({ type: 'CANCEL_BATCH_UPDATE' });
    await new Promise((r) => setTimeout(r, 40));

    expect(backend.installPackage).toHaveBeenCalledTimes(1);
    snapSpy.mockRestore();
  });

  it('CANCEL_BATCH_UPDATE aborts the in-flight add and skips remaining packages', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([]);

    backend.installPackage.mockImplementation((_project, packageId, _version, signal) => {
      return new Promise((resolve) => {
        const finishCancelled = () => resolve(makeCliResult({
          exitCode: null,
          stderr: 'Cancelled',
          cancelled: true,
        }));
        if (signal?.aborted) {
          finishCancelled();
          return;
        }
        if (packageId === 'A') {
          signal?.addEventListener('abort', finishCancelled);
          return;
        }
        resolve(makeCliResult());
      });
    });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'UPDATE_PACKAGES_BATCH',
      kind: 'all',
      includePrerelease: false,
      items: [
        { packageId: 'A', fromVersion: '1.0.0', toVersion: '2.0.0', projects: ['/p/App.csproj'] },
        { packageId: 'B', fromVersion: '1.0.0', toVersion: '1.1.0', projects: ['/p/App.csproj'] },
      ],
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(backend.installPackage).toHaveBeenCalledTimes(1);
    expect(backend.installPackage.mock.calls[0][3]).toBeInstanceOf(AbortSignal);

    simulateMessage({ type: 'CANCEL_BATCH_UPDATE' });
    await new Promise((r) => setTimeout(r, 40));

    expect(backend.installPackage.mock.calls.map((c: unknown[]) => c[1])).toEqual(['A']);
    const items = posted.filter((m) => m.type === 'BATCH_UPDATE_ITEM') as Array<{
      packageId: string;
      status: string;
    }>;
    const finals = items.filter((m) => m.status === 'cancelled');
    expect(finals.map((m) => m.packageId).sort()).toEqual(['A', 'B']);
    const finished = posted.find((m) => m.type === 'BATCH_UPDATE_FINISHED') as {
      cancelled?: boolean;
      canRollback?: boolean;
    } | undefined;
    expect(finished?.cancelled).toBe(true);
    expect(finished?.canRollback).toBe(false);
    expect(posted.some((m) => m.type === 'OPERATION_ERROR')).toBe(false);
    snapSpy.mockRestore();
  });

  it('Stop restores in-flight files and does not offer Rollback even when onFailedUpdate is keep', async () => {
    const cfgSpy = jest.spyOn(config, 'getConfig').mockReturnValue({
      dotnetConcurrency: 4,
      cacheTtlMs: 1000,
      includePrerelease: true,
      onFailedUpdate: 'keep',
      vulnerabilityScript: '',
      blockedPackages: [],
    });
    const restoreSpy = jest.spyOn(projectFiles, 'restoreFileSnapshots').mockResolvedValue(undefined);
    const snapSpy = jest.spyOn(projectFiles, 'snapshotProjectFiles').mockResolvedValue([
      { path: '/p/App.csproj', content: '<PackageReference Include="A" Version="1.0.0" />' },
    ]);

    try {
      const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
      const backend = makeBackend();
      backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });
      backend.installPackage.mockImplementation((_project, _id, _version, signal) => {
        return new Promise((resolve) => {
          const finishCancelled = () => resolve(makeCliResult({
            exitCode: null,
            stderr: 'Cancelled',
            cancelled: true,
          }));
          if (signal?.aborted) {
            finishCancelled();
            return;
          }
          signal?.addEventListener('abort', finishCancelled);
        });
      });

      const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
      broker.attach();

      simulateMessage({
        type: 'UPDATE_PACKAGES_BATCH',
        kind: 'all',
        includePrerelease: false,
        items: [
          { packageId: 'A', fromVersion: '1.0.0', toVersion: '2.0.0', projects: ['/p/App.csproj'] },
        ],
      });
      await new Promise((r) => setTimeout(r, 20));
      simulateMessage({ type: 'CANCEL_BATCH_UPDATE' });
      await new Promise((r) => setTimeout(r, 40));

      expect(restoreSpy).toHaveBeenCalled();
      const finished = posted.find((m) => m.type === 'BATCH_UPDATE_FINISHED') as {
        cancelled?: boolean;
        canRollback?: boolean;
      } | undefined;
      expect(finished?.cancelled).toBe(true);
      expect(finished?.canRollback).toBe(false);
      expect(posted.some((m) => m.type === 'INSTALLED_PACKAGES_PATCH')).toBe(false);
    } finally {
      cfgSpy.mockRestore();
      restoreSpy.mockRestore();
      snapSpy.mockRestore();
    }
  });

  // ── SELECT_SCOPE ───────────────────────────────────────────────────────────

  it('SELECT_SCOPE activates the picked project', async () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/sol'), name: 'sol', index: 0 },
    ];
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file('/sol/App.sln'),
      vscode.Uri.file('/sol/src/Lib.csproj'),
    ]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ fsPath: '/sol/src/Lib.csproj' });

    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    stub.isClientReady = true;
    const backend = makeBackend();
    const parser = makeSolutionParser();
    const resolver = makeConfigResolver();

    const broker = new WebviewMessageBroker(stub, backend, parser, resolver, logger);
    broker.attach();
    simulateMessage({ type: 'SELECT_SCOPE' });
    await new Promise((r) => setTimeout(r, 30));

    expect(stub.setScope).toHaveBeenCalledWith({ kind: 'project', projectPath: '/sol/src/Lib.csproj' });
    const init = posted.find((m) => m.type === 'INIT_STATE') as { scope?: WorkspaceScope } | undefined;
    expect(init?.scope).toEqual({ kind: 'project', projectPath: '/sol/src/Lib.csproj' });
    expect(parser.getProjects).not.toHaveBeenCalled();
  });

  it('SELECT_SCOPE skips activate when the current file is picked again', async () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/p'), name: 'p', index: 0 },
    ];
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file('/p/App.csproj'),
    ]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ fsPath: '/p/App.csproj' });

    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    stub.isClientReady = true;
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();
    simulateMessage({ type: 'SELECT_SCOPE' });
    await new Promise((r) => setTimeout(r, 20));

    expect(stub.setScope).not.toHaveBeenCalled();
  });

  it('SELECT_SCOPE does nothing when QuickPick is cancelled', async () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: vscode.Uri.file('/sol'), name: 'sol', index: 0 },
    ];
    (vscode.workspace.findFiles as jest.Mock).mockResolvedValue([
      vscode.Uri.file('/sol/App.sln'),
    ]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();
    simulateMessage({ type: 'SELECT_SCOPE' });
    await new Promise((r) => setTimeout(r, 20));

    expect(stub.setScope).not.toHaveBeenCalled();
  });

  it('rejects INSTALL_PACKAGE for a blocked installed id', async () => {
    const blockedSpy = jest.spyOn(config, 'getBlockedPackages').mockReturnValue(['Pkg']);
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Pkg', '/p/App.csproj')],
      implicit: [],
    });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 20));
    backend.installPackage.mockClear();

    simulateMessage({ type: 'INSTALL_PACKAGE', projectPath: '/p/App.csproj', packageId: 'Pkg', version: '2.0.0' });
    await new Promise((r) => setTimeout(r, 20));

    expect(backend.installPackage).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('Updates blocked for this workspace'),
    );
    blockedSpy.mockRestore();
  });

  it('allows INSTALL_PACKAGE of a blocked id that is not installed', async () => {
    const blockedSpy = jest.spyOn(config, 'getBlockedPackages').mockReturnValue(['NewPkg']);
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 20));

    simulateMessage({ type: 'INSTALL_PACKAGE', projectPath: '/p/App.csproj', packageId: 'NewPkg', version: '1.0.0' });
    await new Promise((r) => setTimeout(r, 20));

    expect(backend.installPackage).toHaveBeenCalledWith('/p/App.csproj', 'NewPkg', '1.0.0', undefined);
    blockedSpy.mockRestore();
  });

  it('drops blocked ids from UPDATE_PACKAGES_BATCH', async () => {
    const blockedSpy = jest.spyOn(config, 'getBlockedPackages').mockReturnValue(['A']);
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({ installed: [], implicit: [] });

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({
      type: 'UPDATE_PACKAGES_BATCH',
      kind: 'all',
      includePrerelease: false,
      items: [
        { packageId: 'A', fromVersion: '1.0.0', toVersion: '2.0.0', projects: ['/p/App.csproj'] },
        { packageId: 'B', fromVersion: '1.0.0', toVersion: '1.1.0', projects: ['/p/App.csproj'] },
      ],
    });
    await new Promise((r) => setTimeout(r, 40));

    expect(backend.installPackage.mock.calls.map((c: unknown[]) => c[1])).toEqual(['B']);
    blockedSpy.mockRestore();
  });

  it('SET_PACKAGE_BLOCKED posts BLOCKED_PACKAGES', async () => {
    const setSpy = jest.spyOn(config, 'setPackageBlocked').mockResolvedValue(['Pkg']);
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'SET_PACKAGE_BLOCKED', packageId: 'Pkg', blocked: true });
    await new Promise((r) => setTimeout(r, 20));

    expect(setSpy).toHaveBeenCalledWith('Pkg', true);
    const msg = posted.find((m) => m.type === 'BLOCKED_PACKAGES') as { packageIds?: string[] } | undefined;
    expect(msg?.packageIds).toEqual(['Pkg']);
    setSpy.mockRestore();
  });

  it('SHOW_TOAST uses showInformationMessage', async () => {
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const broker = new WebviewMessageBroker(stub, makeBackend(), makeSolutionParser(), makeConfigResolver(), logger);
    broker.attach();

    simulateMessage({ type: 'SHOW_TOAST', message: 'Updates blocked for this workspace.' });
    await new Promise((r) => setTimeout(r, 10));

    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Updates blocked for this workspace.',
    );
  });

  it('INIT_STATE includes the SDK compiler cap from the probe', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{ name: 'nuget.org', url: 'https://api.nuget.org', enabled: true, configFilePath: '/p/nuget.config' }],
    }]);
    const roslyn = {
      probe: jest.fn().mockResolvedValue({ sdkVersion: '10.0.301', compilerVersion: '5.6.0' }),
    };

    const broker = new WebviewMessageBroker(
      stub, backend, makeSolutionParser(), resolver, logger, undefined, undefined, undefined, roslyn,
    );
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 20));

    const initMsg = posted.find((m) => m.type === 'INIT_STATE') as { roslynCap?: unknown };
    expect(initMsg.roslynCap).toEqual({ sdkVersion: '10.0.301', compilerVersion: '5.6.0' });
    expect(roslyn.probe).toHaveBeenCalled();
  });

  it('rejects a Groups batch target above the SDK compiler for Microsoft.CodeAnalysis', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{ name: 'nuget.org', url: 'https://api.nuget.org', enabled: true, configFilePath: '/p/nuget.config' }],
    }]);
    const roslyn = {
      probe: jest.fn().mockResolvedValue({ sdkVersion: '10.0.301', compilerVersion: '5.6.0' }),
    };

    const broker = new WebviewMessageBroker(
      stub, backend, makeSolutionParser(), resolver, logger, undefined, undefined, undefined, roslyn,
    );
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 20));
    backend.installPackage.mockClear();
    posted.length = 0;

    simulateMessage({
      type: 'UPDATE_PACKAGES_BATCH',
      kind: 'all',
      includePrerelease: false,
      items: [
        { packageId: 'Microsoft.CodeAnalysis.CSharp', fromVersion: '5.6.0', toVersion: '5.9.0', projects: ['/p/App.csproj'] },
        { packageId: 'Newtonsoft.Json', fromVersion: '13.0.1', toVersion: '13.0.3', projects: ['/p/App.csproj'] },
      ],
    });
    await new Promise((r) => setTimeout(r, 40));

    expect(backend.installPackage.mock.calls.map((c: unknown[]) => c[1])).toEqual(['Newtonsoft.Json']);
    expect(posted.some((m) => m.type === 'BATCH_UPDATE_STARTED')).toBe(true);
  });

  it('allows INSTALL_PACKAGE of Microsoft.CodeAnalysis above the compiler cap', async () => {
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{ name: 'nuget.org', url: 'https://api.nuget.org', enabled: true, configFilePath: '/p/nuget.config' }],
    }]);
    const roslyn = {
      probe: jest.fn().mockResolvedValue({ sdkVersion: '10.0.301', compilerVersion: '5.6.0' }),
    };

    const broker = new WebviewMessageBroker(
      stub, backend, makeSolutionParser(), resolver, logger, undefined, undefined, undefined, roslyn,
    );
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 20));
    backend.installPackage.mockClear();

    simulateMessage({
      type: 'INSTALL_PACKAGE',
      projectPath: '/p/App.csproj',
      packageId: 'Microsoft.CodeAnalysis.CSharp',
      version: '5.9.0',
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(backend.installPackage).toHaveBeenCalledWith(
      '/p/App.csproj',
      'Microsoft.CodeAnalysis.CSharp',
      '5.9.0',
      undefined,
    );
  });

  it('FORCE_REFRESH re-probes the SDK compiler after REFRESH_STARTED', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')],
      implicit: [],
    });
    const roslyn = {
      probe: jest.fn().mockResolvedValue({ sdkVersion: '10.0.301', compilerVersion: '5.6.0' }),
    };

    const broker = new WebviewMessageBroker(
      stub, backend, makeSolutionParser(), makeConfigResolver(), logger, undefined, undefined, undefined, roslyn,
    );
    broker.attach();
    simulateMessage({ type: 'FORCE_REFRESH' });
    await new Promise((r) => setTimeout(r, 20));

    expect(posted[0]?.type).toBe('REFRESH_STARTED');
    expect(posted.some((m) => m.type === 'ROSLYN_CAP')).toBe(true);
    expect(roslyn.probe).toHaveBeenCalled();
  });

  it('does not run list --vulnerable for Nexus-only feeds without auditSources', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('SharpCompress', '/p/App.csproj')],
      implicit: [],
    });
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{
        name: 'nexus',
        url: 'https://nexus.example/repository/nuget/index.json',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
    }]);

    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const emptyCache = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-vdb-empty-'));

    const broker = new WebviewMessageBroker(
      stub, backend, makeSolutionParser(), resolver, logger,
      undefined, undefined, undefined, undefined,
      {
        httpCacheDir: () => emptyCache,
      },
    );
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 40));

    expect(backend.listVulnerable).not.toHaveBeenCalled();
    const vuln = posted.find((m) => m.type === 'VULNERABILITIES') as { findings?: unknown[] } | undefined;
    expect(vuln?.findings).toEqual([]);
    const hint = posted.find((m) => m.type === 'VULN_SCAN_HINT') as { show?: boolean } | undefined;
    expect(hint?.show).toBe(true);
    await fs.rm(emptyCache, { recursive: true, force: true });
  });

  it('runs list --vulnerable when Nexus packages have any auditSources', async () => {
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('SharpCompress', '/p/App.csproj')],
      implicit: [],
    });
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{
        name: 'nexus-group',
        url: 'http://localhost:8081/repository/nuget-group/index.json',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
      auditSources: [{
        name: 'nexus-proxy',
        url: 'http://localhost:8081/repository/nuget.org-proxy/index.json',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
    }]);

    const broker = new WebviewMessageBroker(
      stub, backend, makeSolutionParser(), resolver, logger,
    );
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 40));

    expect(backend.listVulnerable).toHaveBeenCalled();
  });

  it('runs list --vulnerable when every HTTP source is nuget.org', async () => {
    const { stub, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [makeInstalledPkg('Newtonsoft.Json', '/p/App.csproj')],
      implicit: [],
    });
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{
        name: 'nuget.org',
        url: 'https://api.nuget.org/v3/index.json',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
    }]);

    const broker = new WebviewMessageBroker(stub, backend, makeSolutionParser(), resolver, logger);
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 40));

    expect(backend.listVulnerable).toHaveBeenCalled();
  });

  it('matches the restore HTTP-cache VDB when CLI --vulnerable is skipped', async () => {
    const { stub, posted, simulateMessage } = makeProvider(PROJECT_SCOPE);
    const backend = makeBackend();
    backend.listAllForProject.mockResolvedValue({
      installed: [{
        id: 'SharpCompress',
        requestedVersion: '0.30.1',
        resolvedVersion: '0.30.1',
        projectPath: '/p/App.csproj',
      }],
      implicit: [],
    });
    const resolver = makeConfigResolver();
    resolver.resolve.mockResolvedValue([{
      filePath: '/p/nuget.config',
      sources: [{
        name: 'nexus',
        url: 'https://nexus.example/repository/nuget/index.json',
        enabled: true,
        configFilePath: '/p/nuget.config',
      }],
    }]);
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-vdb-broker-'));
    await fs.writeFile(path.join(dir, 'vulnerability.base.json'), JSON.stringify({
      sharpcompress: [{
        url: 'https://github.com/advisories/GHSA-6c8g-7p36-r338',
        severity: 1,
        versions: '(, 0.32.0)',
      }],
    }));

    const broker = new WebviewMessageBroker(
      stub, backend, makeSolutionParser(), resolver, logger,
      undefined, undefined, undefined, undefined,
      {
        httpCacheDir: () => dir,
      },
    );
    broker.attach();
    simulateMessage({ type: 'WEBVIEW_READY' });
    await new Promise((r) => setTimeout(r, 50));

    expect(backend.listVulnerable).not.toHaveBeenCalled();
    const vuln = posted.find((m) => m.type === 'VULNERABILITIES') as { findings?: Array<{ packageId: string }> } | undefined;
    expect(vuln?.findings?.some((f) => f.packageId === 'SharpCompress')).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
