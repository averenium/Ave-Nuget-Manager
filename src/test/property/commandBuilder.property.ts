/**
 * Property-based tests for CLI command construction.
 * Properties 12, 13, 14, 19, 20 from the design document.
 * Minimum 100 iterations each.
 */

import * as fc from 'fast-check';
import * as path from 'path';
import { CliBackend, compareSemVerDesc } from '../../backend/cliBackend';
import { Logger } from '../../logger';
import { CliRunner } from '../../cliRunner';
import type { CliCommand } from '../../types';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** Generates a valid absolute POSIX-style project path ending in .csproj */
const absoluteProjectPath = fc.tuple(
  fc.stringMatching(/^[a-zA-Z0-9_-]+$/),
  fc.stringMatching(/^[a-zA-Z0-9_-]+$/),
  fc.stringMatching(/^[a-zA-Z0-9_.-]+$/),
).map(([dir, subdir, name]) => `/${dir}/${subdir}/${name}.csproj`);

/** Generates a valid NuGet package id */
const packageId = fc.stringMatching(/^[A-Za-z][A-Za-z0-9._-]{0,99}$/);

/** Generates a SemVer-ish version string */
const semVer = fc.tuple(
  fc.nat({ max: 20 }),
  fc.nat({ max: 20 }),
  fc.nat({ max: 20 }),
).map(([maj, min, pat]) => `${maj}.${min}.${pat}`);

function makeRunnerWithCapture(): { runner: CliRunner; calls: CliCommand[] } {
  const calls: CliCommand[] = [];
  const logger = new Logger();
  const runner = new CliRunner(logger);
  jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
    calls.push(cmd);
    return { exitCode: 0, stdout: '{"version":1,"projects":[]}', stderr: '', timedOut: false };
  });
  return { runner, calls };
}

// ─── Property 12: install command form ───────────────────────────────────────

describe('Property 12 — install command is correctly formed', () => {
  it('args = [add, <projectPath>, package, <id>, --version, <ver>]', async () => {
    await fc.assert(
      fc.asyncProperty(absoluteProjectPath, packageId, semVer, async (p, id, ver) => {
        const { runner, calls } = makeRunnerWithCapture();
        jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
          calls.push(cmd);
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        });
        const backend = new CliBackend(runner);

        await backend.installPackage(p, id, ver);

        expect(calls[0].args).toEqual(['add', p, 'package', id, '--version', ver]);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 13: multi-project install invokes exactly once per project ─────

describe('Property 13 — one install command per selected project', () => {
  it('invokes installPackage exactly once for each project in the list', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(absoluteProjectPath, { minLength: 1, maxLength: 10 }),
        packageId,
        semVer,
        async (projects, id, ver) => {
          const calls: CliCommand[] = [];
          const logger = new Logger();
          const runner = new CliRunner(logger);
          jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
            calls.push(cmd);
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
          });
          const backend = new CliBackend(runner);

          // Simulate multi-project install (as done by WebviewMessageBroker)
          await Promise.all(projects.map((p) => backend.installPackage(p, id, ver)));

          // Exactly one call per project
          expect(calls).toHaveLength(projects.length);
          const calledPaths = calls.map((c) => c.args[1]).sort();
          const inputPaths = [...projects].sort();
          expect(calledPaths).toEqual(inputPaths);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 14: remove command form ────────────────────────────────────────

describe('Property 14 — remove command is correctly formed', () => {
  it('args = [remove, <projectPath>, package, <id>]', async () => {
    await fc.assert(
      fc.asyncProperty(absoluteProjectPath, packageId, async (p, id) => {
        const calls: CliCommand[] = [];
        const logger = new Logger();
        const runner = new CliRunner(logger);
        jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
          calls.push(cmd);
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        });
        const backend = new CliBackend(runner);

        await backend.removePackage(p, id);

        expect(calls[0].args).toEqual(['remove', p, 'package', id]);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 19: cwd = dirname of scope file ────────────────────────────────

describe('Property 19 — cwd equals dirname of project file', () => {
  it('install: cwd = path.dirname(projectPath)', async () => {
    await fc.assert(
      fc.asyncProperty(absoluteProjectPath, packageId, semVer, async (p, id, ver) => {
        const { runner, calls } = makeRunnerWithCapture();
        jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
          calls.push(cmd);
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        });
        const backend = new CliBackend(runner);
        await backend.installPackage(p, id, ver);
        expect(calls[0].cwd).toBe(path.dirname(p));
      }),
      { numRuns: 100 },
    );
  });

  it('remove: cwd = path.dirname(projectPath)', async () => {
    await fc.assert(
      fc.asyncProperty(absoluteProjectPath, packageId, async (p, id) => {
        const calls: CliCommand[] = [];
        const logger = new Logger();
        const runner = new CliRunner(logger);
        jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
          calls.push(cmd);
          return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
        });
        const backend = new CliBackend(runner);
        await backend.removePackage(p, id);
        expect(calls[0].cwd).toBe(path.dirname(p));
      }),
      { numRuns: 100 },
    );
  });

  it('listInstalled: cwd = path.dirname(projectPath)', async () => {
    await fc.assert(
      fc.asyncProperty(absoluteProjectPath, async (p) => {
        const { runner, calls } = makeRunnerWithCapture();
        const backend = new CliBackend(runner);
        await backend.listInstalled(p);
        expect(calls[0].cwd).toBe(path.dirname(p));
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property 20: list command args ──────────────────────────────────────────

describe('Property 20 — list command strings are correctly formed', () => {
  it('listInstalled args = [list, p, package, --format, json]', async () => {
    await fc.assert(
      fc.asyncProperty(absoluteProjectPath, async (p) => {
        const { runner, calls } = makeRunnerWithCapture();
        const backend = new CliBackend(runner);
        await backend.listInstalled(p);
        expect(calls[0].args).toEqual(['list', p, 'package', '--format', 'json']);
      }),
      { numRuns: 100 },
    );
  });

  it('listTransitive args = [list, p, package, --include-transitive, --format, json]', async () => {
    await fc.assert(
      fc.asyncProperty(absoluteProjectPath, async (p) => {
        const { runner, calls } = makeRunnerWithCapture();
        jest.spyOn(runner, 'run').mockImplementation(async (cmd) => {
          calls.push(cmd);
          return { exitCode: 0, stdout: '{"version":1,"projects":[]}', stderr: '', timedOut: false };
        });
        const backend = new CliBackend(runner);
        await backend.listTransitive(p);
        expect(calls[0].args).toEqual([
          'list', p, 'package', '--include-transitive', '--format', 'json',
        ]);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── SemVer sort (used in Property 9 for VersionSelector) ────────────────────

describe('compareSemVerDesc', () => {
  it('sorts versions in descending order (Property 9 basis)', () => {
    const versions = ['1.0.0', '3.0.0', '2.1.0', '2.0.1', '10.0.0'];
    const sorted = [...versions].sort(compareSemVerDesc);
    expect(sorted).toEqual(['10.0.0', '3.0.0', '2.1.0', '2.0.1', '1.0.0']);
  });

  it('for any list of semver strings, sorted result is non-ascending', async () => {
    await fc.assert(
      fc.property(
        fc.array(semVer, { minLength: 1, maxLength: 20 }),
        (versions) => {
          const sorted = [...versions].sort(compareSemVerDesc);
          for (let i = 0; i < sorted.length - 1; i++) {
            // sorted[i] >= sorted[i+1] in semver terms
            const cmp = compareSemVerDesc(sorted[i], sorted[i + 1]);
            expect(cmp).toBeLessThanOrEqual(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
