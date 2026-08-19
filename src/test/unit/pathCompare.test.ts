import { normalizeFsPath, pathsEqual, packageIdsEqual } from '../../pathCompare';

describe('pathCompare', () => {
  it('treats backslash and slash paths as equal', () => {
    expect(pathsEqual('D:\\src\\App.csproj', 'D:/src/App.csproj')).toBe(true);
  });

  it('treats drive-letter case as equal', () => {
    expect(pathsEqual('D:\\src\\App.csproj', 'd:\\src\\App.csproj')).toBe(true);
  });

  it('matches a relative path against an absolute one', () => {
    expect(pathsEqual('d:/repo/src/App/App.csproj', 'src/App/App.csproj')).toBe(true);
  });

  it('does not match unrelated projects', () => {
    expect(pathsEqual('d:/repo/A/A.csproj', 'd:/repo/B/B.csproj')).toBe(false);
  });

  it('normalizes trailing slashes', () => {
    expect(normalizeFsPath('D:\\src\\')).toBe('d:/src');
  });

  it('compares package ids case-insensitively', () => {
    expect(packageIdsEqual('Newtonsoft.Json', 'newtonsoft.json')).toBe(true);
  });
});
