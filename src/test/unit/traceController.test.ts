import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TraceController } from '../../traceController';
import { traceButtonState } from '../../webview/utils/traceButton';

/**
 * A notification that carries an action button never times out, and collapsing
 * it into the bell does not settle its promise — so a controller that awaits
 * one is held for the rest of the session by whoever carried on working. The
 * trace button then did nothing, silently, while the Log tab showed it enabled
 * (#131).
 */
const NEVER_DISMISSED = new Promise<string | undefined>(() => { /* a person has not looked */ });

interface Harness {
  controller: TraceController;
  posted: Array<{ type: string; recording?: boolean; packing?: boolean }>;
  storageRoot: string;
  zipPath: string;
}

const window = vscode.window as unknown as Record<string, jest.Mock>;

async function makeHarness(opts: { resolve?: () => Promise<never[]> } = {}): Promise<Harness> {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-controller-'));
  const zipPath = path.join(storageRoot, 'saved.zip');
  const posted: Harness['posted'] = [];
  const controller = new TraceController(
    storageRoot,
    {} as never,
    { postMessage: (m: Harness['posted'][number]) => { posted.push(m); } } as never,
    { resolve: opts.resolve ?? (async () => []) } as never,
    // A folder scope is what makes the pack ask the config resolver at all.
    () => ({ kind: 'folder', folderPath: storageRoot, projects: [] }) as never,
    async () => '10.0.0',
    { extensionVersion: '0.8.0', appName: 'Code', vscodeVersion: '1.137.0', os: 'win32', arch: 'x64' },
  );
  window.showWarningMessage.mockResolvedValue('Start');
  window.showSaveDialog.mockResolvedValue(vscode.Uri.file(zipPath));
  window.showInformationMessage.mockResolvedValue(undefined);
  window.showErrorMessage.mockResolvedValue(undefined);
  return { controller, posted, storageRoot, zipPath };
}

const sessionDirs = async (root: string) =>
  (await fs.readdir(root)).filter((name) => name.startsWith('trace-'));

describe('TraceController stop and pack (#131)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('finishes, and lets the next trace start, when the "Attach this zip" notification is never dismissed', async () => {
    const h = await makeHarness();
    await h.controller.startFromUi();
    window.showInformationMessage.mockReturnValue(NEVER_DISMISSED);

    await h.controller.stopAndPack();

    expect(h.controller.isPacking()).toBe(false);
    await fs.access(h.zipPath);
    await h.controller.startFromUi();
    expect(h.controller.isRecording()).toBe(true);
  });

  it('is no longer packing once the zip is written and the session directory is gone', async () => {
    const h = await makeHarness();
    await h.controller.startFromUi();
    window.showInformationMessage.mockReturnValue(NEVER_DISMISSED);

    await h.controller.stopAndPack();

    expect(h.controller.isPacking()).toBe(false);
    expect(await sessionDirs(h.storageRoot)).toEqual([]);
    expect(h.posted[h.posted.length - 1]).toMatchObject({ type: 'TRACE_STATE', recording: false, packing: false });
  });

  it('says it is packing while the zip is being made, instead of looking idle', async () => {
    const h = await makeHarness();
    await h.controller.startFromUi();
    let release: (uri: vscode.Uri) => void = () => { /* replaced below */ };
    window.showSaveDialog.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const stopping = h.controller.stopAndPack();
    await waitFor(() => window.showSaveDialog.mock.calls.length > 0);

    expect(h.controller.isPacking()).toBe(true);
    expect(h.posted).toContainEqual({ type: 'TRACE_STATE', recording: false, packing: true });

    release(vscode.Uri.file(h.zipPath));
    await stopping;
    expect(h.posted[h.posted.length - 1]).toMatchObject({ recording: false, packing: false });
  });

  it('still reveals the zip when the notification is answered later', async () => {
    const h = await makeHarness();
    await h.controller.startFromUi();
    let answer: (choice: string) => void = () => { /* replaced below */ };
    window.showInformationMessage.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const execute = jest.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    await h.controller.stopAndPack();
    expect(execute).not.toHaveBeenCalledWith('revealFileInOS', expect.anything());

    answer('Show in folder');
    await waitFor(() => execute.mock.calls.some(([command]) => command === 'revealFileInOS'));
  });

  it('leaves no session directory behind when packing throws, so nothing is asked about next session', async () => {
    const h = await makeHarness({ resolve: async () => { throw new Error('config chain unreadable'); } });
    await h.controller.startFromUi();
    window.showErrorMessage.mockReturnValue(NEVER_DISMISSED);

    await h.controller.stopAndPack();

    expect(window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('config chain unreadable'));
    expect(await sessionDirs(h.storageRoot)).toEqual([]);
    expect(h.controller.isPacking()).toBe(false);
  });

  it('says the trace was discarded when the chosen location cannot be written, rather than hinting at a retry', async () => {
    const h = await makeHarness();
    await h.controller.startFromUi();
    window.showSaveDialog.mockResolvedValue(
      vscode.Uri.file(path.join(h.storageRoot, 'no-such-folder', 'saved.zip')),
    );

    await h.controller.stopAndPack();

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringMatching(/could not save the trace.*discarded/),
    );
    expect(await sessionDirs(h.storageRoot)).toEqual([]);
  });

  it('is not held by the "discarded" notice when the save dialog is cancelled', async () => {
    const h = await makeHarness();
    await h.controller.startFromUi();
    window.showSaveDialog.mockResolvedValue(undefined);
    window.showInformationMessage.mockReturnValue(NEVER_DISMISSED);

    await h.controller.stopAndPack();

    expect(h.controller.isPacking()).toBe(false);
    expect(await sessionDirs(h.storageRoot)).toEqual([]);
  });
});

describe('traceButtonState (#131)', () => {
  it('offers Trace when idle and Stop when recording, both pressable', () => {
    expect(traceButtonState(false, false)).toMatchObject({ mode: 'start', label: 'Trace', disabled: false });
    expect(traceButtonState(true, false)).toMatchObject({ mode: 'stop', label: 'Stop', disabled: false });
  });

  it('renders a disabled Saving… while the zip is being packed, never an enabled button that does nothing', () => {
    expect(traceButtonState(false, true)).toMatchObject({ mode: 'saving', label: 'Saving…', disabled: true });
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
