import { mergeFamilyVersionFlags } from '../../webview/utils/familyVersionFlags';

describe('mergeFamilyVersionFlags', () => {
  it('names only the members a version is actually flagged for', () => {
    // The measured System.Text.* case: 8.0.0 is flagged for Json and clean for
    // Encodings.Web, which is why the mark cannot stand on its own.
    const merged = mergeFamilyVersionFlags([
      { packageId: 'System.Text.Json', flags: { '8.0.0': { vulnerable: true }, '9.0.0': {} } },
      { packageId: 'System.Text.Encodings.Web', flags: { '8.0.0': {}, '9.0.0': {} } },
    ]);
    expect(merged['8.0.0']).toEqual({ vulnerable: true, packages: ['System.Text.Json'] });
    expect(merged['9.0.0']).toBeUndefined();
  });

  it('lists every member when they are all flagged', () => {
    const merged = mergeFamilyVersionFlags([
      { packageId: 'A', flags: { '1.0.0': { vulnerable: true } } },
      { packageId: 'B', flags: { '1.0.0': { deprecation: 'Legacy' } } },
    ]);
    expect(merged['1.0.0']).toEqual({ vulnerable: true, deprecation: 'Legacy', packages: ['A', 'B'] });
  });

  it('keeps the first deprecation message rather than concatenating several', () => {
    const merged = mergeFamilyVersionFlags([
      { packageId: 'A', flags: { '1.0.0': { deprecation: 'first' } } },
      { packageId: 'B', flags: { '1.0.0': { deprecation: 'second' } } },
    ]);
    expect(merged['1.0.0'].deprecation).toBe('first');
    expect(merged['1.0.0'].packages).toEqual(['A', 'B']);
  });

  it('preserves family order in the package list', () => {
    const merged = mergeFamilyVersionFlags([
      { packageId: 'Z', flags: { '1.0.0': { vulnerable: true } } },
      { packageId: 'A', flags: { '1.0.0': { vulnerable: true } } },
    ]);
    expect(merged['1.0.0'].packages).toEqual(['Z', 'A']);
  });

  it('carries nothing for a version no member flags, so no mark is drawn', () => {
    expect(mergeFamilyVersionFlags([
      { packageId: 'A', flags: { '1.0.0': {} } },
      { packageId: 'B', flags: {} },
    ])).toEqual({});
  });

  it('tolerates a member whose versions have not loaded yet', () => {
    const merged = mergeFamilyVersionFlags([
      { packageId: 'A', flags: { '1.0.0': { vulnerable: true } } },
      { packageId: 'B', flags: undefined },
    ]);
    expect(merged['1.0.0'].packages).toEqual(['A']);
  });
});
