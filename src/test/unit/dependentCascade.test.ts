import { findTarget, parseEdgeTable } from '../../assetsEdgeTable';
import {
  CASCADE_MAX_DEPTH,
  CASCADE_POPUP_ROWS,
  computeCascade,
  isLargeClosure,
  movesOf,
  rangeForcesMove,
  type CascadeInput,
  type CascadeScope,
  type PackageVersions,
  type UnknownReason,
  type VersionFlagForCascade,
  type VersionsLookup,
} from '../../dependentCascade';

const TRANSPORT = 'Example.Messaging.Transport';
const BUS = 'Example.Messaging.Bus';

/** `Example.Messaging.Bus` 7.8.0 declares the 6.x client; 8.1.1 is the first to declare a 7.x one. */
const BUS_VERSIONS: Record<string, string> = {
  '7.7.0': '6.8.1',
  '7.8.0': '6.8.1',
  '8.0.0-beta99': '[7.0.0, )',
  '8.1.1': '[7.2.0, )',
  '8.1.2': '[7.2.1, )',
  '8.1.3': '[7.2.1, )',
  '8.1.4': '[7.2.1, )',
  '8.1.5': '[7.2.1, )',
  '8.1.7': '[7.2.2, )',
};

function versionsOf(declares: Record<string, string | undefined>, parentId = TRANSPORT, extra: Record<string, VersionFlagForCascade> = {}): PackageVersions {
  const flags: PackageVersions['flags'] = {};
  for (const [version, range] of Object.entries(declares)) {
    flags[version] = {
      declaredDependencies: [{ dependencies: range === undefined ? [] : [{ id: parentId, range }] }],
      ...extra[version],
    };
  }
  return { versions: Object.keys(declares), flags, sourceName: 'example' };
}

/** A project restore: each entry is `[id, version, {dependency: range}]`. */
function target(libraries: Array<[string, string, Record<string, string>?, string?]>, framework = 'net10.0') {
  const targets: Record<string, Record<string, unknown>> = { [framework]: {} };
  for (const [id, version, deps, type] of libraries) {
    targets[framework][`${id}/${version}`] = { type: type ?? 'package', dependencies: deps ?? {} };
  }
  return findTarget(parseEdgeTable({ targets }), framework)!;
}

function lookupFrom(map: Record<string, PackageVersions | UnknownReason | Error>): VersionsLookup {
  return async (id) => {
    const found = map[id];
    if (found instanceof Error) throw found;
    if (!found) return { kind: 'unknown', reason: { code: 'no-dependency-data', label: 'nothing', detail: 'unmapped' } };
    return 'code' in found ? { kind: 'unknown', reason: found } : { kind: 'ok', info: found };
  };
}

function input(over: Partial<CascadeInput> & Pick<CascadeInput, 'target' | 'lookup'>): CascadeInput {
  return {
    directIds: new Set([TRANSPORT.toLowerCase(), BUS.toLowerCase()]),
    packageId: TRANSPORT,
    fromVersion: '6.8.1',
    toVersion: '7.2.2',
    projectPath: 'D:/src/Example.Shop/Example.Shop.csproj',
    mode: 'asked',
    includePrerelease: false,
    ...over,
  };
}

const SHOP = () => target([[BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }], [TRANSPORT, '7.2.2']]);

describe('rangeForcesMove (#109)', () => {
  it('counts a resolved version outside a declared ceiling in both modes', () => {
    expect(rangeForcesMove('[2.7.5, 3.0.0)', '3.1.0', 'apply')).toBe(true);
    expect(rangeForcesMove('[2.7.5, 3.0.0)', '3.1.0', 'asked')).toBe(true);
  });

  it('counts a downgrade below a bare minimum as a restore warning', () => {
    expect(rangeForcesMove('[7.2.2, )', '6.8.1', 'apply')).toBe(true);
  });

  it('proposes a bare minimum crossed by a major only when asked (case 3)', () => {
    expect(rangeForcesMove('6.8.1', '7.2.2', 'apply')).toBe(false);
    expect(rangeForcesMove('6.8.1', '7.2.2', 'asked')).toBe(true);
    expect(rangeForcesMove('6.8.1', '6.9.0', 'asked')).toBe(false);
  });
});

