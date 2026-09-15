import { matchesQuery, normalizeQuery, relevanceScore } from '../../webview/utils/search';

describe('normalizeQuery', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeQuery('  Microsoft.Extensions.Http ')).toBe('Microsoft.Extensions.Http');
  });

  it('collapses internal whitespace runs to a single space, without deleting the word boundary (#120)', () => {
    expect(normalizeQuery('entity   framework')).toBe('entity framework');
  });

  it('normalises a whitespace-only query to empty', () => {
    expect(normalizeQuery('   ')).toBe('');
  });
});

describe('matchesQuery', () => {
  // Measured (#120): a leading space in the Packages search box emptied every
  // list — `id.toLowerCase().includes(query.toLowerCase())` never matches a
  // package id against a query that starts with a character no id does.
  it('matches despite a leading space', () => {
    expect(matchesQuery('Microsoft.Extensions.Http', ' Microsoft.Extensions.Htt')).toBe(true);
  });

  it('matches despite a trailing space', () => {
    expect(matchesQuery('Microsoft.Extensions.Http', 'Microsoft.Extensions.Htt ')).toBe(true);
  });

  it('matches despite both a leading and trailing space', () => {
    expect(matchesQuery('Microsoft.Extensions.Http', '  Microsoft.Extensions.Htt  ')).toBe(true);
  });

  it('treats a one-letter query padded with a space as too short to filter, not as a miss', () => {
    // The two-character minimum has to count letters, not keystrokes: " M" is
    // one letter once normalised, and a one-letter query shows everything
    // rather than filtering by a literal leading space.
    expect(matchesQuery('AnyPackage', ' M')).toBe(true);
  });

  it('shows everything for a query that is only whitespace', () => {
    expect(matchesQuery('AnyPackage', '   ')).toBe(true);
  });
});

describe('relevanceScore', () => {
  it('scores a padded query the same as its trimmed form', () => {
    expect(relevanceScore('Dapper', '  Dapper  ')).toBe(relevanceScore('Dapper', 'Dapper'));
  });
});
