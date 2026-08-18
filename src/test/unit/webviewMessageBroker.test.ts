import { WebviewMessageBroker } from '../../webviewMessageBroker';
import { Logger } from '../../logger';
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
    enrichPackage: jest.fn().mockResolvedValue({ latestVersion: '', sourceName: '', versions: [] }),
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
    await new Promise((r) => setTimeout(r, 10));

    const err = posted.find((m) => m.type === 'OPERATION_ERROR') as any;
    expect(err?.failures).toHaveLength(1);
    expect(err?.failures[0].stderr).toBe('fail B');
    expect(err?.succeededProjects).toContain('/sol/A/A.csproj');
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
});
