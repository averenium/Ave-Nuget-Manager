/**
 * Command builder tests — verify that CliBackend produces exactly the right
 * CLI argument arrays for every operation (Properties 12, 14, 19, 20).
 *
 * We unit-test via a thin CliRunner mock that captures `run()` calls.
 */

import * as path from 'path';
import { CliBackend } from '../../backend/cliBackend';
import { Logger } from '../../logger';
import { CliRunner } from '../../cliRunner';
import type { CliCommand, CliResult } from '../../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSuccessResult(stdout = ''): CliResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function makeRunnerCapture(): { runner: CliRunner; calls: CliCommand[] } {
  const calls: CliCommand[] = [];
  const logger = new Logger();
  const runner = new CliRunner(logger);
  // Intercept run() calls
  jest.spyOn(runner, 'run').mockImplementation(async (cmd: CliCommand) => {
    calls.push(cmd);
    return makeSuccessResult('{"version":1,"projects":[]}');
  });
  return { runner, calls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CliBackend — command construction', () => {
  // ── Property 20: list commands ──────────────────────────────────────────────

  describe('listInstalled', () => {
    it('uses exactly [list, <path>, package, --format, json, --no-restore]', async () => {
      const { runner, calls } = makeRunnerCapture();
      const backend = new CliBackend(runner);
      const p = '/abs/path/Foo.csproj';

      await backend.listInstalled(p);

      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual(['list', p, 'package', '--format', 'json', '--no-restore']);
    });

    it('cwd is dirname of project file (Property 19)', async () => {
      const { runner, calls } = makeRunnerCapture();
      const backend = new CliBackend(runner);
      const p = '/projects/MySolution/Foo/Foo.csproj';

      await backend.listInstalled(p);

      expect(calls[0].cwd).toBe('/projects/MySolution/Foo');
    });
  });

  describe('listTransitive', () => {
    it('uses exactly [list, <path>, package, --include-transitive, --format, json, --no-restore]', async () => {
      const { runner, calls } = makeRunnerCapture();
      const backend = new CliBackend(runner);
      const p = '/abs/Bar.csproj';

      await backend.listTransitive(p);

      expect(calls[0].args).toEqual([
        'list', p, 'package', '--include-transitive', '--format', 'json', '--no-restore',
      ]);
    });
  });

  describe('listAllForSolution', () => {
    it('uses --include-transitive --format json --no-restore', async () => {
      const { runner, calls } = makeRunnerCapture();
      const backend = new CliBackend(runner);
      const sln = '/abs/My.sln';

      await backend.listAllForSolution(sln);

      expect(calls[0].args).toEqual([
        'list', sln, 'package', '--include-transitive', '--format', 'json', '--no-restore',
      ]);
    });
  });

  describe('listAllForProject', () => {
    it('uses --include-transitive --format json --no-restore', async () => {
      const { runner, calls } = makeRunnerCapture();
      const backend = new CliBackend(runner);
      const p = '/abs/Foo.csproj';

      await backend.listAllForProject(p);

      expect(calls[0].args).toEqual([
        'list', p, 'package', '--include-transitive', '--format', 'json', '--no-restore',
      ]);
    });
  });

  describe('listVulnerable', () => {
    it('uses --vulnerable --include-transitive --format json --no-restore', async () => {
      const { runner, calls } = makeRunnerCapture();
      const backend = new CliBackend(runner);
      const sln = '/abs/My.sln';

      await backend.listVulnerable(sln);

      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual([
        'list', sln, 'package', '--vulnerable', '--include-transitive', '--format', 'json', '--no-restore',
      ]);
      expect(calls[0].cwd).toBe(path.dirname(sln));
    });
  });

  describe('searchPackages', () => {
    it('uses --configfile <path> --format json (Property 20)', async () => {
      const calls: CliCommand[] = [];
      const logger = new Logger();
      const runner = new CliRunner(logger);
      jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
        calls.push(cmd);
        return makeSuccessResult('{"version":1,"searchResult":[]}');
      });
      const backend = new CliBackend(runner);
      const cf = '/home/user/.config/NuGet/NuGet.Config';

      await backend.searchPackages('Newtonsoft', [cf], ['nuget.org']);

      expect(calls[0].args).toContain('--configfile');
      expect(calls[0].args).toContain(cf);
      expect(calls[0].args).toContain('--format');
      expect(calls[0].args).toContain('json');
      expect(calls[0].args[0]).toBe('package');
      expect(calls[0].args[1]).toBe('search');
      expect(calls[0].args[2]).toBe('Newtonsoft');
    });

    it('runs once per config file', async () => {
      const calls: CliCommand[] = [];
      const logger = new Logger();
      const runner = new CliRunner(logger);
      jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
        calls.push(cmd);
        return makeSuccessResult('{"version":1,"searchResult":[]}');
      });
      const backend = new CliBackend(runner);

      await backend.searchPackages('pkg', ['/a/NuGet.Config', '/b/NuGet.Config'], []);

      // One call per config file (Property 13 analog)
      expect(calls).toHaveLength(2);
    });
  });

  // ── Property 12: install command ────────────────────────────────────────────

  describe('installPackage', () => {
    it('uses exactly [add, <projectPath>, package, <id>, --version, <version>]', async () => {
      const calls: CliCommand[] = [];
      const logger = new Logger();
      const runner = new CliRunner(logger);
      jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
        calls.push(cmd);
        return makeSuccessResult();
      });
      const backend = new CliBackend(runner);

      const p = '/abs/Foo.csproj';
      await backend.installPackage(p, 'Newtonsoft.Json', '13.0.3');

      expect(calls[0].args).toEqual([
        'add', p, 'package', 'Newtonsoft.Json', '--version', '13.0.3',
      ]);
    });

    it('forwards AbortSignal to the runner', async () => {
      const { runner, calls } = makeRunnerCapture();
      const backend = new CliBackend(runner);
      const ac = new AbortController();

      await backend.installPackage('/abs/Foo.csproj', 'Pkg', '1.0.0', ac.signal);

      expect(calls[0].signal).toBe(ac.signal);
    });

    it('cwd is dirname of project file (Property 19)', async () => {
      const calls: CliCommand[] = [];
      const logger = new Logger();
      const runner = new CliRunner(logger);
      jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
        calls.push(cmd);
        return makeSuccessResult();
      });
      const backend = new CliBackend(runner);

      await backend.installPackage('/projects/A/A.csproj', 'Pkg', '1.0.0');

      expect(calls[0].cwd).toBe('/projects/A');
    });
  });

  describe('restoreProject', () => {
    it('uses exactly [restore, <projectPath>]', async () => {
      const { runner, calls } = makeRunnerCapture();
      const backend = new CliBackend(runner);
      await backend.restoreProject('/abs/Foo.csproj');
      expect(calls[0].args).toEqual(['restore', '/abs/Foo.csproj']);
    });
  });

  // ── Property 14: remove command ─────────────────────────────────────────────

  describe('removePackage', () => {
    it('uses exactly [remove, <projectPath>, package, <id>]', async () => {
      const calls: CliCommand[] = [];
      const logger = new Logger();
      const runner = new CliRunner(logger);
      jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
        calls.push(cmd);
        return makeSuccessResult();
      });
      const backend = new CliBackend(runner);

      const p = '/abs/Bar.csproj';
      await backend.removePackage(p, 'Serilog');

      expect(calls[0].args).toEqual(['remove', p, 'package', 'Serilog']);
    });

    it('cwd is dirname of project file (Property 19)', async () => {
      const calls: CliCommand[] = [];
      const logger = new Logger();
      const runner = new CliRunner(logger);
      jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
        calls.push(cmd);
        return makeSuccessResult();
      });
      const backend = new CliBackend(runner);

      await backend.removePackage('/projects/B/B.csproj', 'Pkg');

      expect(calls[0].cwd).toBe('/projects/B');
    });
  });
});