describe('the candidate window (#109)', () => {
  it('picks 8.1.1 and not 8.1.7 for a target of 7.2.0: the closest version that admits it, not the lowest or the latest', async () => {
    const result = await computeCascade(input({
      target: SHOP(), toVersion: '7.2.0', lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
    }));
    expect(result.outcome).toBe('proposal');
    expect(result.root.children).toHaveLength(1);
    expect(result.root.children[0]).toMatchObject({ id: BUS, installedVersion: '7.8.0', proposedVersion: '8.1.1', range: '[7.2.0, )' });
  });

  it('shows the window as a window: for 7.2.0 only 8.1.1 admits, 8.1.2 and later have raised their floor past it', async () => {
    const result = await computeCascade(input({
      target: SHOP(), toVersion: '7.2.0', lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
    }));
    const admitting = result.root.children[0].window!.filter((w) => w.admits).map((w) => w.version);
    expect(admitting).toEqual(['8.1.1']);
  });

  it('keeps the closest version for 7.2.2 too, with 8.1.2 to 8.1.7 all admitting', async () => {
    const result = await computeCascade(input({
      target: SHOP(), toVersion: '7.2.2', lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
    }));
    expect(result.root.children[0].proposedVersion).toBe('8.1.1');
    const admitting = result.root.children[0].window!.filter((w) => w.admits).map((w) => w.version);
    expect(admitting).toEqual(['8.1.7', '8.1.5', '8.1.4', '8.1.3', '8.1.2', '8.1.1']);
  });

  it('picks the top of the window in a downgrade, not the bottom', async () => {
    // Transport goes back 7.2.2 -> 6.8.1; Bus 8.1.7 declares [7.2.2, ) and has to come back with it.
    const result = await computeCascade(input({
      target: target([[BUS, '8.1.7', { [TRANSPORT]: '[7.2.2, )' }], [TRANSPORT, '7.2.2']]),
      fromVersion: '7.2.2', toVersion: '6.8.1',
      lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
    }));
    expect(result.root.children[0]).toMatchObject({ proposedVersion: '7.8.0', installedVersion: '8.1.7' });
    expect(result.root.children[0].window!.filter((w) => w.admits).map((w) => w.version)).toEqual(['7.8.0', '7.7.0']);
  });

  it('breaks a tie, possible only when the window straddles the installed version, towards the higher', async () => {
    const result = await computeCascade(input({
      target: target([['Example.Straddle', '2.0.0', { [TRANSPORT]: '[1.0.0, 2.0.0)' }], [TRANSPORT, '5.0.0']]),
      directIds: new Set(['example.straddle', TRANSPORT.toLowerCase()]),
      fromVersion: '1.5.0', toVersion: '5.0.0', mode: 'apply',
      lookup: lookupFrom({
        'Example.Straddle': versionsOf({ '1.0.0': '[4.0.0, )', '2.0.0': '[1.0.0, 2.0.0)', '3.0.0': '[4.0.0, )' }),
      }),
    }));
    expect(result.root.children[0].proposedVersion).toBe('3.0.0');
  });

  it('never proposes a pre-release unless the toggle is on', async () => {
    const lookup = lookupFrom({ [BUS]: versionsOf({ '7.8.0': '6.8.1', '8.0.0-beta99': '[7.0.0, )', '8.1.1': '[7.2.0, )' }) });
    const off = await computeCascade(input({ target: SHOP(), lookup, includePrerelease: false }));
    const on = await computeCascade(input({ target: SHOP(), lookup, includePrerelease: true }));
    expect(off.root.children[0].proposedVersion).toBe('8.1.1');
    expect(on.root.children[0].proposedVersion).toBe('8.0.0-beta99');
  });

  it('prefers an unmarked version to a deprecated or vulnerable one however far it sits', async () => {
    const lookup = lookupFrom({
      [BUS]: versionsOf(BUS_VERSIONS, TRANSPORT, { '8.1.1': { vulnerable: true }, '8.1.2': { deprecation: 'Legacy' } }),
    });
    const result = await computeCascade(input({ target: SHOP(), toVersion: '7.2.2', lookup }));
    expect(result.root.children[0].proposedVersion).toBe('8.1.3');
    expect(result.root.children[0].flagged).toBeUndefined();
  });

  it('falls back to a marked version, and says so, when nothing unmarked admits the target', async () => {
    const lookup = lookupFrom({
      [BUS]: versionsOf({ '7.8.0': '6.8.1', '8.1.1': '[7.2.0, )' }, TRANSPORT, { '8.1.1': { vulnerable: true } }),
    });
    const result = await computeCascade(input({ target: SHOP(), toVersion: '7.2.0', lookup }));
    expect(result.root.children[0]).toMatchObject({ proposedVersion: '8.1.1', flagged: 'vulnerable' });
  });

  it('skips a withdrawn version', async () => {
    const lookup = lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS, TRANSPORT, { '8.1.1': { listed: false } }) });
    const result = await computeCascade(input({ target: SHOP(), toVersion: '7.2.2', lookup }));
    expect(result.root.children[0].proposedVersion).toBe('8.1.2');
  });

  it('counts a version that drops the dependency altogether as admitting', async () => {
    const lookup = lookupFrom({ [BUS]: versionsOf({ '7.8.0': '6.8.1', '9.0.0': undefined }) });
    const result = await computeCascade(input({ target: SHOP(), lookup }));
    expect(result.root.children[0]).toMatchObject({ proposedVersion: '9.0.0', range: undefined });
  });

  it('ignores a version whose groups do not serve the project framework', async () => {
    const flags = versionsOf({ '7.8.0': '[6.0.0, 7.0.0)', '8.1.1': '[7.2.0, )' });
    flags.flags['8.1.1'] = { declaredDependencies: [{ targetFramework: 'net462', dependencies: [{ id: TRANSPORT, range: '[7.2.0, )' }] }] };
    const result = await computeCascade(input({
      target: target([[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '6.8.1']]),
      mode: 'apply', lookup: lookupFrom({ [BUS]: flags }),
    }));
    expect(result.outcome).toBe('dead-end');
  });
});

describe('what counts as evidence that a dependent has to move (#109)', () => {
  // Measured: Microsoft.Extensions.Logging.Abstractions 9.0.20 -> 10.0.14, with
  // MongoDB.Driver.Core 2.30.0 installed. Every release from 2.18.0 declares the
  // same bare minimum, and 2.17.1 and older do not depend on it at all.
  const LOGGING = 'Example.Extensions.Logging.Abstractions';
  const MONGO = 'Example.Data.Mongo.Core';
  const mongoHistory = (): PackageVersions => {
    const declares: Record<string, string | undefined> = {};
    for (let minor = 13; minor <= 17; minor += 1) declares[`2.${minor}.0`] = undefined;
    for (let minor = 18; minor <= 30; minor += 1) declares[`2.${minor}.0`] = '[2.0.0, )';
    return versionsOf(declares, LOGGING);
  };
  const loggingBump = (over: Partial<CascadeInput> = {}) => input({
    target: target([[MONGO, '2.30.0', { [LOGGING]: '[2.0.0, )' }], [LOGGING, '10.0.14']]),
    directIds: new Set([LOGGING.toLowerCase(), MONGO.toLowerCase()]),
    packageId: LOGGING, fromVersion: '9.0.20', toVersion: '10.0.14',
    lookup: lookupFrom({ [MONGO]: mongoHistory() }),
    ...over,
  });

  it('is clear when no version of the dependent ever names the new major: a heuristic that found nothing proposes nothing', async () => {
    const result = await computeCascade(loggingBump());
    expect(result.outcome).toBe('clear');
    expect(result.root.children).toEqual([]);
    expect(movesOf(result).map((m) => m.packageId)).toEqual([LOGGING]);
  });

  it('still proposes the release that names the new major', async () => {
    const result = await computeCascade(input({
      target: SHOP(), lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
    }));
    expect(result.outcome).toBe('proposal');
    expect(result.root.children[0]).toMatchObject({ proposedVersion: '8.1.1', status: 'moves' });
  });

  it('proposes the later release that dropped the dependency, since that one works with anything', async () => {
    const dropped = versionsOf({ '7.8.0': '6.8.1', '8.0.0': '6.8.1', '9.0.0': undefined });
    const result = await computeCascade(input({ target: SHOP(), lookup: lookupFrom({ [BUS]: dropped }) }));
    expect(result.root.children[0]).toMatchObject({ proposedVersion: '9.0.0', status: 'moves' });
  });

  it('does not propose a release that predates the dependency, even when it is the only one that does not object', async () => {
    const older = versionsOf({ '6.0.0': undefined, '6.5.0': undefined, '7.8.0': '[6.0.0, 7.0.0)' });
    const result = await computeCascade(input({
      target: target([[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '6.8.1']]),
      mode: 'apply', lookup: lookupFrom({ [BUS]: older }),
    }));
    expect(result.outcome).toBe('dead-end');
  });

  it('is not softened for a real restore warning: an out-of-range edge still proposes under apply', async () => {
    const result = await computeCascade(input({
      target: target([[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '6.8.1']]),
      mode: 'apply', lookup: lookupFrom({ [BUS]: versionsOf({ '7.8.0': '[6.0.0, 7.0.0)', '8.1.1': '[7.2.0, )' }) }),
    }));
    expect(result.root.children[0]).toMatchObject({ proposedVersion: '8.1.1', status: 'moves' });
  });
});

