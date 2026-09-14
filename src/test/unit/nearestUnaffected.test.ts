import { nearestUnaffectedVersion } from '../../webview/utils/nearestUnaffected';
import type { VersionFlag } from '../../types';

const ALL = ['4.3.2', '4.2.0', '4.1.3', '4.1.0', '4.0.0'];

function flagged(...versions: string[]): Record<string, VersionFlag> {
  return Object.fromEntries(versions.map((v) => [
    v, { vulnerable: true, advisories: [{ url: `https://advisories.example/${v}`, severity: 'high' as const }] },
  ]));
}

describe('nearestUnaffectedVersion', () => {
  it('offers the smallest move that clears the advisory, not the newest version', () => {
    // Jumping to the head of the list would carry everything else that changed
    // between here and there; the reader asked to stop being affected.
    expect(nearestUnaffectedVersion(ALL, flagged('4.1.0', '4.0.0'), '4.1.0')).toBe('4.1.3');
  });

  it('steps over later versions the advisory also covers', () => {
    expect(nearestUnaffectedVersion(ALL, flagged('4.1.0', '4.1.3', '4.2.0'), '4.1.0')).toBe('4.3.2');
  });

  it('says nothing when every later version is flagged too', () => {
    // A real answer: offering a move that fixes nothing is worse than silence.
    expect(nearestUnaffectedVersion(ALL, flagged(...ALL), '4.1.0')).toBeUndefined();
  });

  it('says nothing about the newest version, which has nothing above it', () => {
    expect(nearestUnaffectedVersion(ALL, flagged('4.3.2'), '4.3.2')).toBeUndefined();
  });

  it('says nothing about a version the feed does not list', () => {
    expect(nearestUnaffectedVersion(ALL, {}, '3.9.0')).toBeUndefined();
  });

  it('treats a version with a deprecation but no advisory as unaffected', () => {
    // Deprecation is its own row with its own tone; it is not what this offer
    // is about, and refusing it here would send the reader further than needed.
    const flags: Record<string, VersionFlag> = {
      ...flagged('4.1.0'),
      '4.1.3': { deprecation: 'Deprecated.' },
    };
    expect(nearestUnaffectedVersion(ALL, flags, '4.1.0')).toBe('4.1.3');
  });
});
