import { compatibilityFor, hiddenVersions, incompatibilityReason } from '../../webview/utils/versionCompatibility';
import type { VersionFlag } from '../../types';

const flags = (byVersion: Record<string, string | undefined>): Record<string, VersionFlag> =>
  Object.fromEntries(
    Object.entries(byVersion).map(([v, tfm]) =>
      [v, { declaredDependencies: tfm ? [{ targetFramework: tfm, dependencies: [] }] : undefined }]),
  );

describe('incompatibilityReason (#107)', () => {
  it('names both the target framework and what the version actually ships', () => {
    expect(incompatibilityReason([{ targetFramework: 'net10.0', dependencies: [] }], ['net9.0'])).toBe(
      "Can't install for net9.0 — no compatible assets (ships net10.0 only)",
    );
  });

  it('returns undefined when the version is compatible', () => {
    expect(incompatibilityReason([{ targetFramework: 'net8.0', dependencies: [] }], ['net10.0'])).toBeUndefined();
  });

  it('names only the project framework that actually fails, not one it already works for', () => {
    // A member referenced from a net9.0 project and a net10.0 project, where
    // every version only declares net10.0: the version works fine for
    // net10.0, so saying it can't install "for net10.0, net9.0" would be
    // wrong — only net9.0 is the actual problem.
    expect(incompatibilityReason([{ targetFramework: 'net10.0', dependencies: [] }], ['net9.0', 'net10.0'])).toBe(
      "Can't install for net9.0 — no compatible assets (ships net10.0 only)",
    );
  });

  it('returns undefined when there is nothing to judge (no groups, or no project frameworks)', () => {
    expect(incompatibilityReason(undefined, ['net9.0'])).toBeUndefined();
    expect(incompatibilityReason([], ['net9.0'])).toBeUndefined();
    expect(incompatibilityReason([{ targetFramework: 'net10.0', dependencies: [] }], [])).toBeUndefined();
  });
});

describe('incompatibilityReason — fix hints (#130)', () => {
  const netTenOnly = [{ targetFramework: 'net10.0', dependencies: [] }];

  it('narrow-badges names the framework(s) to leave out, when some but not all fail', () => {
    expect(incompatibilityReason(netTenOnly, ['net8.0', 'net10.0'], 'narrow-badges')).toBe(
      "Can't install for net8.0 — no compatible assets (ships net10.0 only) — leave net8.0 out to install it here",
    );
  });

  it('open-disclosure names the framework(s) that would still take it', () => {
    expect(incompatibilityReason(netTenOnly, ['net8.0', 'net10.0'], 'open-disclosure')).toBe(
      "Can't install for net8.0 — no compatible assets (ships net10.0 only)"
      + ' — open the project to give net10.0 its own version',
    );
  });

  it('adds no hint of either kind when every framework fails — nothing left to narrow away', () => {
    expect(incompatibilityReason(netTenOnly, ['net8.0'], 'narrow-badges')).toBe(
      "Can't install for net8.0 — no compatible assets (ships net10.0 only)",
    );
    expect(incompatibilityReason(netTenOnly, ['net8.0', 'net9.0'], 'open-disclosure')).toBe(
      "Can't install for net8.0, net9.0 — no compatible assets (ships net10.0 only)",
    );
  });

  it('adds no hint when the version is compatible after all', () => {
    expect(incompatibilityReason(netTenOnly, ['net10.0'], 'narrow-badges')).toBeUndefined();
  });

  it('leaves the plain sentence alone when no fix is requested', () => {
    expect(incompatibilityReason(netTenOnly, ['net8.0', 'net10.0'])).toBe(
      "Can't install for net8.0 — no compatible assets (ships net10.0 only)",
    );
  });

  it('clears when the offending framework is switched off and returns when it is switched back (#130)', () => {
    // What the popup itself does on every badge click: judge only the
    // frameworks still switched on, so the note is a fact about the write
    // Apply is about to make rather than one fixed at the moment it opened.
    const allFrameworks = ['net8.0', 'net10.0'];
    const reasonFor = (off: string[]) =>
      incompatibilityReason(netTenOnly, allFrameworks.filter((f) => !off.includes(f)), 'narrow-badges');

    expect(reasonFor([])).toBeDefined(); // open, both badges on
    expect(reasonFor(['net8.0'])).toBeUndefined(); // net8.0 switched off
    expect(reasonFor([])).toBeDefined(); // switched back on
  });
});