describe('what a dependent carries for the page (#109)', () => {
  it('keeps the range the installed version declares beside the one the proposed version declares', async () => {
    const result = await computeCascade(input({
      target: SHOP(), toVersion: '7.2.0', lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
    }));
    expect(result.root.children[0]).toMatchObject({ installedRange: '6.8.1', range: '[7.2.0, )' });
  });

  it('cuts a long history down to the window and a little context, and counts what it left out', async () => {
    const history: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) history[`1.${i}.0`] = '[6.0.0, 7.0.0)';
    for (let i = 0; i < 30; i += 1) history[`2.${i}.0`] = '[7.0.0, )';
    const result = await computeCascade(input({
      target: target([[BUS, '1.20.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '6.8.1']]),
      fromVersion: '6.8.1', toVersion: '7.2.0', mode: 'apply',
      lookup: lookupFrom({ [BUS]: versionsOf(history) }),
    }));
    const node = result.root.children[0];
    expect(node.proposedVersion).toBe('2.0.0');
    const shown = node.window!.map((w) => w.version);
    // newest first; from two below the installed 1.20.0 to two above the window's top edge
    expect(shown[0]).toBe('2.29.0');
    expect(shown[shown.length - 1]).toBe('1.18.0');
    expect(node.windowOlder).toBe(18);
    expect(node.windowNewer).toBe(0);
    expect(shown.length).toBeLessThanOrEqual(60);
  });
});

describe('a version that states no dependencies (#109)', () => {
  it('is no dead end: nothing that stated its dependencies admits the target, but some versions stated nothing', async () => {
    const versions = versionsOf({ '7.7.0': '[6.0.0, 7.0.0)', '7.8.0': '[6.0.0, 7.0.0)' });
    versions.versions.push('8.0.0'); // the feed said nothing about this one
    const result = await computeCascade(input({
      target: target([[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '7.2.2']]),
      toVersion: '7.2.2', mode: 'apply', lookup: lookupFrom({ [BUS]: versions }),
    }));

    expect(result.outcome).toBe('unknown');
    expect(result.deadEnd).toBeUndefined();
    expect(result.root.children[0]).toMatchObject({ status: 'unknown', reason: { code: 'no-dependency-data' } });
    expect(result.root.children[0].reason!.detail).toContain('1 version of');
  });

  it('is still a dead end when the only version that stated nothing is the installed one', async () => {
    const versions = versionsOf({ '7.7.0': '[6.0.0, 7.0.0)' });
    versions.versions.push('7.8.0'); // installed, and the feed said nothing about it
    const result = await computeCascade(input({
      target: target([[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '7.2.2']]),
      toVersion: '7.2.2', mode: 'apply', lookup: lookupFrom({ [BUS]: versions }),
    }));

    expect(result.outcome).toBe('dead-end');
  });

  it('still proposes an admitting version when others stated nothing', async () => {
    const versions = versionsOf({ '7.8.0': '6.8.1', '8.1.1': '[7.2.0, )' });
    versions.versions.push('9.9.9');
    const result = await computeCascade(input({
      target: SHOP(), toVersion: '7.2.0', lookup: lookupFrom({ [BUS]: versions }),
    }));

    expect(result.root.children[0].proposedVersion).toBe('8.1.1');
  });
});

describe('asking the feed (#109)', () => {
  const chain = (ids: string[]) => {
    const libs: Array<[string, string, Record<string, string>?]> = [[TRANSPORT, '2.0.0']];
    ids.forEach((id) => libs.push([id, '1.0.0', { [TRANSPORT]: '[1.0.0, 2.0.0)' }]));
    return {
      target: target(libs), mode: 'apply' as const, fromVersion: '1.0.0', toVersion: '2.0.0',
      directIds: new Set([TRANSPORT.toLowerCase(), ...ids.map((c) => c.toLowerCase())]),
    };
  };
  const answer = () => ({
    kind: 'ok' as const, info: versionsOf({ '1.0.0': '[1.0.0, 2.0.0)', '2.0.0': '[2.0.0, )' }),
  });

  it('asks about a whole level at once instead of one package after another', async () => {
    const ids = ['Example.A', 'Example.B', 'Example.C'];
    const started: string[] = [];
    const release: Array<() => void> = [];
    const lookup: VersionsLookup = (id) => new Promise((resolve) => {
      started.push(id);
      release.push(() => resolve(answer()));
    });

    const walking = computeCascade(input({ ...chain(ids), lookup }));
    await new Promise((resolve) => setImmediate(resolve));

    // every question is out before any answer has come back — the root's own
    // entry (what its new version requires) goes out with the dependents'
    expect(started).toEqual([TRANSPORT, ...ids]);
    release.forEach((r) => r());
    expect((await walking).moves).toBe(3);
  });

  it('keeps the answer the same whichever question comes back first', async () => {
    const ids = ['Example.A', 'Example.B'];
    const release = new Map<string, () => void>();
    const lookup: VersionsLookup = (id) => new Promise((resolve) => {
      release.set(id, () => resolve(answer()));
    });
    const walking = computeCascade(input({ ...chain(ids), lookup }));
    await new Promise((resolve) => setImmediate(resolve));
    release.get('Example.B')!();
    release.get('Example.A')!();
    release.get(TRANSPORT)!();

    expect((await walking).root.children.map((c) => c.id)).toEqual(ids);
  });

  it('does not ask about a package the walk would not propose anyway', async () => {
    const asked: string[] = [];
    const lookup: VersionsLookup = async (id) => { asked.push(id); return answer(); };

    await computeCascade(input({
      ...chain(['Example.A', 'Example.Transitive']),
      directIds: new Set([TRANSPORT.toLowerCase(), 'example.a']),
      lookup,
    }));

    // the root's own entry is read for what its new version requires; the transitive is not asked about
    expect(asked).toEqual([TRANSPORT, 'Example.A']);
  });
});

describe('the outcomes (#109)', () => {
  it('is clear when nothing the target is bumped under has to move', async () => {
    const result = await computeCascade(input({
      target: target([[BUS, '8.1.7', { [TRANSPORT]: '[7.2.2, )' }], [TRANSPORT, '7.2.2']]),
      fromVersion: '7.2.2', toVersion: '7.3.0',
      lookup: lookupFrom({}),
    }));
    expect(result.outcome).toBe('clear');
    expect(movesOf(result)).toEqual([{ packageId: TRANSPORT, fromVersion: '7.2.2', toVersion: '7.3.0' }]);
  });

  it('reaches the dead end when every version of a dependent declares a ceiling below the target', async () => {
    const result = await computeCascade(input({
      target: target([[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '7.2.2']]),
      toVersion: '7.2.2', mode: 'apply',
      lookup: lookupFrom({ [BUS]: versionsOf({ '7.7.0': '[6.0.0, 7.0.0)', '7.8.0': '[6.0.0, 7.0.0)' }) }),
    }));
    expect(result.outcome).toBe('dead-end');
    expect(result.deadEnd).toMatchObject({ id: BUS, status: 'dead-end', deadEndRanges: ['[6.0.0, 7.0.0)'] });
  });

  it('never calls an unknown a dead end: a registration that could not be read proves nothing', async () => {
    const tooLarge: UnknownReason = {
      code: 'registration-too-large', label: 'registration too large', detail: 'its registration lists more than 64 pages',
    };
    const result = await computeCascade(input({ target: SHOP(), lookup: lookupFrom({ [BUS]: tooLarge }) }));
    expect(result.outcome).toBe('unknown');
    expect(result.deadEnd).toBeUndefined();
    expect(result.root.children[0]).toMatchObject({ id: BUS, status: 'unknown', reason: { code: 'registration-too-large' } });
  });

  it('keeps the known dependents proposable when another could not be established', async () => {
    const lookup = lookupFrom({
      [BUS]: versionsOf(BUS_VERSIONS),
      'Example.Messaging.Telemetry': { code: 'credential-refused', label: 'credential refused (401)', detail: 'x' },
    });
    const result = await computeCascade(input({
      target: target([
        [BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }],
        ['Example.Messaging.Telemetry', '2.4.0', { [TRANSPORT]: '6.8.1' }],
        [TRANSPORT, '7.2.2'],
      ]),
      directIds: new Set([BUS.toLowerCase(), 'example.messaging.telemetry', TRANSPORT.toLowerCase()]),
      lookup,
    }));
    expect(result.outcome).toBe('proposal');
    expect(result.moves).toBe(1);
    expect(result.unknowns).toBe(1);
    expect(movesOf(result).map((m) => m.packageId)).toEqual([TRANSPORT, BUS]);
  });

  it('turns a lookup that throws into an unknown, not into a crash or a dead end', async () => {
    const result = await computeCascade(input({ target: SHOP(), lookup: lookupFrom({ [BUS]: new Error('socket hang up') }) }));
    expect(result.outcome).toBe('unknown');
    expect(result.root.children[0].reason).toMatchObject({ code: 'unreachable' });
    expect(result.root.children[0].reason!.detail).toContain('socket hang up');
  });

  it('says a feed that named no dependencies for any version gave no data', async () => {
    const result = await computeCascade(input({
      target: SHOP(), lookup: lookupFrom({ [BUS]: { versions: ['7.8.0', '8.1.1'], flags: {} } }),
    }));
    expect(result.root.children[0].reason).toMatchObject({ code: 'no-dependency-data' });
  });

  const BROKER = 'Example.Messaging.Broker';
  /** BUS is brought in by BROKER, which the project references; BUS declares a ceiling the new TRANSPORT crosses. */
  const TRANSITIVE = () => target([
    [BROKER, '1.0.0', { [BUS]: '7.0.0' }],
    [BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }],
    [TRANSPORT, '6.8.1'],
  ]);

  it('leaves out a transitive dependent a real restore warning reaches, and says which package to move', async () => {
    const result = await computeCascade(input({
      target: TRANSITIVE(), directIds: new Set([TRANSPORT, BROKER].map((id) => id.toLowerCase())), mode: 'apply',
      lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
    }));
    expect(result.outcome).toBe('unknown');
    expect(result).toMatchObject({ unknowns: 0, leftOut: 1 });
    expect(result.root.children[0]).toMatchObject({ id: BUS, status: 'left-out', reason: { code: 'not-direct' } });
    expect(result.root.children[0].reason!.detail).toBe(
      `${BUS} is not referenced by this project; it comes in with ${BROKER}, so move ${BROKER}`,
    );
  });

  it('gives a transitive dependent no row for a bare minimum a major crosses: the feed is not read to decide whether to draw one', async () => {
    let asked = false;
    const result = await computeCascade(input({
      target: target([[BROKER, '1.0.0', { [BUS]: '7.0.0' }], [BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }], [TRANSPORT, '7.2.2']]),
      directIds: new Set([TRANSPORT, BROKER].map((id) => id.toLowerCase())),
      lookup: async (id) => {
        if (id !== TRANSPORT) asked = true;
        return { kind: 'unknown', reason: { code: 'unreachable', label: 'x', detail: 'x' } };
      },
    }));
    expect(result.outcome).toBe('clear');
    expect(result.root.children).toEqual([]);
    expect(asked).toBe(false);
  });

  it('says only that it moves with the package that brings it in when nothing referenced reaches it', async () => {
    const result = await computeCascade(input({
      target: target([[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '6.8.1']]),
      directIds: new Set([TRANSPORT.toLowerCase()]), mode: 'apply',
      lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
    }));
    expect(result.root.children[0].reason!.detail).toBe(
      `${BUS} is not referenced by this project; it moves with the package that brings it in`,
    );
  });

  it('does not propose a major-crossed bare minimum while a write is waiting (case 3 is asked for, never offered)', async () => {
    const lookup = lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) });
    const apply = await computeCascade(input({ target: SHOP(), lookup, mode: 'apply' }));
    expect(apply.outcome).toBe('clear');
    const asked = await computeCascade(input({ target: SHOP(), lookup, mode: 'asked' }));
    expect(asked.outcome).toBe('proposal');
  });
});

