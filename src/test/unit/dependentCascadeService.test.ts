import { DependentCascadeService, type CascadeRequest } from '../../dependentCascadeService';
import type { INuGetBackend, CatalogDecline } from '../../backend/INuGetBackend';
import type { SearchedVersionMetadata } from '../../types';

const TRANSPORT = 'Example.Messaging.Transport';
const BUS = 'Example.Messaging.Bus';

const ASSETS = {
  targets: {
    'net10.0': {
      [`${BUS}/7.8.0`]: { type: 'package', dependencies: { [TRANSPORT]: '[6.0.0, 7.0.0)' } },
      [`${TRANSPORT}/6.8.1`]: { type: 'package' },
    },
    'net8.0': {
      [`${BUS}/7.8.0`]: { type: 'package', dependencies: { [TRANSPORT]: '[6.0.0, 7.0.0)' } },
      [`${TRANSPORT}/6.8.1`]: { type: 'package' },
    },
  },
  projectFileDependencyGroups: {
    'net10.0': [`${BUS} >= 7.8.0`, `${TRANSPORT} >= 6.8.1`],
    'net8.0': [`${BUS} >= 7.8.0`, `${TRANSPORT} >= 6.8.1`],
  },
};

const request: CascadeRequest = {
  requestId: 'r1', packageId: TRANSPORT, fromVersion: '6.8.1', toVersion: '7.2.2',
  projectPath: 'D:/src/Example.Shop/Example.Shop.csproj', frameworks: ['net10.0'], mode: 'apply',
  prerelease: false, configFiles: ['D:/src/nuget.config'],
};

const declared = (range: string): SearchedVersionMetadata => ({
  declaredDependencies: [{ dependencies: [{ id: TRANSPORT, range }] }],
} as SearchedVersionMetadata);

function service(
  getAllVersions: INuGetBackend['getAllVersions'],
  extra: {
    decline?: CatalogDecline;
    assets?: unknown | null;
    releaseNotesFor?: (id: string, version: string) => Promise<{ label: 'Release notes'; url: string } | undefined>;
    releaseNotesBudgetMs?: number;
    blocked?: (id: string) => boolean;
    installedVersionOf?: (id: string, projectPath: string) => string | undefined;
    assetsFor?: (projectPath: string) => unknown | null;
    centralSet?: (projectPath: string, packageId: string) => Promise<{ propsFile: string; projects: string[] } | null>;
  } = {},
) {
  const logged: Array<{ command: string; args: string[]; kind?: string }> = [];
  const backend = {
    getAllVersions,
    catalogDecline: () => extra.decline,
  } as unknown as INuGetBackend;
  const svc = new DependentCascadeService({
    backend,
    log: (command, args, kind) => logged.push({ command, args, kind }),
    readAssets: async (p) => (extra.assetsFor ? extra.assetsFor(p) : extra.assets === undefined ? ASSETS : extra.assets),
    centralSet: extra.centralSet,
    directIdsOf: () => [BUS, TRANSPORT],
    releaseNotesFor: extra.releaseNotesFor,
    releaseNotesBudgetMs: extra.releaseNotesBudgetMs,
    isBlocked: extra.blocked,
    installedVersionOf: extra.installedVersionOf,
  });
  return { svc, logged };
}