describe('compatibilityFor', () => {
  it('flags the exact #107 repro: 10.0.12/10.0.0 ship net10.0 only, on a net8.0 project', () => {
    const result = compatibilityFor(
      ['10.0.12', '10.0.0', '9.1.0', '9.0.3', '8.0.11', '8.0.4'],
      flags({
        '10.0.12': 'net10.0', '10.0.0': 'net10.0',
        '9.1.0': 'net8.0', '9.0.3': 'net8.0',
        '8.0.11': 'net8.0', '8.0.4': 'net8.0',
      }),
      ['net8.0'],
    );
    expect(result.incompatible).toEqual(['10.0.12', '10.0.0']);
    expect(result.reason('10.0.12')).toBe("Can't install for net8.0 — no compatible assets (ships net10.0 only)");
    expect(result.reason('9.1.0')).toBeUndefined();
  });

  it('reports nothing when the project frameworks are unknown', () => {
    expect(compatibilityFor(['10.0.12'], flags({ '10.0.12': 'net10.0' }), undefined).incompatible).toEqual([]);
    expect(compatibilityFor(['10.0.12'], flags({ '10.0.12': 'net10.0' }), []).incompatible).toEqual([]);
  });

  it('reports nothing when no version flags are known at all (CLI-only path)', () => {
    expect(compatibilityFor(['10.0.12'], undefined, ['net8.0']).incompatible).toEqual([]);
  });

  it('leaves a version the feed said nothing about out of the incompatible set', () => {
    // Missing declaredDependencies is silence, not a claim of "no".
    expect(compatibilityFor(['1.0.0'], { '1.0.0': {} }, ['net8.0']).incompatible).toEqual([]);
  });

  it('requires every one of several project frameworks to be satisfied, not just one', () => {
    // The same version installs into both frameworks at once, so a group that
    // only net9.0 accepts leaves net8.0 without a compatible asset (#107).
    const result = compatibilityFor(
      ['9.0.0'], flags({ '9.0.0': 'net9.0' }), ['net8.0', 'net9.0'],
    );
    expect(result.incompatible).toEqual(['9.0.0']);
  });

  it('accepts a version compatible with every framework at once', () => {
    const result = compatibilityFor(
      ['8.0.0'], flags({ '8.0.0': 'net8.0' }), ['net8.0', 'net9.0'],
    );
    expect(result.incompatible).toEqual([]);
  });

  it('the collapsed row and the per-framework row disagree on the same version, by design (#130)', () => {
    // A net8.0;net10.0 project holding one shared reference: the collapsed
    // row judges the version against both frameworks at once and hides it
    // (net8.0 has no compatible assets), while the net10.0 row underneath
    // the disclosure judges it alone and finds it perfectly ordinary — the
    // exact situation #130 opened with.
    const netTenOnly = flags({ '10.0.12': 'net10.0' });
    const collapsed = compatibilityFor(['10.0.12'], netTenOnly, ['net8.0', 'net10.0'], 'open-disclosure');
    expect(collapsed.incompatible).toEqual(['10.0.12']);
    expect(collapsed.reason('10.0.12')).toBe(
      "Can't install for net8.0 — no compatible assets (ships net10.0 only)"
      + ' — open the project to give net10.0 its own version',
    );

    const perFramework = compatibilityFor(['10.0.12'], netTenOnly, ['net10.0']);
    expect(perFramework.incompatible).toEqual([]);
  });
});

describe('hiddenVersions (#107)', () => {
  it('keeps the selected version out of the hidden set even when it is itself incompatible', () => {
    const compat = compatibilityFor(
      ['10.0.12', '9.1.0'], flags({ '10.0.12': 'net10.0', '9.1.0': 'net8.0' }), ['net8.0'],
    );
    expect(hiddenVersions(compat, '10.0.12')).toEqual([]);
  });

  it('matches the selected version through versionsEqual, not exact string identity', () => {
    // A spelling mismatch (installed row vs. feed string) must not drop the
    // current selection out of the visible list on open — the disclosure
    // design's own guarantee (#107).
    const compat = compatibilityFor(
      ['10.0', '9.1.0'], flags({ '10.0': 'net10.0', '9.1.0': 'net8.0' }), ['net8.0'],
    );
    expect(compat.incompatible).toEqual(['10.0']);
    expect(hiddenVersions(compat, '10.0.0')).toEqual([]);
  });

  it('still hides every other incompatible version', () => {
    const compat = compatibilityFor(
      ['10.0.12', '10.0.0', '9.1.0'],
      flags({ '10.0.12': 'net10.0', '10.0.0': 'net10.0', '9.1.0': 'net8.0' }),
      ['net8.0'],
    );
    expect(hiddenVersions(compat, '9.1.0')).toEqual(['10.0.12', '10.0.0']);
  });
});
