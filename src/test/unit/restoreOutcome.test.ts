import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseRestoreCache, readRestoreOutcome } from '../../restoreOutcome';

// Measured on a project whose restore failed (#138): the cache holds the id in
// its own field, the code, the frameworks and the feed's wording.
const FAILED = {
  success: false,
  dgSpecHash: 'YfuJxxBcdv4=',
  logs: [
    {
      code: 'NU1101',
      level: 'Error',
      libraryId: 'Example.NoSuchPackage.Ghost',
      targetGraphs: ['net8.0'],
      message: 'Unable to find package Example.NoSuchPackage.Ghost. No packages exist with this id in source(s): nuget.org',
    },
  ],
};

describe('parseRestoreCache (#138)', () => {
  it('reads the id, the code, the frameworks and the feed\'s own wording from a failed restore', () => {
    expect(parseRestoreCache(FAILED)).toEqual({
      success: false,
      failures: [{
        code: 'NU1101',
        libraryId: 'Example.NoSuchPackage.Ghost',
        message: 'Unable to find package Example.NoSuchPackage.Ghost. No packages exist with this id in source(s): nuget.org',
        frameworks: ['net8.0'],
      }],
    });
  });

  it('reads a version that does not exist the same way', () => {
    const parsed = parseRestoreCache({
      success: false,
      logs: [{ code: 'NU1102', level: 'Error', libraryId: 'Example.Json', targetGraphs: ['net8.0', 'net10.0'], message: 'Unable to find package Example.Json with version (>= 99.99.99)' }],
    });
    expect(parsed.failures).toEqual([expect.objectContaining({ code: 'NU1102', libraryId: 'Example.Json', frameworks: ['net8.0', 'net10.0'] })]);
  });

  it('has no failures for a restore that went through', () => {
    expect(parseRestoreCache({ success: true, dgSpecHash: 'x', logs: [] })).toEqual({ success: true, failures: [] });
  });

  it('keeps only errors that name a package: a warning, or an error about no package in particular, is not about a reference', () => {
    const parsed = parseRestoreCache({
      success: false,
      logs: [
        { code: 'NU1903', level: 'Warning', libraryId: 'Example.Json', message: 'vulnerable' },
        { code: 'NU1100', level: 'Error', message: 'something else' },
        { code: 'NU1101', level: 'Error', libraryId: 'Example.A', message: 'x', targetGraphs: [] },
      ],
    });
    expect(parsed.failures.map((f) => f.libraryId)).toEqual(['Example.A']);
  });

  it('is nothing known, not an error, for anything that is not the shape it reads', () => {
    for (const bad of [null, undefined, 'text', 42, [], { logs: 'no' }, { logs: [null, 7, 'x'] }]) {
      expect(() => parseRestoreCache(bad)).not.toThrow();
      expect(parseRestoreCache(bad).failures).toEqual([]);
    }
    expect(parseRestoreCache({ success: 'yes' }).success).toBeUndefined();
  });
});

describe('readRestoreOutcome (#138)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'restore-outcome-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const projectIn = (name: string) => path.join(dir, name);
  const writeCache = async (content: string) => {
    await fs.mkdir(path.join(dir, 'obj'), { recursive: true });
    await fs.writeFile(path.join(dir, 'obj', 'project.nuget.cache'), content, 'utf8');
  };

  it('reads obj/project.nuget.cache beside the project, with when it was written', async () => {
    await writeCache(JSON.stringify(FAILED));

    const outcome = await readRestoreOutcome(projectIn('Example.Shop.csproj'));

    expect(outcome?.success).toBe(false);
    expect(outcome?.failures[0].libraryId).toBe('Example.NoSuchPackage.Ghost');
    expect(outcome?.writtenAt).toBeGreaterThan(0);
  });

  it('is null when the cache is missing', async () => {
    expect(await readRestoreOutcome(projectIn('Example.Shop.csproj'))).toBeNull();
  });

  it('is null when the cache is malformed', async () => {
    await writeCache('{ not json');
    expect(await readRestoreOutcome(projectIn('Example.Shop.csproj'))).toBeNull();
  });
});