describe('the fixpoint (#109)', () => {
  const OUTBOX = 'Example.Messaging.Outbox';

  it('follows a dependent that moves to the dependents it may now put out of range, listing each once', async () => {
    const result = await computeCascade(input({
      target: target([
        [OUTBOX, '3.1.0', { [BUS]: '[7.0.0, 8.0.0)' }],
        [BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }],
        [TRANSPORT, '7.2.2'],
      ]),
      directIds: new Set([OUTBOX.toLowerCase(), BUS.toLowerCase(), TRANSPORT.toLowerCase()]),
      lookup: lookupFrom({
        [BUS]: versionsOf(BUS_VERSIONS),
        [OUTBOX]: versionsOf({ '3.1.0': '[7.0.0, 8.0.0)', '3.4.0': '[8.1.0, )' }, BUS),
      }),
    }));
    expect(result.root.children[0].children[0]).toMatchObject({ id: OUTBOX, installedVersion: '3.1.0', proposedVersion: '3.4.0', parentId: BUS });
    expect(movesOf(result).map((m) => [m.packageId, m.toVersion])).toEqual([[TRANSPORT, '7.2.2'], [BUS, '8.1.1'], [OUTBOX, '3.4.0']]);
  });

  it('lists a dependent reached by two paths once, at its shallowest position, and notes its other edge', async () => {
    const result = await computeCascade(input({
      target: target([
        ['Example.Both', '1.0.0', { [BUS]: '[7.0.0, 8.0.0)', [TRANSPORT]: '[6.0.0, 7.0.0)' }],
        [BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }],
        [TRANSPORT, '7.2.2'],
      ]),
      mode: 'apply',
      directIds: new Set(['example.both', BUS.toLowerCase(), TRANSPORT.toLowerCase()]),
      lookup: lookupFrom({
        [BUS]: versionsOf({ '7.8.0': '[6.0.0, 7.0.0)', '8.1.1': '[7.2.0, )' }),
        'Example.Both': versionsOf({ '1.0.0': '[6.0.0, 7.0.0)', '2.0.0': '[7.0.0, )' }),
      }),
    }));
    const ids: string[] = [];
    const walk = (n: typeof result.root): void => { ids.push(n.id); n.children.forEach(walk); };
    walk(result.root);
    expect(ids.filter((id) => id === 'Example.Both')).toHaveLength(1);
    expect(result.root.children.map((c) => c.id)).toContain('Example.Both');
    const both = result.root.children.find((c) => c.id === 'Example.Both')!;
    expect(both.alsoDeclared).toEqual([{ id: BUS, range: '[7.0.0, 8.0.0)' }]);
  });

  it('stops at the depth cap and says so rather than following a pathological chain', async () => {
    const chain = Array.from({ length: CASCADE_MAX_DEPTH + 3 }, (_, i) => `Example.Chain${i}`);
    const libs: Array<[string, string, Record<string, string>?]> = [[TRANSPORT, '2.0.0']];
    chain.forEach((id, i) => libs.push([id, '1.0.0', { [i === 0 ? TRANSPORT : chain[i - 1]]: '[1.0.0, 2.0.0)' }]));
    const lookups: Record<string, PackageVersions> = {};
    chain.forEach((id, i) => {
      lookups[id] = versionsOf({ '1.0.0': '[1.0.0, 2.0.0)', '2.0.0': '[2.0.0, )' }, i === 0 ? TRANSPORT : chain[i - 1]);
    });
    const result = await computeCascade(input({
      target: target(libs), mode: 'apply', fromVersion: '1.0.0', toVersion: '2.0.0',
      directIds: new Set([TRANSPORT.toLowerCase(), ...chain.map((c) => c.toLowerCase())]),
      lookup: lookupFrom(lookups),
    }));
    let depth = 0;
    let node = result.root;
    while (node.children.length > 0) { node = node.children[0]; depth += 1; }
    expect(depth).toBe(CASCADE_MAX_DEPTH + 1);
    expect(node).toMatchObject({ status: 'unknown', reason: { code: 'too-deep' } });
  });
});

