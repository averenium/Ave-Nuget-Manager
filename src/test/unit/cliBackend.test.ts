import { CliBackend } from '../../backend/cliBackend';
import type { CliRunner } from '../../cliRunner';
import type { CliCommand, CliResult } from '../../types';

function fakeRunner(handler: (command: CliCommand) => CliResult): CliRunner {
  return { run: jest.fn((command: CliCommand) => Promise.resolve(handler(command))) } as unknown as CliRunner;
}

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

// `--exact-match` returns one entry per published version, oldest-first in
// this fixture — matching the real ordering the #86 "oldest version" bug
// was reported against.
const SEARCH_JSON = JSON.stringify({
  version: 1,
  searchResult: [
    {
      sourceName: 'nuget.org',
      packages: [
        { id: 'Dapper', version: '1.0.0', description: 'old desc', projectUrl: 'https://old.example', authors: 'A' },
        { id: 'Dapper', version: '2.0.123', description: 'new desc', projectUrl: 'https://new.example', authors: 'B', tags: 'orm sql' },
      ],
    },
  ],
});

describe('CliBackend.getMetadata', () => {
  it('picks the entry matching the requested version, not the first (oldest) one in the JSON (#86)', async () => {
    const runner = fakeRunner(() => ok(SEARCH_JSON));
    const backend = new CliBackend(runner);
    const meta = await backend.getMetadata('Dapper', '1.0.0', ['/p/nuget.config']);
    expect(meta.version).toBe('1.0.0');
    expect(meta.description).toBe('old desc');
    expect(meta.projectUrl).toBe('https://old.example');
  });

  it('picks the newest version when none was requested', async () => {
    const runner = fakeRunner(() => ok(SEARCH_JSON));
    const backend = new CliBackend(runner);
    const meta = await backend.getMetadata('Dapper', '', ['/p/nuget.config']);
    expect(meta.version).toBe('2.0.123');
    expect(meta.description).toBe('new desc');
    expect(meta.tags).toEqual(['orm', 'sql']);
  });

  it('passes --verbosity detailed so description/projectUrl come back at all', async () => {
    const runner = fakeRunner(() => ok(SEARCH_JSON));
    const backend = new CliBackend(runner);
    await backend.getMetadata('Dapper', '2.0.123', ['/p/nuget.config']);
    const args = (runner.run as jest.Mock).mock.calls[0][0].args as string[];
    expect(args).toEqual(expect.arrayContaining(['--verbosity', 'detailed']));
  });

  it('returns a minimal fallback when every config file fails', async () => {
    const runner = fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }));
    const backend = new CliBackend(runner);
    const meta = await backend.getMetadata('Dapper', '2.0.123', ['/p/nuget.config']);
    expect(meta).toEqual({
      id: 'Dapper',
      version: '2.0.123',
      authors: '',
      description: '',
      tags: [],
    });
  });
});

describe('CliBackend.getMetadata deprecation', () => {
  it('surfaces a feed deprecation notice for the requested version', async () => {
    const runner = fakeRunner(() => ok(JSON.stringify({
      version: 1,
      searchResult: [{
        sourceName: 'nuget.org',
        packages: [{
          id: 'WindowsAzure.Storage',
          version: '9.3.3',
          description: 'desc',
          deprecation: 'Please upgrade to Azure.Storage.Common.',
        }],
      }],
    })));
    const backend = new CliBackend(runner);
    const meta = await backend.getMetadata('WindowsAzure.Storage', '9.3.3', ['/p/nuget.config']);
    expect(meta.deprecation).toBe('Please upgrade to Azure.Storage.Common.');
  });
});

