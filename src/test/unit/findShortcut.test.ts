import { isFindShortcut } from '../../webview/utils/findShortcut';

const press = (over: Partial<Parameters<typeof isFindShortcut>[0]>) => isFindShortcut({
  ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over,
});

describe('isFindShortcut', () => {
  it('matches Ctrl+F and Cmd+F', () => {
    expect(press({ code: 'KeyF', ctrlKey: true })).toBe(true);
    expect(press({ code: 'KeyF', metaKey: true })).toBe(true);
  });

  it('matches on a non-Latin layout, where the same key reports a different character', () => {
    // Ctrl+F on the Ukrainian layout: `code` is still KeyF, `key` is 'а'.
    expect(press({ code: 'KeyF', key: 'а', ctrlKey: true })).toBe(true);
  });

  it('falls back to the character when no physical key is reported', () => {
    expect(press({ key: 'f', ctrlKey: true })).toBe(true);
    expect(press({ key: 'F', ctrlKey: true })).toBe(true);
    expect(press({ key: 'g', ctrlKey: true })).toBe(false);
  });

  it('ignores the key without a modifier, so typing "f" into the box still types', () => {
    expect(press({ code: 'KeyF' })).toBe(false);
  });

  it('leaves Ctrl+Shift+F and Ctrl+Alt+F alone', () => {
    expect(press({ code: 'KeyF', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(press({ code: 'KeyF', ctrlKey: true, altKey: true })).toBe(false);
  });

  it('ignores every other key', () => {
    expect(press({ code: 'KeyG', ctrlKey: true })).toBe(false);
    expect(press({ code: 'Enter', ctrlKey: true })).toBe(false);
  });
});
