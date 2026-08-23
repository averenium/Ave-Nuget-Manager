import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TraceSession, summarizeWebviewMessage } from '../../traceSession';

describe('TraceSession', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-trace-sess-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('appends jsonl only, then findOrphan sees it', async () => {
    const session = await TraceSession.create(root);
    session.record({
      kind: 'cli',
      at: '2026-01-02T03:04:06.000Z',
      command: 'dotnet list A.csproj package',
      args: ['list', 'A.csproj', 'package'],
      cwd: '/repo',
      exitCode: 0,
      timedOut: false,
      durationMs: 12,
      stdout: 'ok',
      stderr: '',
    });
    session.noteTouchedProject('/repo/A.csproj');
    await session.flush();

    const jsonl = await fs.readFile(session.jsonlPath(), 'utf8');
    expect(jsonl).toContain('"kind":"cli"');
    expect(jsonl).toContain('"cwd":"/repo"');
    expect(jsonl).toContain('"stdout":"ok"');
    await expect(fs.access(path.join(session.dir, 'cli.log'))).rejects.toThrow();
    expect(session.getTouchedProjects()).toEqual(['/repo/A.csproj']);

    const orphans = await TraceSession.findOrphanDirs(root);
    expect(orphans).toEqual([session.dir]);
    await session.close();
  });

  it('summarizes webview payloads without long strings', () => {
    const slim = summarizeWebviewMessage({
      type: 'INSTALL_PACKAGE_MULTI',
      projects: ['/abs/Foo.csproj', '/abs/Bar.csproj'],
      packageId: 'Newtonsoft.Json',
      version: '13.0.3',
    });
    expect(slim).toMatchObject({
      type: 'INSTALL_PACKAGE_MULTI',
      packageId: 'Newtonsoft.Json',
      projects: ['Foo.csproj', 'Bar.csproj'],
    });
  });

  it('omits password and apiKey from SET_SOURCE_SECRETS', () => {
    const slim = summarizeWebviewMessage({
      type: 'SET_SOURCE_SECRETS',
      name: 'nexus',
      configFilePath: '/p/nuget.config',
      url: 'https://nexus.example/repository/nuget',
      username: 'ci',
      password: 'hunter2',
      apiKey: 'oy2-short',
    });
    const json = JSON.stringify(slim);
    expect(slim).toMatchObject({
      type: 'SET_SOURCE_SECRETS',
      name: 'nexus',
      username: 'ci',
      password: 'omitted',
      apiKey: 'omitted',
    });
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('oy2-short');
  });

  it('omits NUGET_API_KEY from COPY_TEXT', () => {
    const slim = summarizeWebviewMessage({
      type: 'COPY_TEXT',
      text: "export NUGET_API_KEY='oy2-short'",
    }) as { text?: string };
    expect(slim.text).toBe('export NUGET_API_KEY=<omitted>');
    expect(JSON.stringify(slim)).not.toContain('oy2-short');
  });
});
