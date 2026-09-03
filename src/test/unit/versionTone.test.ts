import { versionTone, versionLabel } from '../../webview/utils/versionTone';

describe('versionTone', () => {
  it('is "up" when the target is newer than the installed version', () => {
    expect(versionTone('1.0.0', '2.0.0')).toBe('up');
  });

  it('is "down" when the target is older than the installed version', () => {
    expect(versionTone('2.0.0', '1.0.0')).toBe('down');
  });

  it('is "same" when both versions match', () => {
    expect(versionTone('1.0.0', '1.0.0')).toBe('same');
  });

  it('is "add" when there is no installed version yet', () => {
    expect(versionTone(undefined, '1.0.0')).toBe('add');
  });

  it('is undefined when there is no target version', () => {
    expect(versionTone('1.0.0', undefined)).toBeUndefined();
    expect(versionTone(undefined, undefined)).toBeUndefined();
  });
});

describe('versionLabel', () => {
  it('shows an arrow between differing versions', () => {
    expect(versionLabel('1.0.0', '2.0.0')).toBe('1.0.0 → 2.0.0');
  });

  it('collapses to one version when they match', () => {
    expect(versionLabel('1.0.0', '1.0.0')).toBe('1.0.0');
  });

  it('prefixes a plus for a brand-new install', () => {
    expect(versionLabel(undefined, '1.0.0')).toBe('+ 1.0.0');
  });

  it('is undefined with nothing to show', () => {
    expect(versionLabel(undefined, undefined)).toBeUndefined();
  });
});
