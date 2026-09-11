import { resolveVersionSpread } from '../../packageResolvedVersions';

const at = (...versions: string[]) => versions.map((resolvedVersion) => ({ resolvedVersion }));

describe('resolveVersionSpread', () => {
  it('describes the highest version and counts the projects left on the others', () => {
    // The real demo/ case: Newtonsoft.Json 12.0.3 in three projects, 13.0.1 in the tests.
    expect(resolveVersionSpread(at('12.0.3', '12.0.3', '12.0.3', '13.0.1'), [])).toEqual({
      primary: '13.0.1',
      others: [{ version: '12.0.3', projectCount: 3 }],
    });
  });

  it('says nothing extra when every project agrees', () => {
    expect(resolveVersionSpread(at('8.0.0', '8.0.0'), [])).toEqual({ primary: '8.0.0', others: [] });
  });

  it('orders the others newest first, not by how many projects hold them', () => {
    expect(resolveVersionSpread(at('1.0.0', '3.0.0', '2.0.0', '2.0.0'), [])?.others).toEqual([
      { version: '2.0.0', projectCount: 2 },
      { version: '1.0.0', projectCount: 1 },
    ]);
  });

  it('compares numerically — 10.0.0 outranks 9.0.0', () => {
    expect(resolveVersionSpread(at('9.0.0', '10.0.0'), [])?.primary).toBe('10.0.0');
  });

  it('prefers a direct reference over a higher transitive one, and still reports it', () => {
    expect(resolveVersionSpread(at('2.0.0'), at('3.0.0'))).toEqual({
      primary: '2.0.0',
      others: [{ version: '3.0.0', projectCount: 1 }],
    });
  });

  it('falls back to the transitive entries when nothing references the package directly', () => {
    expect(resolveVersionSpread([], at('12.0.3', '13.0.1', '12.0.3'))).toEqual({
      primary: '13.0.1',
      others: [{ version: '12.0.3', projectCount: 2 }],
    });
  });

  it('returns undefined when the package is not restored anywhere', () => {
    expect(resolveVersionSpread([], [])).toBeUndefined();
  });
});

describe('resolveVersionSpread — one project, several target frameworks (#82)', () => {
  const CORE = '/s/Core.csproj';
  const entry = (resolvedVersion: string, framework: string, projectPath = CORE) =>
    ({ resolvedVersion, framework, projectPath });

  it('names the framework instead of counting a project that is not there', () => {
    expect(resolveVersionSpread([
      entry('10.0.0', 'net10.0'),
      entry('9.0.0', 'net9.0'),
    ], [])).toEqual({
      primary: '10.0.0',
      others: [{ version: '9.0.0', projectCount: 1, frameworks: ['net9.0'] }],
      withinOneProject: true,
    });
  });

  it('goes back to counting projects once a second project is involved', () => {
    const spread = resolveVersionSpread([
      entry('10.0.0', 'net10.0'),
      entry('9.0.0', 'net9.0'),
      entry('9.0.0', 'net9.0', '/s/App.csproj'),
    ], []);
    expect(spread?.withinOneProject).toBeUndefined();
    expect(spread?.others).toEqual([{ version: '9.0.0', projectCount: 2 }]);
  });

  it('says nothing new when one project agrees with itself', () => {
    expect(resolveVersionSpread([
      entry('13.0.1', 'net9.0'),
      entry('13.0.1', 'net10.0'),
    ], [])).toEqual({ primary: '13.0.1', others: [], withinOneProject: true });
  });

  it('keeps the old shape when the entries carry no framework at all', () => {
    expect(resolveVersionSpread([
      { resolvedVersion: '12.0.3', projectPath: CORE },
      { resolvedVersion: '13.0.1', projectPath: CORE },
    ], [])).toEqual({ primary: '13.0.1', others: [{ version: '12.0.3', projectCount: 1 }] });
  });
});