describe('DependentCascadeService (#109)', () => {
  it('proposes the dependent that has to move and remembers the answer for a page', async () => {
    const { svc } = service(async () => ({
      versions: ['7.8.0', '8.1.1'],
      versionFlags: { '7.8.0': declared('[6.0.0, 7.0.0)'), '8.1.1': declared('[7.2.0, )') },
    }));

    const { result } = await svc.check(request);

    expect(result?.outcome).toBe('proposal');
    expect(result?.root.children[0]).toMatchObject({ id: BUS, proposedVersion: '8.1.1' });
    expect(svc.recall('r1')?.result).toBe(result);
  });

  it('says a registration past the page cap could not be read, and names source and rung in the Log', async () => {
    const { svc, logged } = service(
      async () => ({ versions: ['7.8.0'], versionFlags: {} }),
      { decline: { code: 'registration-too-large', source: 'example-feed', rung: 'metadata', detail: 'its registration lists 65 pages' } },
    );

    const { result } = await svc.check(request);

    expect(result?.outcome).toBe('unknown');
    expect(result?.root.children[0].reason).toEqual({
      code: 'registration-too-large',
      label: 'registration too large',
      // The page shows this clause; the source and the step are the Log's.
      detail: 'its registration lists more than 64 pages, so its versions were not read',
    });
    const row = logged.find((l) => l.command.startsWith(`Dependents: could not establish ${BUS}`))!;
    expect(row.args.join(' ')).toContain('example-feed');
    expect(row.args.join(' ')).toContain('metadata rung');
    expect(row.args.join(' ')).toContain(BUS);
  });

  it('says a refused credential is that, with the status and the source that refused it', async () => {
    const { svc, logged } = service(
      async () => ({ versions: ['7.8.0'], versionFlags: {} }),
      { decline: { code: 'credential-refused', source: 'example-feed', rung: 'metadata', detail: 'the registration index answered 401', status: 401 } },
    );

    const { result } = await svc.check(request);

    expect(result?.root.children[0].reason).toEqual({
      code: 'credential-refused',
      label: 'credential refused (401)',
      detail: 'example-feed refused the credential (401)',
    });
    // Where it gave up is for the Log, not for the page.
    const row = logged.find((l) => l.command.startsWith(`Dependents: could not establish ${BUS}`))!;
    expect(row.args.join(' ')).toContain('metadata rung — the registration index answered 401');
  });

  it('does not invent a status the feed never gave', async () => {
    const { svc } = service(
      async () => ({ versions: ['7.8.0'], versionFlags: {} }),
      { decline: { code: 'credential-refused', source: 'example-feed', rung: 'metadata', detail: 'x' } },
    );

    const { result } = await svc.check(request);

    expect(result?.root.children[0].reason).toMatchObject({ label: 'credential refused', detail: 'example-feed refused the credential' });
  });

  it('reports a lookup that throws as unreachable, in the Log as an error', async () => {
    const { svc, logged } = service(async () => { throw new Error('socket hang up'); });

    const { result } = await svc.check(request);

    expect(result?.root.children[0].reason).toMatchObject({ code: 'unreachable' });
    expect(logged.some((l) => l.kind === 'error' && l.command.includes(BUS))).toBe(true);
  });

  it('answers that there is no restore graph rather than guessing clear', async () => {
    const { svc } = service(async () => ({ versions: [], versionFlags: {} }), { assets: null });

    const answer = await svc.check(request);

    expect(answer.result).toBeNull();
    expect(answer.unavailable).toContain('restore');
  });

  it('falls back to the project\'s references when the restore file does not name them', async () => {
    const assets = { targets: ASSETS.targets };
    const { svc } = service(async () => ({
      versions: ['7.8.0', '8.1.1'],
      versionFlags: { '7.8.0': declared('[6.0.0, 7.0.0)'), '8.1.1': declared('[7.2.0, )') },
    }), { assets });

    const { result } = await svc.check(request);

    expect(result?.root.children[0].status).toBe('moves');
  });

  it('computes every framework of the project and names the others whose answer differs', async () => {
    const assets = {
      ...ASSETS,
      targets: {
        ...ASSETS.targets,
        // On net8.0 the bus is not a dependent at all: nothing has to move there.
        'net8.0': { [`${TRANSPORT}/6.8.1`]: { type: 'package' }, [`${BUS}/7.8.0`]: { type: 'package' } },
      },
    };
    const { svc } = service(async () => ({
      versions: ['7.8.0', '8.1.1'],
      versionFlags: { '7.8.0': declared('[6.0.0, 7.0.0)'), '8.1.1': declared('[7.2.0, )') },
    }), { assets });

    const { result } = await svc.check({ ...request, frameworks: ['net10.0', 'net8.0'] });

    expect(result?.framework).toBe('net10.0');
    expect(result?.otherFrameworks).toBeUndefined();
  });

  it('names a differing framework when two answers disagree', async () => {
    const assets = {
      ...ASSETS,
      targets: {
        'net10.0': ASSETS.targets['net10.0'],
        'net8.0': {
          [`${BUS}/7.8.0`]: { type: 'package', dependencies: { [TRANSPORT]: '[5.0.0, 7.0.0)' } },
          [`${TRANSPORT}/6.8.1`]: { type: 'package' },
          'Example.Extra/1.0.0': { type: 'package', dependencies: { [TRANSPORT]: '[6.0.0, 7.0.0)' } },
        },
      },
      projectFileDependencyGroups: {
        'net10.0': [BUS, TRANSPORT],
        'net8.0': [BUS, TRANSPORT, 'Example.Extra'],
      },
    };
    const { svc } = service(async (id) => ({
      versions: ['1.0.0', '2.0.0'],
      versionFlags: {
        '1.0.0': declared('[6.0.0, 7.0.0)'),
        '2.0.0': declared(id === BUS ? '[7.2.0, )' : '[7.0.0, )'),
      },
    }), { assets });

    const { result } = await svc.check({ ...request, frameworks: ['net10.0', 'net8.0'] });

    expect(result?.framework).toBe('net10.0');
    expect(result?.otherFrameworks).toEqual(['net8.0']);
  });

  const proposes = async () => ({
    versions: ['7.8.0', '8.1.1'],
    versionFlags: { '7.8.0': declared('[6.0.0, 7.0.0)'), '8.1.1': declared('[7.2.0, )') },
  });

  it('does not wait for the release notes: a popup that interrupts a write never shows them', async () => {
    const asked: string[] = [];
    const { svc } = service(proposes, {
      releaseNotesFor: async (id) => { asked.push(id); return undefined; },
    });

    const { result } = await svc.check(request);

    expect(result?.outcome).toBe('proposal');
    expect(asked).toEqual([]);
  });

  it('reads the release notes of each dependent that moves once the page asks, and none for the bump itself', async () => {
    const { svc } = service(proposes, {
      releaseNotesFor: async (id, version) => ({ label: 'Release notes', url: `https://example.com/${id}/${version}` }),
    });
    const { result } = await svc.check(request);

    const attached = await svc.attachReleaseNotes('r1');

    expect(attached).toBe(result);
    expect(result?.root.children[0].releaseNotes).toEqual({ label: 'Release notes', url: `https://example.com/${BUS}/8.1.1` });
    expect(result?.root.releaseNotes).toBeUndefined();
  });

  it('does not read them twice', async () => {
    const asked: string[] = [];
    const { svc } = service(proposes, {
      releaseNotesFor: async (id) => { asked.push(id); return { label: 'Release notes', url: 'https://example.com/x' }; },
    });
    await svc.check(request);

    await svc.attachReleaseNotes('r1');
    expect(await svc.attachReleaseNotes('r1')).toBeUndefined();
    expect(asked).toEqual([BUS]);
  });

  it('answers without the links when reading them fails or takes longer than its budget', async () => {
    const failing = service(proposes, { releaseNotesFor: async () => { throw new Error('no network'); } });
    const slow = service(proposes, { releaseNotesFor: () => new Promise(() => undefined), releaseNotesBudgetMs: 20 });
    await failing.svc.check(request);
    await slow.svc.check(request);

    expect((await failing.svc.attachReleaseNotes('r1'))?.outcome).toBe('proposal');
    const answer = await slow.svc.attachReleaseNotes('r1');
    expect(answer?.outcome).toBe('proposal');
    expect(answer?.root.children[0].releaseNotes).toBeUndefined();
  });

  it('asks again from the version the project is on now, not the one the page was opened with', async () => {
    const installed = { version: '6.8.1' as string | undefined };
    const { svc } = service(proposes, { installedVersionOf: () => installed.version });
    await svc.check(request);

    installed.version = '7.0.0'; // a write landed in the meantime
    const again = await svc.recheck('r1');

    expect(again?.result?.fromVersion).toBe('7.0.0');
    expect(svc.recall('r1')?.result.fromVersion).toBe('7.0.0');
  });

  it('keeps the old version when the reference is gone, and cannot recheck what it never kept', async () => {
    const { svc } = service(proposes, { installedVersionOf: () => undefined });
    await svc.check(request);

    expect((await svc.recheck('r1'))?.result?.fromVersion).toBe('6.8.1');
    expect(await svc.recheck('unknown')).toBeUndefined();
  });

  it('does not propose a dependent whose updates are blocked: a batch would skip it and write half the closure', async () => {
    const answers = async () => ({
      versions: ['7.8.0', '8.1.1'],
      versionFlags: { '7.8.0': declared('[6.0.0, 7.0.0)'), '8.1.1': declared('[7.2.0, )') },
    });
    const { svc, logged } = service(answers, { blocked: (id) => id.toLowerCase() === BUS.toLowerCase() });

    const { result } = await svc.check(request);

    expect(result?.outcome).toBe('unknown');
    // Judged, and left out on purpose: not "could not establish".
    expect(result?.root.children[0]).toMatchObject({ id: BUS, status: 'left-out', reason: { code: 'blocked' } });
    expect(result).toMatchObject({ unknowns: 0, leftOut: 1 });
    // The row says what to do about it.
    expect(result?.root.children[0].reason?.detail).toContain('unblock it from the right-click menu');
    expect(logged.some((l) => l.command.includes(`left out ${BUS}`) && l.args.join(' ').includes('blocked'))).toBe(true);
  });

  it('keeps only the latest handful of answers', async () => {
    const { svc } = service(async () => ({ versions: [], versionFlags: {} }));
    for (let i = 0; i < 12; i += 1) await svc.check({ ...request, requestId: `r${i}` });

    expect(svc.recall('r0')).toBeUndefined();
    expect(svc.recall('r11')).toBeDefined();
  });
});

