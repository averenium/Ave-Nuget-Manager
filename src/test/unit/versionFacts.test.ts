import {
  formatPublished, humanAge, ordinal, versionFactsParts, versionPositionLabel,
} from '../../webview/utils/versionFacts';

const NOW = new Date('2025-08-18T12:00:00Z');

describe('humanAge', () => {
  it('counts days while days are still the honest unit', () => {
    expect(humanAge('2025-08-12T00:00:00Z', NOW)).toBe('6 days');
    expect(humanAge('2025-08-17T00:00:00Z', NOW)).toBe('1 day');
    expect(humanAge('2025-08-18T06:00:00Z', NOW)).toBe('today');
  });

  it('coarsens to months and then years, which is what the question is about', () => {
    // A reader deciding whether a package is maintained wants "4 years", not a
    // day count they have to divide themselves.
    expect(humanAge('2025-05-01T00:00:00Z', NOW)).toBe('4 months');
    expect(humanAge('2021-11-03T00:00:00Z', NOW)).toBe('3 years');
    // Months stay the unit up to a year and a half: "15 months" still reads as
    // a length of time, where "1 year" would round away most of the gap.
    expect(humanAge('2024-06-01T00:00:00Z', NOW)).toBe('15 months');
    expect(humanAge('2023-06-01T00:00:00Z', NOW)).toBe('2 years');
  });

  it('says nothing about a date it cannot read or one in the future', () => {
    expect(humanAge(undefined, NOW)).toBeUndefined();
    expect(humanAge('not a date', NOW)).toBeUndefined();
    expect(humanAge('2026-01-01T00:00:00Z', NOW)).toBeUndefined();
  });
});

describe('ordinal', () => {
  it('handles the teens, which are the ones that break the rule', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal))
      .toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd']);
  });
});

describe('formatPublished', () => {
  it('renders a date a reader can take in at a glance', () => {
    expect(formatPublished('2025-08-12T09:31:00Z')).toBe('12 Aug 2025');
  });

  it('says nothing rather than something wrong', () => {
    expect(formatPublished(undefined)).toBeUndefined();
    expect(formatPublished('')).toBeUndefined();
    expect(formatPublished('whenever')).toBeUndefined();
  });
});

describe('versionPositionLabel', () => {
  const ALL = ['4.3.2', '4.2.0', '4.1.0', '4.0.0'];

  it('says the position as briefly as it can, and spells it out on hover', () => {
    // Rendered to the side of the facts line rather than in it: it is a count
    // among dates and names, and in the flow it pushed the text around.
    expect(versionPositionLabel('4.1.0', ALL))
      .toEqual({ short: '3rd of 4', full: '3rd of 4 versions the feed lists' });
    expect(versionPositionLabel('4.3.2', ALL))
      .toEqual({ short: 'newest of 4', full: 'newest of 4 versions the feed lists' });
  });

  it('says nothing about a version the feed does not list, or an empty list', () => {
    expect(versionPositionLabel('3.0.0', ALL)).toBeUndefined();
    expect(versionPositionLabel('4.1.0', [])).toBeUndefined();
  });
});

describe('versionFactsParts', () => {
  const ALL = ['4.3.2', '4.2.0', '4.1.0', '4.0.0'];
  const DATES = {
    '4.3.2': '2025-08-12T00:00:00Z',
    '4.1.0': '2025-02-03T00:00:00Z',
  };

  it('says what has happened since the version on screen', () => {
    expect(versionFactsParts({
      version: '4.1.0',
      published: DATES['4.1.0'],
      allVersions: ALL,
      publishedByVersion: DATES,
      sourceName: 'Example Feed',
      now: NOW,
    })).toEqual([
      'published 3 Feb 2025',
      'newest 4.3.2, 6 days ago',
      'Example Feed',
    ]);
  });

  it('turns the question around on the newest version, where "newest X" says nothing', () => {
    expect(versionFactsParts({
      version: '4.3.2',
      published: DATES['4.3.2'],
      allVersions: ALL,
      publishedByVersion: DATES,
      sourceName: 'Example Feed',
      now: NOW,
    })).toEqual([
      'published 12 Aug 2025',
      'nothing published in 6 days',
      'Example Feed',
    ]);
  });

  it('drops only the parts the feed could not fill', () => {
    // A feed that states no dates can still name the newest version.
    expect(versionFactsParts({
      version: '4.1.0',
      allVersions: ALL,
      publishedByVersion: {},
      now: NOW,
    })).toEqual(['newest 4.3.2']);
  });

  it('says nothing at all when the feed answered nothing', () => {
    expect(versionFactsParts({
      version: '4.1.0', allVersions: [], publishedByVersion: {}, now: NOW,
    })).toEqual([]);
  });

  it('does not count a version the list does not contain', () => {
    // The panel can be showing an installed version the feed no longer lists.
    expect(versionFactsParts({
      version: '3.0.0',
      published: '2020-01-01T00:00:00Z',
      allVersions: ALL,
      publishedByVersion: DATES,
      now: NOW,
    })).toEqual(['published 1 Jan 2020', 'newest 4.3.2, 6 days ago']);
  });
});