describe('CliBackend.enrichPackage', () => {
  it('returns the full version list, latest, and per-version search metadata in one call (#86 Part 1)', async () => {
    const runner = fakeRunner(() => ok(SEARCH_JSON));
    const backend = new CliBackend(runner);
    const result = await backend.enrichPackage('Dapper', ['/p/nuget.config']);
    expect(result.latestVersion).toBe('2.0.123');
    expect(result.versions).toEqual(['2.0.123', '1.0.0']);
    expect(result.metadataByVersion).toEqual({
      '1.0.0': { description: 'old desc', projectUrl: 'https://old.example', authors: 'A', licenseUrl: undefined, tags: undefined },
      '2.0.123': { description: 'new desc', projectUrl: 'https://new.example', authors: 'B', licenseUrl: undefined, tags: 'orm sql' },
    });
  });

  it('carries per-version vulnerable/deprecation flags from the feed (#86)', async () => {
    // Real-world shape from the issue: an old version flagged vulnerable,
    // a newer clean one, both present in the same --exact-match response.
    const runner = fakeRunner(() => ok(JSON.stringify({
      version: 1,
      searchResult: [{
        sourceName: 'nuget.org',
        packages: [
          { id: 'Newtonsoft.Json', version: '12.0.3', description: 'old', vulnerable: true },
          { id: 'Newtonsoft.Json', version: '13.0.3', description: 'new' },
        ],
      }],
    })));
    const backend = new CliBackend(runner);
    const result = await backend.enrichPackage('Newtonsoft.Json', ['/p/nuget.config']);
    expect(result.metadataByVersion?.['12.0.3'].vulnerable).toBe(true);
    expect(result.metadataByVersion?.['13.0.3'].vulnerable).toBeUndefined();
  });

  it('only adds --prerelease when requested', async () => {
    const runner = fakeRunner(() => ok(SEARCH_JSON));
    const backend = new CliBackend(runner);
    await backend.enrichPackage('Dapper', ['/p/nuget.config'], false);
    let args = (runner.run as jest.Mock).mock.calls[0][0].args as string[];
    expect(args).not.toContain('--prerelease');

    await backend.enrichPackage('Dapper', ['/p/nuget.config'], true);
    args = (runner.run as jest.Mock).mock.calls[1][0].args as string[];
    expect(args).toContain('--prerelease');
  });

  it('returns empty results when every config file fails', async () => {
    const runner = fakeRunner(() => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false }));
    const backend = new CliBackend(runner);
    const result = await backend.enrichPackage('Dapper', ['/p/nuget.config']);
    expect(result).toEqual({ latestVersion: '', sourceName: '', versions: [], metadataByVersion: {} });
  });
});

describe('CliBackend.getAllVersions', () => {
  it('marks vulnerable/deprecated versions so the dropdown can warn before a version is chosen (#86)', async () => {
    const runner = fakeRunner(() => ok(JSON.stringify({
      version: 1,
      searchResult: [{
        sourceName: 'nuget.org',
        packages: [
          { id: 'Newtonsoft.Json', version: '12.0.3', vulnerable: true },
          { id: 'Newtonsoft.Json', version: '13.0.3' },
        ],
      }],
    })));
    const backend = new CliBackend(runner);
    const { versions, versionFlags } = await backend.getAllVersions('Newtonsoft.Json', ['/p/nuget.config']);
    expect(versions).toEqual(['13.0.3', '12.0.3']);
    expect(versionFlags).toEqual({ '12.0.3': { vulnerable: true, deprecation: undefined } });
    expect(versionFlags['13.0.3']).toBeUndefined();
  });

  it('unions versions across config files and merges their flags', async () => {
    const runner = fakeRunner((command) => {
      const cf = command.args[command.args.indexOf('--configfile') + 1];
      if (cf === '/a/nuget.config') {
        return ok(JSON.stringify({
          version: 1,
          searchResult: [{ sourceName: 'a', packages: [{ id: 'Pkg', version: '1.0.0' }] }],
        }));
      }
      return ok(JSON.stringify({
        version: 1,
        searchResult: [{ sourceName: 'b', packages: [{ id: 'Pkg', version: '2.0.0', deprecation: 'old' }] }],
      }));
    });
    const backend = new CliBackend(runner);
    const { versions, versionFlags } = await backend.getAllVersions('Pkg', ['/a/nuget.config', '/b/nuget.config']);
    expect(versions).toEqual(['2.0.0', '1.0.0']);
    expect(versionFlags['2.0.0']?.deprecation).toBe('old');
  });

  it('returns no flags when nothing is vulnerable or deprecated', async () => {
    const runner = fakeRunner(() => ok(SEARCH_JSON));
    const backend = new CliBackend(runner);
    const { versionFlags } = await backend.getAllVersions('Dapper', ['/p/nuget.config']);
    expect(versionFlags).toEqual({});
  });
});
