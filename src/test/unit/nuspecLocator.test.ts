import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { findNuspecFile, findLicenseFile, listRuntimeIdentifiers, findChangelogFile } from '../../nuspecLocator';

describe('findNuspecFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuspec-locator-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeNuspec(idFolder: string, versionFolder: string, fileName: string): Promise<void> {
    const versionDir = path.join(dir, idFolder, versionFolder);
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(path.join(versionDir, fileName), '<package></package>', 'utf8');
  }

  it('finds the nuspec at <folder>/<id lowercased>/<version>/<any name>.nuspec', async () => {
    await writeNuspec('dapper', '2.0.123', 'dapper.nuspec');
    const found = await findNuspecFile([dir], 'Dapper', '2.0.123');
    expect(found).toBe(path.join(dir, 'dapper', '2.0.123', 'dapper.nuspec'));
  });

  it('globs the filename rather than assuming it matches the package id', async () => {
    await writeNuspec('foo', '1.0.0', 'Foo.Weird.Casing.nuspec');
    const found = await findNuspecFile([dir], 'Foo', '1.0.0');
    expect(found).toBe(path.join(dir, 'foo', '1.0.0', 'Foo.Weird.Casing.nuspec'));
  });

  it('matches the version folder case-insensitively', async () => {
    await writeNuspec('npgsql', '10.0.0-RC.1', 'npgsql.nuspec');
    const found = await findNuspecFile([dir], 'Npgsql', '10.0.0-rc.1');
    expect(found).toBe(path.join(dir, 'npgsql', '10.0.0-RC.1', 'npgsql.nuspec'));
  });

  it('tries the next folder when the first does not have the package (fallback folder scenario)', async () => {
    // `dir` has no "dapper" package at all — as if it were a pruned cache or
    // an empty per-machine folder — while `dir2` (e.g. the VS fallback
    // folder) does have it.
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'nuspec-locator-2-'));
    await fs.mkdir(path.join(dir2, 'dapper', '2.0.123'), { recursive: true });
    await fs.writeFile(path.join(dir2, 'dapper', '2.0.123', 'dapper.nuspec'), '<package></package>', 'utf8');
    const found = await findNuspecFile([dir, dir2], 'Dapper', '2.0.123');
    expect(found).toBe(path.join(dir2, 'dapper', '2.0.123', 'dapper.nuspec'));
    await fs.rm(dir2, { recursive: true, force: true });
  });

  it('returns undefined when the package/version is not cached in any folder', async () => {
    const found = await findNuspecFile([dir], 'DoesNotExist', '1.0.0');
    expect(found).toBeUndefined();
  });
});

describe('listRuntimeIdentifiers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuspec-locator-rids-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists the directory names under a sibling runtimes/ folder', async () => {
    const nuspecPath = path.join(dir, 'foo.nuspec');
    await fs.writeFile(nuspecPath, '<package></package>', 'utf8');
    await fs.mkdir(path.join(dir, 'runtimes', 'win-x64', 'native'), { recursive: true });
    await fs.mkdir(path.join(dir, 'runtimes', 'linux-x64', 'native'), { recursive: true });

    expect((await listRuntimeIdentifiers(nuspecPath)).sort()).toEqual(['linux-x64', 'win-x64']);
  });

  it('returns an empty array when there is no runtimes/ folder', async () => {
    const nuspecPath = path.join(dir, 'foo.nuspec');
    await fs.writeFile(nuspecPath, '<package></package>', 'utf8');
    expect(await listRuntimeIdentifiers(nuspecPath)).toEqual([]);
  });

  it('ignores files sitting directly under runtimes/ (only directories are RIDs)', async () => {
    const nuspecPath = path.join(dir, 'foo.nuspec');
    await fs.mkdir(path.join(dir, 'runtimes'), { recursive: true });
    await fs.writeFile(path.join(dir, 'runtimes', 'README.txt'), 'x', 'utf8');
    await fs.mkdir(path.join(dir, 'runtimes', 'win-x64'), { recursive: true });
    expect(await listRuntimeIdentifiers(nuspecPath)).toEqual(['win-x64']);
  });
});

describe('findChangelogFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuspec-locator-changelog-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function writeAt(idFolder: string, versionFolder: string, fileName: string, text = 'x'): Promise<void> {
    const versionDir = path.join(dir, idFolder, versionFolder);
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(path.join(versionDir, fileName), text, 'utf8');
  }

  it.each(['CHANGELOG.md', 'changelog.txt', 'ReleaseNotes.md', 'release-notes.md'])(
    'recognises %s at the package root',
    async (fileName) => {
      await writeAt('example.imaging', '3.1.5', fileName);
      expect(await findChangelogFile([dir], 'Example.Imaging', '3.1.5'))
        .toBe(path.join(dir, 'example.imaging', '3.1.5', fileName));
    },
  );

  it('returns undefined for a name outside the conventional set', async () => {
    await writeAt('example.imaging', '3.1.5', 'HISTORY.md');
    expect(await findChangelogFile([dir], 'Example.Imaging', '3.1.5')).toBeUndefined();
  });

  it('does not recurse into subdirectories', async () => {
    const nestedDir = path.join(dir, 'example.imaging', '3.1.5', 'docs');
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(nestedDir, 'CHANGELOG.md'), 'nested', 'utf8');
    expect(await findChangelogFile([dir], 'Example.Imaging', '3.1.5')).toBeUndefined();
  });

  it('returns undefined when the version is not cached in any folder', async () => {
    expect(await findChangelogFile([dir], 'DoesNotExist', '1.0.0')).toBeUndefined();
  });
});

describe('findLicenseFile', () => {
  let dir: string;
  let nuspecPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuspec-licence-'));
    nuspecPath = path.join(dir, 'example.nuspec');
    await fs.writeFile(nuspecPath, '<package></package>', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('resolves the path the nuspec states, relative to the package root', async () => {
    await fs.writeFile(path.join(dir, 'LICENSE.txt'), 'MIT License', 'utf8');
    expect(await findLicenseFile(nuspecPath, 'LICENSE.txt'))
      .toBe(path.join(dir, 'LICENSE.txt'));
  });

  it('follows a subdirectory, which a package may name', async () => {
    await fs.mkdir(path.join(dir, 'docs'));
    await fs.writeFile(path.join(dir, 'docs', 'LICENSE'), 'MIT License', 'utf8');
    expect(await findLicenseFile(nuspecPath, 'docs/LICENSE'))
      .toBe(path.join(dir, 'docs', 'LICENSE'));
  });

  it('says nothing when the package names a file it did not ship', async () => {
    expect(await findLicenseFile(nuspecPath, 'LICENSE.txt')).toBeUndefined();
  });

  it('refuses a path that climbs out of the package, which is package-supplied data', async () => {
    await fs.writeFile(path.join(dir, 'outside.txt'), 'x', 'utf8');
    expect(await findLicenseFile(path.join(dir, 'inner', 'example.nuspec'), '../outside.txt'))
      .toBeUndefined();
  });
});