describe('the size of a closure (#109)', () => {
  it('is large only past the popup threshold, counting the dependents that could not be judged', async () => {
    const ids = Array.from({ length: CASCADE_POPUP_ROWS + 1 }, (_, i) => `Example.Member${i}`);
    const libs: Array<[string, string, Record<string, string>?]> = [[TRANSPORT, '2.0.0']];
    ids.forEach((id) => libs.push([id, '1.0.0', { [TRANSPORT]: '[1.0.0, 2.0.0)' }]));
    const lookups: Record<string, PackageVersions> = {};
    ids.forEach((id) => { lookups[id] = versionsOf({ '1.0.0': '[1.0.0, 2.0.0)', '2.0.0': '[2.0.0, )' }); });
    const make = (count: number) => computeCascade(input({
      target: target(libs.slice(0, count + 1)), mode: 'apply', fromVersion: '1.0.0', toVersion: '2.0.0',
      directIds: new Set([TRANSPORT.toLowerCase(), ...ids.map((c) => c.toLowerCase())]),
      lookup: lookupFrom(lookups),
    }));
    expect(isLargeClosure(await make(CASCADE_POPUP_ROWS))).toBe(false);
    expect(isLargeClosure(await make(CASCADE_POPUP_ROWS + 1))).toBe(true);
  });
});

describe('what a dead end writes (#109)', () => {
  it('is the bump alone: a dependent found beside the dead end was never shown, so it is not written', async () => {
    // Two dependents: A has a version that admits the target, B has none.
    const A = 'Example.Core.A';
    const B = 'Example.Core.B';
    const result = await computeCascade(input({
      target: target([
        [A, '1.0.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }],
        [B, '1.0.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }],
        [TRANSPORT, '6.8.1'],
      ]),
      directIds: new Set([TRANSPORT, A, B].map((id) => id.toLowerCase())),
      mode: 'apply',
      lookup: lookupFrom({
        [A]: versionsOf({ '1.0.0': '[6.0.0, 7.0.0)', '1.1.0': '[7.0.0, )' }),
        [B]: versionsOf({ '1.0.0': '[6.0.0, 7.0.0)', '1.1.0': '[6.0.0, 7.0.0)' }),
      }),
    }));

    expect(result.outcome).toBe('dead-end');
    expect(result.deadEnd?.id).toBe(B);
    // A was found moving (it is in the tree) ...
    expect(result.root.children.find((c) => c.id === A)).toMatchObject({ status: 'moves', proposedVersion: '1.1.0' });
    // ... but what Update anyway sends is the bump, which is what the popup showed.
    expect(movesOf(result).map((m) => m.packageId)).toEqual([TRANSPORT]);
  });

  it('is still everything established when there is no dead end', async () => {
    const result = await computeCascade(input({ target: SHOP(), lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }) }));
    expect(movesOf(result).map((m) => m.packageId)).toEqual([TRANSPORT, BUS]);
  });
});

