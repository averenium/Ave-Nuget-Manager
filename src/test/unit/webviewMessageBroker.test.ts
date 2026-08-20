import { WebviewMessageBroker } from '../../webviewMessageBroker';
import { Logger } from '../../logger';
import * as projectFiles from '../../projectFileSnapshot';
import * as config from '../../config';
import type { INuGetBackend } from '../../backend/INuGetBackend';
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

    expect(backend.listVulnerable).toHaveBeenCalledWith('/p/App.csproj');
    const vuln = posted.find((m) => m.type === 'VULNERABILITIES') as { findings?: unknown[] } | undefined;
    expect(vuln?.findings).toHaveLength(1);
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
      { path: '/sol/A/A.csproj', content: '<Project Version="1.0.0" />' },
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
      enrichConcurrency: 4,
      cacheTtlMs: 1000,
      includePrerelease: true,
      onFailedUpdate: 'keep',
      vulnerabilityScript: '',
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
      enrichConcurrency: 4,
      cacheTtlMs: 1000,
      includePrerelease: true,
      onFailedUpdate: 'keep',
      vulnerabilityScript: '',
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
});
