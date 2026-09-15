import { formatPublished, humanAge } from '../../webview/utils/versionFacts';
import { searchedMetadataToPackageMetadata } from '../../searchMetadataMapping';

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

describe('the cache-hit path keeps what the feed said', () => {
  it('carries the publication date, which the panel dates the version from', () => {
    // Measured in a trace: the cache held `published 2024-01-01…` and the panel
    // showed no date, because this conversion — the one place between what the
    // feed said and what the panel reads — did not copy it (#114).
    expect(searchedMetadataToPackageMetadata('Example.Imaging', '3.1.2', {
      description: 'd',
      published: '2024-01-01T03:46:51.9+00:00',
    }).published).toBe('2024-01-01T03:46:51.9+00:00');
  });
});