describe('the other direction: what a mover demands of what is already there (#109)', () => {
  const ADAPTER = 'Example.Messaging.Adapter';

  /** Versions that each declare several dependencies: `{ version: [[id, range], ...] }`. */
  const versionsWith = (declares: Record<string, Array<[string, string]>>): PackageVersions => {
    const flags: PackageVersions['flags'] = {};
    for (const [version, deps] of Object.entries(declares)) {
      flags[version] = { declaredDependencies: [{ dependencies: deps.map(([id, range]) => ({ id, range })) }] };
    }
    return { versions: Object.keys(declares), flags, sourceName: 'example' };
  };
  const plain = (...versions: string[]): PackageVersions => versionsWith(Object.fromEntries(versions.map((v) => [v, []])));

  // Measured: EasyNetQ 7.8.0 declares the 6.x client; 8.1.1 the 7.x one, and the floor climbs.
  const BUS_HISTORY: Record<string, Array<[string, string]>> = {
    '7.8.0': [[TRANSPORT, '6.8.1']],
    '8.1.1': [[TRANSPORT, '[7.2.0, )']],
    '8.1.7': [[TRANSPORT, '[7.2.2, )']],
    '8.1.11': [[TRANSPORT, '[7.2.2, )']],
  };
  const TRANSPORT_VERSIONS = plain('6.8.1', '6.9.0', '7.0.0', '7.2.0', '7.2.1', '7.2.2', '7.3.0');
  const busBump = (over: Partial<CascadeInput> = {}): CascadeInput => input({
    target: target([[BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }], [TRANSPORT, '6.8.1']]),
    packageId: BUS, fromVersion: '7.8.0', toVersion: '8.1.11',
    lookup: lookupFrom({ [BUS]: versionsWith(BUS_HISTORY), [TRANSPORT]: TRANSPORT_VERSIONS }),
    ...over,
  });

  it.each(['asked', 'apply'] as const)('proposes the package the new version needs, instead of answering clear and failing on write (%s)', async (mode) => {
    const result = await computeCascade(busBump({ mode }));

    expect(result.outcome).toBe('proposal');
    expect(result.root.children).toHaveLength(1);
    expect(result.root.children[0]).toMatchObject({
      id: TRANSPORT, direction: 'forward', installedVersion: '6.8.1', proposedVersion: '7.2.2',
      range: '[7.2.2, )', requirements: [{ id: BUS, version: '8.1.11', range: '[7.2.2, )' }],
    });
    expect(movesOf(result).map((m) => [m.packageId, m.toVersion])).toEqual([[BUS, '8.1.11'], [TRANSPORT, '7.2.2']]);
  });

  it('raises to the lowest version above a floor: least disturbance, not the latest', async () => {
    const result = await computeCascade(busBump({ toVersion: '8.1.1' }));
    expect(result.root.children[0]).toMatchObject({ proposedVersion: '7.2.0' });
  });

  it('gives a forward edge to a package the project does not reference directly no row at all', async () => {
    const result = await computeCascade(busBump({ directIds: new Set([BUS.toLowerCase()]) }));
    expect(result.outcome).toBe('clear');
    expect(result.root.children).toEqual([]);
  });

  it('lowers a direct reference that a ceiling now sits below: the highest version under it', async () => {
    const result = await computeCascade(busBump({
      target: target([[BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }], [TRANSPORT, '7.2.2']]),
      lookup: lookupFrom({
        [BUS]: versionsWith({ '7.8.0': [[TRANSPORT, '6.8.1']], '8.1.11': [[TRANSPORT, '[6.0.0, 7.0.0)']] }),
        [TRANSPORT]: TRANSPORT_VERSIONS,
      }),
    }));
    expect(result.root.children[0]).toMatchObject({ id: TRANSPORT, direction: 'forward', installedVersion: '7.2.2', proposedVersion: '6.9.0' });
  });

  it.each(['asked', 'apply'] as const)('produces nothing when the installed version already satisfies a bare minimum (%s)', async (mode) => {
    const result = await computeCascade(busBump({
      mode,
      target: target([[BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }], [TRANSPORT, '7.2.2']]),
      lookup: lookupFrom({
        [BUS]: versionsWith({ '7.8.0': [[TRANSPORT, '6.8.1']], '8.1.11': [[TRANSPORT, '[6.0.0, )']] }),
        [TRANSPORT]: TRANSPORT_VERSIONS,
      }),
    }));
    expect(result.outcome).toBe('clear');
  });

  it('does not stop a write because the root package entry cannot be read', async () => {
    const result = await computeCascade(busBump({ lookup: lookupFrom({ [BUS]: new Error('socket hang up') }) }));
    expect(result.outcome).toBe('clear');
  });

  it('leaves out a required package whose updates are blocked: the batch would skip it and write half the set', async () => {
    const result = await computeCascade(busBump({
      lookup: lookupFrom({
        [BUS]: versionsWith(BUS_HISTORY),
        [TRANSPORT]: { code: 'blocked', label: 'updates blocked', detail: 'blocked' },
      }),
    }));
    expect(result.root.children[0]).toMatchObject({ id: TRANSPORT, direction: 'forward', status: 'left-out' });
    expect(result).toMatchObject({ moves: 0, leftOut: 1 });
  });

  describe('one package, more than one constraint', () => {
    // Root TRANSPORT 6.8.1 -> 7.2.2. ADAPTER depends on it (a reverse row) and is also
    // required by BUS 8.1.1, which moves with it (a forward row for the same package).
    const shop = () => target([
      [BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)', [ADAPTER]: '1.0.0' }],
      [ADAPTER, '1.0.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }],
      [TRANSPORT, '6.8.1'],
    ]);
    const busVersions = () => versionsWith({
      '7.8.0': [[TRANSPORT, '[6.0.0, 7.0.0)'], [ADAPTER, '1.0.0']],
      '8.1.1': [[TRANSPORT, '[7.2.0, )'], [ADAPTER, '[2.0.0, )']],
    });
    const adapterVersions = () => versionsWith({
      '1.0.0': [[TRANSPORT, '[6.0.0, 7.0.0)']],
      '1.5.0': [[TRANSPORT, '[7.0.0, )']],
      '2.0.0': [[TRANSPORT, '[7.0.0, )']],
    });
    const both = (over: Partial<CascadeInput> = {}) => input({
      target: shop(), mode: 'apply',
      directIds: new Set([TRANSPORT, BUS, ADAPTER].map((id) => id.toLowerCase())),
      lookup: lookupFrom({ [BUS]: busVersions(), [ADAPTER]: adapterVersions() }),
      ...over,
    });

    it('is one row whose version satisfies both, and records the second edge', async () => {
      const result = await computeCascade(both());

      // On its own the adapter would stop at 1.5.0, the closest that admits 7.2.2;
      // BUS 8.1.1 requires 2.0.0 or more, and the row has to end up satisfying that too.
      const rows = [...result.root.children, ...result.root.children.flatMap((c) => c.children)].filter((n) => n.id === ADAPTER);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'moves', proposedVersion: '2.0.0' });
      expect(rows[0].requirements).toEqual([{ id: BUS, version: '8.1.1', range: '[2.0.0, )' }]);
    });

    it('is a dead end naming both when the constraints cannot both be met', async () => {
      // The root itself requires the adapter below 2.0.0; BUS 8.1.1 requires 2.0.0 or more.
      const result = await computeCascade(both({
        lookup: lookupFrom({
          [TRANSPORT]: versionsWith({ '7.2.2': [[ADAPTER, '[1.2.0, 2.0.0)']], '6.8.1': [] }),
          [BUS]: busVersions(),
          [ADAPTER]: adapterVersions(),
        }),
      }));

      expect(result.outcome).toBe('dead-end');
      expect(result.deadEnd?.id).toBe(ADAPTER);
      expect(result.deadEnd?.constraints).toEqual(expect.arrayContaining([
        { id: TRANSPORT, version: '7.2.2', kind: 'requires', range: '[1.2.0, 2.0.0)' },
        { id: BUS, version: '8.1.1', kind: 'requires', range: '[2.0.0, )' },
      ]));
    });

    it('never changes the version the person chose: an edge that demands the root move is a dead end on the mover that demands it', async () => {
      const result = await computeCascade(both({
        // the adapter does not depend on the root as installed, so it is reached only by BUS 8.1.1
        target: target([
          [BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)', [ADAPTER]: '1.0.0' }],
          [ADAPTER, '1.0.0'],
          [TRANSPORT, '6.8.1'],
        ]),
        lookup: lookupFrom({
          [BUS]: busVersions(),
          // every adapter this could take wants a root the person did not choose
          [ADAPTER]: versionsWith({
            '1.0.0': [],
            '2.0.0': [[TRANSPORT, '[8.0.0, )']],
          }),
        }),
      }));

      expect(result.root.proposedVersion).toBe('7.2.2');
      expect(result.outcome).toBe('dead-end');
      expect(result.deadEnd?.id).toBe(ADAPTER);
      expect(result.deadEnd?.constraints).toEqual(expect.arrayContaining([{ id: TRANSPORT, version: '7.2.2', kind: 'fixed', range: '[8.0.0, )' }]));
    });
  });
});

