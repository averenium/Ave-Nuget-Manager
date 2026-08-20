import * as vscode from 'vscode';
import {
  EDITOR_OPEN_CONTEXT,
  NugetManagerViewProvider,
} from '../../nugetManagerViewProvider';

function fakeWebview() {
  return {
    html: '',
    options: {},
    cspSource: 'https://example',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: jest.fn(() => Promise.resolve(true)),
    onDidReceiveMessage: jest.fn(() => ({ dispose: jest.fn() })),
  };
}

function fakeView(webview = fakeWebview()) {
  let onDispose: () => void = () => undefined;
  return {
    webview,
    visible: true,
    show: jest.fn(),
    onDidDispose: (cb: () => void) => {
      onDispose = cb;
      return { dispose: jest.fn() };
    },
    fireDispose: () => onDispose(),
  };
}

describe('NugetManagerViewProvider', () => {
  let provider: NugetManagerViewProvider;

  beforeEach(() => {
    (vscode.window.createWebviewPanel as jest.Mock).mockClear();
    (vscode.commands.executeCommand as jest.Mock).mockClear();
    provider = new NugetManagerViewProvider(vscode.Uri.file('/ext'));
  });

  it('rebuilds HTML after the view is disposed (move / re-resolve)', () => {
    const first = fakeView();
    provider.resolveWebviewView(first as unknown as vscode.WebviewView, {} as never, {} as never);
    expect(first.webview.html).toContain('id="root"');

    first.fireDispose();

    const second = fakeView();
    provider.resolveWebviewView(second as unknown as vscode.WebviewView, {} as never, {} as never);
    expect(second.webview.html).toContain('id="root"');
  });

  it('notifies onSurface once when the panel view resolves', () => {
    const onSurface = jest.fn();
    provider.setOnSurface(onSurface);
    provider.resolveWebviewView(
      fakeView() as unknown as vscode.WebviewView,
      {} as never,
      {} as never,
    );
    expect(onSurface).toHaveBeenCalledTimes(1);
    provider.resolveWebviewView(
      fakeView() as unknown as vscode.WebviewView,
      {} as never,
      {} as never,
    );
    expect(onSurface).toHaveBeenCalledTimes(1);
  });

  it('opens an editor panel and moves it to a new window', async () => {
    const panelWebview = fakeWebview();
    const panel = {
      webview: panelWebview,
      reveal: jest.fn(),
      dispose: jest.fn(),
      onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
      visible: true,
      viewColumn: vscode.ViewColumn.One,
      iconPath: undefined as vscode.Uri | undefined,
    };
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

    await provider.openInEditor(true);

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      NugetManagerViewProvider.editorViewType,
      'NuGet',
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true }),
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'setContext',
      EDITOR_OPEN_CONTEXT,
      true,
    );
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
      'workbench.action.moveEditorToNewWindow',
    );
    expect(panelWebview.html).toContain('id="root"');
  });

  it('posts to the editor webview after Open in Editor', async () => {
    const panelWebview = fakeWebview();
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue({
      webview: panelWebview,
      reveal: jest.fn(),
      dispose: jest.fn(),
      onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
      visible: true,
      viewColumn: vscode.ViewColumn.One,
    });

    await provider.openInEditor(false);
    provider.markClientReady();
    provider.postMessage({ type: 'LOG_ENTRIES', entries: [] });

    expect(panelWebview.postMessage).toHaveBeenCalledWith({
      type: 'LOG_ENTRIES',
      entries: [],
    });
  });
});