// ─── JSON output parsing ──────────────────────────────────────────────────────

describe('CliBackend — output parsing', () => {
  it('parses installed packages from dotnet list --format json', async () => {
    const listJson = JSON.stringify({
      version: 1,
      parameters: '',
      projects: [
        {
          path: '/p/Foo.csproj',
          frameworks: [
            {
              framework: 'net8.0',
              topLevelPackages: [
                { id: 'Newtonsoft.Json', requestedVersion: '13.0.3', resolvedVersion: '13.0.3' },
              ],
            },
          ],
        },
      ],
    });

    const logger = new Logger();
    const runner = new CliRunner(logger);
    jest.spyOn(runner, 'run').mockResolvedValue(makeSuccessResult(listJson));
    const backend = new CliBackend(runner);

    const result = await backend.listInstalled('/p/Foo.csproj');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('Newtonsoft.Json');
    expect(result[0].requestedVersion).toBe('13.0.3');
    expect(result[0].resolvedVersion).toBe('13.0.3');
    expect(result[0].projectPath).toBe('/p/Foo.csproj');
    expect(result[0].framework).toBe('net8.0');
  });

  it('parses transitive packages from dotnet list --include-transitive', async () => {
    const listJson = JSON.stringify({
      version: 1,
      parameters: '',
      projects: [
        {
          path: '/p/Foo.csproj',
          frameworks: [
            {
              framework: 'net8.0',
              transitivePackages: [
                { id: 'Microsoft.Extensions.Logging', resolvedVersion: '8.0.0' },
              ],
            },
          ],
        },
      ],
    });

    const logger = new Logger();
    const runner = new CliRunner(logger);
    jest.spyOn(runner, 'run').mockResolvedValue(makeSuccessResult(listJson));
    const backend = new CliBackend(runner);

    const result = await backend.listTransitive('/p/Foo.csproj');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('Microsoft.Extensions.Logging');
    expect(result[0].resolvedVersion).toBe('8.0.0');
    expect(result[0].framework).toBe('net8.0');
  });

  it('deduplicates search results across config files by id (first-found wins)', async () => {
    const searchJson = (sourceName: string, id: string, version: string) =>
      JSON.stringify({
        version: 1,
        searchResult: [
          {
            sourceName,
            packages: [{ id, latestVersion: version, description: '' }],
          },
        ],
      });

    const logger = new Logger();
    const runner = new CliRunner(logger);
    let call = 0;
    jest.spyOn(runner, 'run').mockImplementation(async () => {
      call++;
      if (call === 1) return makeSuccessResult(searchJson('nexus', 'Pkg.A', '2.0.0'));
      return makeSuccessResult(searchJson('nuget.org', 'Pkg.A', '1.0.0'));
    });
    const backend = new CliBackend(runner);

    const result = await backend.searchPackages('Pkg.A', ['/a/nuget.config', '/b/nuget.config'], []);

    expect(result).toHaveLength(1);
    expect(result[0].sourceName).toBe('nexus'); // first-found wins
    expect(result[0].latestVersion).toBe('2.0.0');
  });

  it('returns empty array on non-zero exit code', async () => {
    const logger = new Logger();
    const runner = new CliRunner(logger);
    jest.spyOn(runner, 'run').mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'error', timedOut: false });
    const backend = new CliBackend(runner);

    expect(await backend.listInstalled('/p/Foo.csproj')).toEqual([]);
    expect(await backend.listTransitive('/p/Foo.csproj')).toEqual([]);
  });

  it('resolves relative project paths from dotnet list against the solution directory', async () => {
    const listJson = JSON.stringify({
      version: 1,
      projects: [
        {
          path: 'src\\App\\App.csproj',
          frameworks: [
            {
              framework: 'net8.0',
              topLevelPackages: [
                { id: 'Newtonsoft.Json', requestedVersion: '13.0.1', resolvedVersion: '13.0.1' },
              ],
            },
          ],
        },
      ],
    });

    const logger = new Logger();
    const runner = new CliRunner(logger);
    jest.spyOn(runner, 'run').mockResolvedValue(makeSuccessResult(listJson));
    const backend = new CliBackend(runner);

    const result = await backend.listAllForSolution('/sol/My.sln');
    const expected = path.normalize(path.resolve('/sol', 'src\\App\\App.csproj'));

    expect(result.installed).toHaveLength(1);
    expect(result.installed[0].projectPath).toBe(expected);
  });

  it('returns error (not a silent empty list) when restore failed and list has only problems', async () => {
    const restoreFailedJson = JSON.stringify({
      version: 1,
      problems: [
        { text: 'Restore failed. Run `dotnet restore` for more details on the issue.', level: 'error' },
      ],
    });
    const logger = new Logger();
    const runner = new CliRunner(logger);
    jest.spyOn(runner, 'run').mockResolvedValue({
      exitCode: 1,
      stdout: restoreFailedJson,
      stderr: '',
      timedOut: false,
    });
    const backend = new CliBackend(runner);

    const result = await backend.listAllForSolution('/sol/My.sln');
    expect(result.installed).toEqual([]);
    expect(result.implicit).toEqual([]);
    expect(result.error).toContain('Restore failed');
  });

  it('still returns packages when list exits non-zero but JSON includes projects', async () => {
    const listJson = JSON.stringify({
      version: 1,
      problems: [{ text: 'warning', level: 'warning' }],
      projects: [
        {
          path: '/p/App.csproj',
          frameworks: [
            {
              framework: 'net8.0',
              topLevelPackages: [
                { id: 'Newtonsoft.Json', requestedVersion: '13.0.1', resolvedVersion: '13.0.1' },
              ],
            },
          ],
        },
      ],
    });
    const logger = new Logger();
    const runner = new CliRunner(logger);
    jest.spyOn(runner, 'run').mockResolvedValue({
      exitCode: 1,
      stdout: listJson,
      stderr: '',
      timedOut: false,
    });
    const backend = new CliBackend(runner);

    const result = await backend.listAllForSolution('/sol/My.sln');
    expect(result.error).toBeUndefined();
    expect(result.installed).toHaveLength(1);
  });

  it('returns empty array on timeout', async () => {
    const logger = new Logger();
    const runner = new CliRunner(logger);
    jest.spyOn(runner, 'run').mockResolvedValue({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    const backend = new CliBackend(runner);

    expect(await backend.listInstalled('/p/Foo.csproj')).toEqual([]);
  });
});