describe('a floor a referenced project imposes (#109)', () => {
  const CORE = 'Example.Shop.Core';
  // Root TRANSPORT goes down 7.2.2 -> 6.8.1; BUS 8.1.7 wants 7.2.2 or more, so it has to go back too.
  const busVersions = () => versionsOf({ '7.8.0': '6.8.1', '8.1.7': '[7.2.2, )' });
  const downgrade = (libraries: Array<[string, string, Record<string, string>?, string?]>, over: Partial<CascadeInput> = {}) => input({
    target: target(libraries),
    fromVersion: '7.2.2', toVersion: '6.8.1', mode: 'apply',
    lookup: lookupFrom({ [BUS]: busVersions() }),
    ...over,
  });

  it('does not propose a version below the floor: it is a dead end that names the project holding it', async () => {
    // Core, a project this one references, needs BUS 8.0.0 or more. 7.8.0 is the only
    // version that admits the older client, and it is below that.
    const result = await computeCascade(downgrade([
      [BUS, '8.1.7', { [TRANSPORT]: '[7.2.2, )' }],
      [TRANSPORT, '7.2.2'],
      [CORE, '1.0.0', { [BUS]: '8.0.0' }, 'project'],
    ]));

    expect(result.outcome).toBe('dead-end');
    expect(result.deadEnd).toMatchObject({ id: BUS, status: 'dead-end' });
    expect(result.deadEnd?.constraints).toEqual(expect.arrayContaining([
      { id: TRANSPORT, version: '6.8.1', kind: 'admits' },
      { id: CORE, kind: 'floor', range: '8.0.0' },
    ]));
  });

  it('proposes the version when the floor is met, as it did without one', async () => {
    const result = await computeCascade(downgrade([
      [BUS, '8.1.7', { [TRANSPORT]: '[7.2.2, )' }],
      [TRANSPORT, '7.2.2'],
      [CORE, '1.0.0', { [BUS]: '7.0.0' }, 'project'],
    ]));

    expect(result.root.children[0]).toMatchObject({ id: BUS, status: 'moves', proposedVersion: '7.8.0' });
  });

  it('does not affect an upgrade: a floor only ever forbids going back', async () => {
    const result = await computeCascade(input({
      target: target([
        [BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }],
        [TRANSPORT, '7.2.2'],
        [CORE, '1.0.0', { [BUS]: '7.0.0' }, 'project'],
      ]),
      lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
    }));

    expect(result.root.children[0]).toMatchObject({ proposedVersion: '8.1.1', status: 'moves' });
  });

  it('is exactly as before for a project that references no other project', async () => {
    const result = await computeCascade(downgrade([
      [BUS, '8.1.7', { [TRANSPORT]: '[7.2.2, )' }],
      [TRANSPORT, '7.2.2'],
    ]));

    expect(result.root.children[0]).toMatchObject({ id: BUS, proposedVersion: '7.8.0' });
  });
});

