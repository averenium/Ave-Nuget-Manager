import type { AvailablePackage } from '../../types';
import {
  answersCurrentQuery, applySearchResults, matchesQuery, normalizeQuery, relevanceScore,
} from '../../webview/utils/search';

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

describe('answersCurrentQuery (#121)', () => {
  it('is true for an answer to the query the box currently holds', () => {
    expect(answersCurrentQuery('Newtonsoft.Json', 'Newtonsoft.Json')).toBe(true);
  });

  it('is false for an answer to a query the box has since moved on from', () => {
    // A slower answer for an earlier query, arriving after the box (and a
    // faster answer to a newer query) has already moved on.
    expect(answersCurrentQuery('Newtonsoft', 'Newtonsoft.Json')).toBe(false);
  });

  it('ignores whitespace padding on either side, the same as the search itself (#120)', () => {
    expect(answersCurrentQuery('Newtonsoft.Json', '  Newtonsoft.Json  ')).toBe(true);
    expect(answersCurrentQuery('  Newtonsoft.Json  ', 'Newtonsoft.Json')).toBe(true);
  });

  it('matches an empty answer against a box that has been cleared', () => {
    expect(answersCurrentQuery('', '')).toBe(true);
    expect(answersCurrentQuery('', '   ')).toBe(true);
  });
});

describe('applySearchResults (#121)', () => {
  const pkg = (id: string): AvailablePackage => ({ id, latestVersion: '1.0.0', sourceName: 'nuget.org' });

  it('leaves the newer results in place when an older query answers later', () => {
    // The box has already moved on to "Newtonsoft.Json" and a faster answer
    // for it was already applied; a slower answer for the earlier
    // "Newtonsoft" now arrives and must not overwrite it.
    const state = {
      searchQuery: 'Newtonsoft.Json',
      isSearching: false,
      available: [pkg('Newtonsoft.Json')],
    };
    const next = applySearchResults(state, { query: 'Newtonsoft', packages: [pkg('Newtonsoft.Debug')] });
    expect(next).toBe(state);
    expect(next.available).toEqual([pkg('Newtonsoft.Json')]);
  });

  it('applies an answer for the query the box currently holds', () => {
    const state = { searchQuery: 'Newtonsoft.Json', isSearching: true, available: [] as AvailablePackage[] };
    const next = applySearchResults(state, { query: 'Newtonsoft.Json', packages: [pkg('Newtonsoft.Json')] });
    expect(next.available).toEqual([pkg('Newtonsoft.Json')]);
    expect(next.isSearching).toBe(false);
  });

  it('does not stop the spinner a still-outstanding newer search is holding open', () => {
    // "Newtonsoft" was asked first, "Newtonsoft.Json" (still in the box, and
    // still outstanding) second. The older answer lands first and must not
    // clear a spinner the newer search still needs.
    const state = { searchQuery: 'Newtonsoft.Json', isSearching: true, available: [] as AvailablePackage[] };
    const next = applySearchResults(state, { query: 'Newtonsoft', packages: [pkg('Newtonsoft.Debug')] });
    expect(next.isSearching).toBe(true);
    expect(next.available).toEqual([]);
  });

  it('does not leave the panel spinning once nothing is outstanding for the discarded query', () => {
    // The box was cleared back below the search threshold — PackagesTab's
    // SET_SEARCH_QUERY has already emptied the box by the time it dispatches
    // its own synthetic empty SEARCH_RESULTS, so that synthetic answer
    // matches and clears isSearching on its own turn, same as any other
    // matching answer would.
    const cleared = applySearchResults(
      { searchQuery: '', isSearching: true, available: [] as AvailablePackage[] },
      { query: '', packages: [] },
    );
    expect(cleared.isSearching).toBe(false);

    // A stale answer for the old query arriving afterwards must find the
    // spinner already off, and must not turn it back on.
    const next = applySearchResults(cleared, { query: 'Newtonsoft.Json', packages: [pkg('Newtonsoft.Json')] });
    expect(next.isSearching).toBe(false);
    expect(next.available).toEqual([]);
  });
});
