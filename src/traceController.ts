import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getBlockedPackages } from './config';
import type { NuGetConfigChainResolver } from './nugetConfigChainResolver';
import type { Logger } from './logger';
import type { WorkspaceScope } from './types';
import type { NugetManagerViewProvider } from './nugetManagerViewProvider';
import { collectScopeSnapshotFiles } from './tracePack';
import {
  sanitizeText,
  sanitizeXml,
  defaultTraceZipName,
  type FileAlias,
  type SanitizeContext,
} from './traceSanitize';
import {
  TraceSession,
  summarizeWebviewMessage,
  type ITrace,
  type TraceEvent,
} from './traceSession';
import type { WebviewMessage } from './messages';
import { createZip, type ZipEntry } from './zipStore';

export interface TraceEnvInfo {
  extensionVersion: string;
  appName: string;
  vscodeVersion: string;
  os: string;
  arch: string;
  dotnetVersion: string;
}

function sanitizeCtx(): SanitizeContext {
  return {
    home: os.homedir(),
    workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    hostname: os.hostname(),
  };
}

function configDest(index: number): string {
  return `nuget-config/c${String(index).padStart(2, '0')}.xml`;
}

async function readText(filePath: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    return { ok: true, text: await fs.readFile(filePath, 'utf8') };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function buildSanitizedZip(opts: {
  session: TraceSession;
  scope: WorkspaceScope | undefined;
  configResolver: NuGetConfigChainResolver;
  env: TraceEnvInfo;
  workspaceRoot?: string;
}): Promise<Buffer> {
  await opts.session.flush();

  const startDir =
    opts.scope?.kind === 'solution'
      ? path.dirname(opts.scope.solutionPath)
      : opts.scope?.kind === 'folder'
        ? opts.scope.folderPath
        : opts.scope?.kind === 'project' && opts.scope.projectPath
          ? path.dirname(opts.scope.projectPath)
          : opts.workspaceRoot;

  const chain = startDir ? await opts.configResolver.resolve(startDir) : [];
  const snapshot = await collectScopeSnapshotFiles(
    opts.scope,
    opts.session.getTouchedProjects(),
    opts.workspaceRoot,
  );

  const aliases: FileAlias[] = [
    ...chain.map((file, i) => ({ absPath: file.filePath, dest: configDest(i) })),
    ...snapshot.files.map((file) => ({ absPath: file.absPath, dest: file.destName })),
  ];
  const ctx: SanitizeContext = { ...sanitizeCtx(), aliases };

  const entries: ZipEntry[] = [];
  const add = (name: string, body: string) => {
    entries.push({ name, data: Buffer.from(body, 'utf8') });
  };

  let jsonl = '';
  try {
    jsonl = await fs.readFile(opts.session.jsonlPath(), 'utf8');
  } catch {
    jsonl = '';
  }
  add('trace.jsonl', sanitizeText(jsonl, ctx));

  add('blocked-packages.json', `${JSON.stringify({ blockedPackages: getBlockedPackages() }, null, 2)}\n`);

  add('env.txt', [
    `extensionVersion=${opts.env.extensionVersion}`,
    `appName=${opts.env.appName}`,
    `vscodeVersion=${opts.env.vscodeVersion}`,
    `os=${opts.env.os}`,
    `arch=${opts.env.arch}`,
    `dotnet=${sanitizeText(opts.env.dotnetVersion, ctx)}`,
    '',
  ].join('\n'));

  for (let i = 0; i < chain.length; i++) {
    const file = chain[i];
    const dest = configDest(i);
    const read = await readText(file.filePath);
    if (!read.ok) {
      add(dest, `<!-- unreadable ${sanitizeText(file.filePath, ctx)}: ${sanitizeText(read.error, ctx)} -->\n`);
      continue;
    }
    add(dest, sanitizeXml(read.text, ctx));
  }

  for (const file of snapshot.files) {
    const dest = file.destName;
    const read = await readText(file.absPath);
    if (!read.ok) {
      add(dest, `<!-- unreadable ${sanitizeText(file.absPath, ctx)}: ${sanitizeText(read.error, ctx)} -->\n`);
      continue;
    }
    add(dest, sanitizeXml(read.text, ctx));
  }
  if (snapshot.omitted > 0) {
    add('projects/projects-omitted.txt', `${snapshot.omitted} project(s) omitted (cap 40; included session-touched paths).\n`);
  }

  add('README.txt', [
    'AVE NuGet Manager diagnostic trace',
    '',
    'This archive is sanitised for a GitHub issue (paths, host, emails, credentials).',
    'Project and config files are renamed (projects/p01.csproj, nuget-config/c00.xml).',
    'The same names are used in trace.jsonl. c00 is the nearest nuget.config, last is global.',
    'Do not commit it. Do not share the unsanitised session folder.',
    `truncated=${opts.session.truncated ? 'yes' : 'no'}`,
    '',
    'Attach this zip to the issue you are filing.',
    '',
  ].join('\n'));

  return createZip(entries);
}

export class TraceController implements ITrace {
  private session: TraceSession | null = null;
  private packing = false;

  constructor(
    private readonly storageRoot: string,
    private readonly logger: Logger,
    private readonly provider: NugetManagerViewProvider,
    private readonly configResolver: NuGetConfigChainResolver,
    private readonly getScope: () => WorkspaceScope | undefined,
    private readonly getDotnetVersion: () => Promise<string>,
    private readonly env: Omit<TraceEnvInfo, 'dotnetVersion'>,
  ) {}

  isRecording(): boolean {
    return this.session?.isRecording() === true;
  }

  record(event: TraceEvent): void {
    this.session?.record(event);
  }

  noteTouchedProject(projectPath: string): void {
    this.session?.noteTouchedProject(projectPath);
  }

  recordWebview(msg: WebviewMessage): void {
    if (!this.isRecording()) return;
    if (msg.type === 'START_TRACE' || msg.type === 'STOP_TRACE' || msg.type === 'GET_LOG_ENTRIES') return;
    this.record({
      kind: 'webview',
      at: new Date().toISOString(),
      type: msg.type,
      payload: summarizeWebviewMessage(msg),
    });
  }

  recordBroker(step: string, detail?: unknown): void {
    if (!this.isRecording()) return;
    this.record({ kind: 'broker', at: new Date().toISOString(), step, detail });
  }

  recordCli(entry: Omit<Extract<TraceEvent, { kind: 'cli' }>, 'kind'>): void {
    if (!this.isRecording()) return;
    this.record({ kind: 'cli', ...entry });
    for (const arg of entry.args) {
      if (/\.(csproj|fsproj|sln|slnx)$/i.test(arg)) this.noteTouchedProject(arg);
    }
  }

  private _postState(): void {
    this.provider.postMessage({ type: 'TRACE_STATE', recording: this.isRecording() });
  }

  private _workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  async startFromUi(): Promise<void> {
    if (this.packing) return;
    if (this.isRecording()) {
      const go = await vscode.window.showWarningMessage(
        'A trace is already recording. Stop & pack it first?',
        { modal: true },
        'Stop & pack',
      );
      if (go === 'Stop & pack') await this.stopAndPack();
      return;
    }

    const go = await vscode.window.showWarningMessage(
      'Start a diagnostic trace? Recording includes CLI output, sanitised nuget.config, and sanitised project files from the current scope. Do not commit the zip.',
      { modal: true },
      'Start',
    );
    if (go !== 'Start') return;

    this.session = await TraceSession.create(this.storageRoot);
    const dotnet = await this.getDotnetVersion().catch((err) => String(err));
    this.record({
      kind: 'broker',
      at: new Date().toISOString(),
      step: 'header',
      detail: { ...this.env, dotnetVersion: dotnet, os: `${os.platform()} ${os.release()}` },
    });
    this._postState();
  }

  async stopAndPack(): Promise<void> {
    if (this.packing) return;
    const session = this.session;
    if (!session) {
      await vscode.window.showInformationMessage('No diagnostic trace is recording.');
      return;
    }
    this.packing = true;
    try {
      await session.close();
      this.session = null;
      this._postState();
      const zip = await this._pack(session);
      const saved = await this._saveZip(zip, session.startedAt);
      await fs.rm(session.dir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      if (!saved) {
        await vscode.window.showInformationMessage('Trace discarded (save cancelled).');
        return;
      }
    } catch (err) {
      await vscode.window.showErrorMessage(
        `AVE NuGet Manager: could not pack the trace (${err instanceof Error ? err.message : String(err)}).`,
      );
    } finally {
      this.packing = false;
      this._postState();
    }
  }

  async recoverOrphan(): Promise<void> {
    const orphans = await TraceSession.findOrphanDirs(this.storageRoot);
    if (orphans.length === 0) return;
    const dir = orphans[0];
    const choice = await vscode.window.showWarningMessage(
      'An unfinished diagnostic trace was found. Pack a sanitised zip for a GitHub issue, or discard it.',
      { modal: true },
      'Stop & pack',
      'Discard',
    );
    if (choice === 'Discard') {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      for (const extra of orphans.slice(1)) {
        await fs.rm(extra, { recursive: true, force: true }).catch(() => { /* ignore */ });
      }
      return;
    }
    if (choice !== 'Stop & pack') return;
    try {
      const session = await TraceSession.reopen(dir);
      await session.close();
      const zip = await this._pack(session);
      await this._saveZip(zip, session.startedAt);
    } catch (err) {
      await vscode.window.showErrorMessage(
        `AVE NuGet Manager: could not pack the leftover trace (${err instanceof Error ? err.message : String(err)}).`,
      );
    } finally {
      for (const extra of orphans) {
        await fs.rm(extra, { recursive: true, force: true }).catch(() => { /* ignore */ });
      }
    }
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.commands.registerCommand('averenium.nugetManager.startTrace', () => this.startFromUi()),
      vscode.commands.registerCommand('averenium.nugetManager.stopTrace', () => this.stopAndPack()),
    );
  }

  private async _pack(session: TraceSession): Promise<Buffer> {
    const dotnet = await this.getDotnetVersion().catch((err) => String(err));
    return buildSanitizedZip({
      session,
      scope: this.getScope(),
      configResolver: this.configResolver,
      workspaceRoot: this._workspaceRoot(),
      env: {
        ...this.env,
        os: `${os.platform()} ${os.release()}`,
        arch: os.arch(),
        dotnetVersion: dotnet,
      },
    });
  }

  private async _saveZip(zip: Buffer, startedAt: Date): Promise<boolean> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultTraceZipName(startedAt))),
      filters: { Zip: ['zip'] },
      saveLabel: 'Save sanitised trace',
      title: 'Save diagnostic zip for a GitHub issue',
    });
    if (!uri) return false;
    await fs.writeFile(uri.fsPath, zip);
    const reveal = await vscode.window.showInformationMessage(
      'Attach this zip to the GitHub issue. Do not commit it.',
      'Show in folder',
    );
    if (reveal === 'Show in folder') {
      await vscode.commands.executeCommand('revealFileInOS', uri);
    }
    return true;
  }
}
