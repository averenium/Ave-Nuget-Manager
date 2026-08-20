import {
  isPackageBlocked,
  normalizeBlockedIds,
  withoutBlocked,
} from '../../blockedPackages';

describe('normalizeBlockedIds', () => {
  it('trims, drops blanks, and dedupes case-insensitively', () => {
    expect(normalizeBlockedIds([
      ' Npgsql.EntityFrameworkCore.PostgreSQL ',
      'npgsql.entityframeworkcore.postgresql',
      '',
      1,
      'Newtonsoft.Json',
    ])).toEqual([
      'Npgsql.EntityFrameworkCore.PostgreSQL',
      'Newtonsoft.Json',
    ]);
  });

  it('returns empty for non-arrays', () => {
    expect(normalizeBlockedIds(undefined)).toEqual([]);
    expect(normalizeBlockedIds('Pkg')).toEqual([]);
  });
});

describe('isPackageBlocked / withoutBlocked', () => {
  const blocked = ['Npgsql.EntityFrameworkCore.PostgreSQL'];

  it('matches ids case-insensitively', () => {
    expect(isPackageBlocked('npgsql.entityframeworkcore.postgresql', blocked)).toBe(true);
    expect(isPackageBlocked('Newtonsoft.Json', blocked)).toBe(false);
  });

  it('drops blocked items from a batch payload', () => {
    expect(withoutBlocked([
      { packageId: 'A', toVersion: '2' },
      { packageId: 'npgsql.entityframeworkcore.postgresql', toVersion: '10' },
    ], blocked)).toEqual([{ packageId: 'A', toVersion: '2' }]);
  });
});
