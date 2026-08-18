/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Minimal VSCode API mock for Jest unit tests.
 * Only the surface area used by the extension host modules is mocked here.
 * Additional mocks should be added as new modules are implemented.
 */

// ─── OutputChannel ────────────────────────────────────────────────────────────

export class OutputChannel {
  readonly name: string;
  readonly lines: string[] = [];

  constructor(name: string) {
    this.name = name;
  }

  appendLine(value: string): void {
    this.lines.push(value);
  }

  append(value: string): void {
    this.lines.push(value);
  }

  show(_preserveFocus?: boolean): void { /* no-op */ }
  hide(): void { /* no-op */ }
  clear(): void { this.lines.length = 0; }
  dispose(): void { /* no-op */ }
  replace(_value: string): void { /* no-op */ }
}

// ─── Disposable ───────────────────────────────────────────────────────────────

export class Disposable {
  private readonly _callOnDispose: () => void;

  constructor(callOnDispose: () => void) {
    this._callOnDispose = callOnDispose;
  }

  dispose(): void {
    this._callOnDispose();
  }

  static from(...disposables: Array<{ dispose(): void }>): Disposable {
    return new Disposable(() => {
      for (const d of disposables) {
        d.dispose();
      }
    });
  }
}

// ─── Uri ──────────────────────────────────────────────────────────────────────

export class Uri {
  readonly scheme: string;
  readonly fsPath: string;
  readonly path: string;

  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath;
  }

  static file(path: string): Uri {
    return new Uri('file', path);
  }

  static parse(value: string): Uri {
    const match = value.match(/^([a-z]+):\/\/(.*)$/);
    if (match) {
      return new Uri(match[1], match[2]);
    }
    return new Uri('file', value);
  }

  with(change: { scheme?: string; path?: string; fsPath?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.fsPath ?? change.path ?? this.fsPath,
    );
  }

  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }

  toJSON(): object {
    return { scheme: this.scheme, fsPath: this.fsPath };
  }
}

// ─── window ───────────────────────────────────────────────────────────────────

const _outputChannels: OutputChannel[] = [];

export const window = {
  createOutputChannel: jest.fn((name: string): OutputChannel => {
    const ch = new OutputChannel(name);
    _outputChannels.push(ch);
    return ch;
  }),
  showErrorMessage: jest.fn((_message: string, ..._items: string[]): Promise<string | undefined> =>
    Promise.resolve(undefined)
  ),
  showWarningMessage: jest.fn((_message: string, ..._items: string[]): Promise<string | undefined> =>
    Promise.resolve(undefined)
  ),
  showInformationMessage: jest.fn((_message: string, ..._items: string[]): Promise<string | undefined> =>
    Promise.resolve(undefined)
  ),
  showQuickPick: jest.fn((_items: any[], _options?: any): Promise<any> =>
    Promise.resolve(undefined)
  ),
  registerWebviewViewProvider: jest.fn((_viewId: string, _provider: any, _options?: any): Disposable =>
    new Disposable(() => { /* no-op */ })
  ),
  _outputChannels,
};

// ─── workspace ────────────────────────────────────────────────────────────────

export const workspace = {
  openTextDocument: jest.fn((_pathOrUri: string | Uri): Promise<any> =>
    Promise.resolve({})
  ),
  showTextDocument: jest.fn((_doc: any): Promise<any> =>
    Promise.resolve({})
  ),
  workspaceFolders: [] as any[],
  getWorkspaceFolder: jest.fn((_uri: Uri): any => undefined),
  getConfiguration: jest.fn((_section?: string) => ({
    get: jest.fn((key: string, defaultValue?: unknown) => defaultValue),
    update: jest.fn(() => Promise.resolve()),
    has: jest.fn(() => false),
    inspect: jest.fn(() => undefined),
  })),
  fs: {
    readFile: jest.fn((_uri: Uri): Promise<Uint8Array> => Promise.resolve(new Uint8Array())),
    writeFile: jest.fn((_uri: Uri, _content: Uint8Array): Promise<void> => Promise.resolve()),
    stat: jest.fn((_uri: Uri): Promise<any> => Promise.resolve({})),
    readDirectory: jest.fn((_uri: Uri): Promise<any[]> => Promise.resolve([])),
  },
};

// ─── commands ─────────────────────────────────────────────────────────────────

export const commands = {
  registerCommand: jest.fn((_command: string, _callback: (...args: any[]) => any): Disposable =>
    new Disposable(() => { /* no-op */ })
  ),
  executeCommand: jest.fn((_command: string, ..._args: any[]): Promise<any> =>
    Promise.resolve(undefined)
  ),
};

// ─── ExtensionContext ─────────────────────────────────────────────────────────

export class ExtensionContext {
  subscriptions: Disposable[] = [];
  extensionUri: Uri = Uri.file('/mock/extension');
  extensionPath: string = '/mock/extension';
  globalState: any = { get: jest.fn(), update: jest.fn(), keys: jest.fn(() => []) };
  workspaceState: any = { get: jest.fn(), update: jest.fn(), keys: jest.fn(() => []) };
  storagePath: string | undefined = undefined;
  globalStoragePath: string = '/mock/globalStorage';
  logPath: string = '/mock/logs';
  asAbsolutePath = jest.fn((p: string): string => `/mock/extension/${p}`);
}

// ─── ViewColumn ───────────────────────────────────────────────────────────────

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
}

// ─── FileType ─────────────────────────────────────────────────────────────────

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

// ─── WebviewView (stub for provider tests) ───────────────────────────────────

export interface WebviewView {
  webview: {
    html: string;
    options: { enableScripts: boolean; localResourceRoots: Uri[] };
    cspSource: string;
    asWebviewUri(uri: Uri): Uri;
    onDidReceiveMessage: any;
    postMessage(message: any): Thenable<boolean>;
  };
  onDidDispose: any;
  visible: boolean;
  show(preserveFocus?: boolean): void;
}