describe('one closure for every project under a central version (#109)', () => {
  const APP = 'D:/src/Example.Shop/Example.Shop.Web.csproj';
  const WORKER = 'D:/src/Example.Shop/Example.Shop.Worker.csproj';
  const scope = (projectPath: string, libraries: Array<[string, string, Record<string, string>?]>, direct: string[], framework = 'net10.0'): CascadeScope => ({
    projectPath, target: target(libraries, framework), directIds: new Set(direct.map((id) => id.toLowerCase())),
  });
  // Web references only the package; Worker also references Bus, which declares a ceiling the new version crosses.
  const web = () => scope(APP, [[TRANSPORT, '6.8.1']], [TRANSPORT]);
  const worker = () => scope(WORKER, [[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '6.8.1']], [TRANSPORT, BUS]);
  const together = (over: Partial<CascadeInput> = {}): CascadeInput => {
    const [primary, ...others] = [web(), worker()];
    return input({
      target: primary.target, directIds: primary.directIds, projectPath: primary.projectPath, others,
      mode: 'apply', lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
      ...over,
    });
  };

  it('finds a dependent that only another project holds, and says where it is and where to write it', async () => {
    const result = await computeCascade(together());

    expect(result.outcome).toBe('proposal');
    expect(result.root.children[0]).toMatchObject({ id: BUS, status: 'moves', proposedVersion: '8.1.1', projects: [WORKER], writeIn: WORKER });
  });

  it('is clear for a single project: nothing names a project', async () => {
    const result = await computeCascade(input({ target: web().target, directIds: web().directIds, lookup: lookupFrom({}) }));
    expect(result.outcome).toBe('clear');
    expect(result.root.children).toEqual([]);

    const single = await computeCascade(input({ target: worker().target, directIds: worker().directIds, mode: 'apply', lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }) }));
    expect(single.root.children[0].projects).toBeUndefined();
    expect(single.root.children[0].writeIn).toBeUndefined();
  });

  it('is forced when any one project holds a range the new version leaves out', async () => {
    // Web holds BUS with a range the new version satisfies; Worker holds it with a ceiling.
    const ok = scope(APP, [[BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }], [TRANSPORT, '6.8.1']], [TRANSPORT, BUS]);
    const [primary, ...others] = [ok, worker()];
    const result = await computeCascade(input({
      target: primary.target, directIds: primary.directIds, projectPath: primary.projectPath, others,
      mode: 'apply', lookup: lookupFrom({ [BUS]: versionsOf(BUS_VERSIONS) }),
    }));

    expect(result.root.children).toHaveLength(1);
    expect(result.root.children[0]).toMatchObject({ id: BUS, status: 'moves', proposedVersion: '8.1.1' });
    expect(result.root.children[0].projects).toEqual([APP, WORKER]);
  });

  it('asks the feed about a package once, however many projects reach it', async () => {
    const asked: string[] = [];
    const lookup: VersionsLookup = async (id) => { asked.push(id); return { kind: 'ok', info: versionsOf(BUS_VERSIONS) }; };
    const second = scope(APP, [[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '6.8.1']], [TRANSPORT, BUS]);
    const [primary, ...others] = [worker(), second];

    await computeCascade(input({
      target: primary.target, directIds: primary.directIds, projectPath: primary.projectPath, others, mode: 'apply', lookup,
    }));

    expect(asked.filter((id) => id === BUS)).toHaveLength(1);
  });

  it('raises a required package that only another project references', async () => {
    // Bus is the root, going to 8.1.11; Worker holds the client at 6.8.1, Web does not hold it at all.
    const busWeb = scope(APP, [[BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }]], [BUS]);
    const busWorker = scope(WORKER, [[BUS, '7.8.0', { [TRANSPORT]: '6.8.1' }], [TRANSPORT, '6.8.1']], [BUS, TRANSPORT]);
    const history: Record<string, string> = { '7.8.0': '6.8.1', '8.1.11': '[7.2.2, )' };
    const flags: PackageVersions['flags'] = {};
    for (const [v, range] of Object.entries(history)) flags[v] = { declaredDependencies: [{ dependencies: [{ id: TRANSPORT, range }] }] };
    const client: PackageVersions = {
      versions: ['6.8.1', '7.2.2', '7.3.0'],
      flags: Object.fromEntries(['6.8.1', '7.2.2', '7.3.0'].map((v) => [v, { declaredDependencies: [{ dependencies: [] }] }])),
    };

    const result = await computeCascade(input({
      target: busWeb.target, directIds: busWeb.directIds, projectPath: busWeb.projectPath, others: [busWorker],
      packageId: BUS, fromVersion: '7.8.0', toVersion: '8.1.11',
      lookup: lookupFrom({ [BUS]: { versions: Object.keys(history), flags }, [TRANSPORT]: client }),
    }));

    expect(result.root.children[0]).toMatchObject({
      id: TRANSPORT, direction: 'forward', proposedVersion: '7.2.2', projects: [WORKER], writeIn: WORKER,
    });
  });

  it('needs a version that serves every framework of every project', async () => {
    // 8.1.1 declares its dependencies only for net10.0: a net8.0 project cannot use that group,
    // so with a net8.0 project in the set it is not a candidate, and with only net10.0 it is.
    const flags: PackageVersions = {
      versions: ['7.8.0', '8.1.1', '8.2.0'],
      flags: {
        '7.8.0': { declaredDependencies: [{ dependencies: [{ id: TRANSPORT, range: '[6.0.0, 7.0.0)' }] }] },
        '8.1.1': { declaredDependencies: [{ targetFramework: 'net10.0', dependencies: [{ id: TRANSPORT, range: '[7.2.0, )' }] }] },
        '8.2.0': { declaredDependencies: [{ dependencies: [{ id: TRANSPORT, range: '[7.2.0, )' }] }] },
      },
    };
    const net8 = scope(APP, [[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '6.8.1']], [TRANSPORT, BUS], 'net8.0');
    const net10 = scope(WORKER, [[BUS, '7.8.0', { [TRANSPORT]: '[6.0.0, 7.0.0)' }], [TRANSPORT, '6.8.1']], [TRANSPORT, BUS], 'net10.0');

    const result = await computeCascade(input({
      target: net8.target, directIds: net8.directIds, projectPath: net8.projectPath, others: [net10],
      mode: 'apply', lookup: lookupFrom({ [BUS]: flags }),
    }));

    expect(result.root.children[0]).toMatchObject({ id: BUS, proposedVersion: '8.2.0' });

    const alone = await computeCascade(input({
      target: net10.target, directIds: net10.directIds, projectPath: net10.projectPath,
      mode: 'apply', lookup: lookupFrom({ [BUS]: flags }),
    }));
    expect(alone.root.children[0]).toMatchObject({ id: BUS, proposedVersion: '8.1.1' });
  });
});