describe('asking the feed across frameworks (#109)', () => {
  it('reads a package once however many frameworks of the project reach it', async () => {
    const getAllVersions = jest.fn(async () => ({
      versions: ['7.8.0', '8.1.1'],
      versionFlags: { '7.8.0': declared('[6.0.0, 7.0.0)'), '8.1.1': declared('[7.2.0, )') },
    }));
    const { svc } = service(getAllVersions as unknown as INuGetBackend['getAllVersions']);

    // ASSETS holds the same dependent under net10.0 and net8.0; no frameworks named means both.
    await svc.check({ ...request, frameworks: [] });

    const askedAboutBus = getAllVersions.mock.calls.filter((call) => (call as unknown as string[])[0] === BUS);
    expect(askedAboutBus).toHaveLength(1);
  });
});

describe('a version held centrally (#109)', () => {
  const WEB = 'D:/src/Example.Shop/Example.Shop.Web.csproj';
  const WORKER = 'D:/src/Example.Shop/Example.Shop.Worker.csproj';
  const OTHER = 'D:/src/Example.Shop/Example.Shop.Tools.csproj';
  const PROPS = 'D:/src/Example.Shop/Directory.Packages.props';
  const graph = (libraries: Record<string, Record<string, unknown>>, direct: string[], framework = 'net10.0') => ({
    targets: { [framework]: libraries },
    projectFileDependencyGroups: { [framework]: direct.map((id) => `${id} >= 1.0.0`) },
  });
  const webGraph = () => graph({ [`${TRANSPORT}/6.8.1`]: { type: 'package' } }, [TRANSPORT]);
  const workerGraph = () => graph({
    [`${BUS}/7.8.0`]: { type: 'package', dependencies: { [TRANSPORT]: '[6.0.0, 7.0.0)' } },
    [`${TRANSPORT}/6.8.1`]: { type: 'package' },
  }, [BUS, TRANSPORT]);
  const busVersions = async () => ({
    versions: ['7.8.0', '8.1.1'],
    versionFlags: { '7.8.0': declared('[6.0.0, 7.0.0)'), '8.1.1': declared('[7.2.0, )') },
  });
  const central = (projects: string[], graphs: Record<string, unknown | null>) => service(busVersions, {
    assetsFor: (p) => graphs[p] ?? null,
    centralSet: async () => ({ propsFile: PROPS, projects }),
  });
  const webRequest: CascadeRequest = { ...request, projectPath: WEB, frameworks: [] };

  it('answers once for every project beneath the file, and names them', async () => {
    const { svc } = central([WEB, WORKER], { [WEB]: webGraph(), [WORKER]: workerGraph() });

    const { result } = await svc.check(webRequest);

    expect(result?.outcome).toBe('proposal');
    expect(result?.central).toEqual({ propsFile: PROPS, projects: [WEB, WORKER], frameworks: ['net10.0'] });
    // the dependent only the worker holds, and the project a write for it goes through
    expect(result?.root.children[0]).toMatchObject({ id: BUS, proposedVersion: '8.1.1', projects: [WORKER], writeIn: WORKER });
  });

  it('leaves out a project whose graph does not hold the package: a write cannot reach it', async () => {
    const unrelated = graph({ [`${BUS}/7.8.0`]: { type: 'package' } }, [BUS]);
    const { svc } = central([WEB, WORKER, OTHER], { [WEB]: webGraph(), [WORKER]: workerGraph(), [OTHER]: unrelated });

    const { result } = await svc.check(webRequest);

    expect(result?.central?.projects).toEqual([WEB, WORKER]);
  });

  it('keeps a project that has no restore graph as a row of its own, and the rest of the answer stands', async () => {
    const { svc, logged } = central([WEB, WORKER, OTHER], { [WEB]: webGraph(), [WORKER]: workerGraph(), [OTHER]: null });

    const { result } = await svc.check(webRequest);

    expect(result?.outcome).toBe('proposal');
    expect(result?.root.children.map((c) => c.id)).toEqual([BUS, 'Example.Shop.Tools']);
    expect(result?.root.children[1]).toMatchObject({
      status: 'unknown', project: true, projects: [OTHER], reason: { code: 'not-restored', label: 'not restored' },
    });
    expect(result?.root.children[1].reason?.detail).toBe('it references the package but has not been restored, so it has no restore graph');
    expect(result).toMatchObject({ moves: 1, unknowns: 1 });
    expect(result?.central?.projects).toEqual([WEB, WORKER, OTHER]);
    expect(logged.some((l) => l.args.join(' ').includes('not restored'))).toBe(true);
  });

  it('is not clear when a project could not be judged, even though nothing in the rest has to move', async () => {
    const { svc } = central([WEB, OTHER], { [WEB]: webGraph(), [OTHER]: null });

    const { result } = await svc.check(webRequest);

    expect(result?.outcome).toBe('unknown');
  });

  it('is the ordinary answer for a project that is the only one beneath the file', async () => {
    const { svc } = central([WEB], { [WEB]: workerGraph() });
    const { result } = await svc.check({ ...webRequest, frameworks: ['net10.0'] });

    expect(result?.central).toBeUndefined();
    expect(result?.root.children[0].projects).toBeUndefined();
  });

  it('is the ordinary answer without central package management', async () => {
    const { svc } = service(busVersions);
    const { result } = await svc.check(request);

    expect(result?.central).toBeUndefined();
  });

  it('says so when none of the projects has a graph that holds the package', async () => {
    const { svc } = central([WEB, WORKER], { [WEB]: graph({ [`${BUS}/7.8.0`]: { type: 'package' } }, [BUS]), [WORKER]: null });

    const answer = await svc.check(webRequest);

    expect(answer.result).toBeNull();
    expect(answer.unavailable).toContain('restore');
  });
});
