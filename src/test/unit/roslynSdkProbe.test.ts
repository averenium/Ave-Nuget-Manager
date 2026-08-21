import * as path from 'path';
import { RoslynSdkProbe } from '../../roslynSdkProbe';
import type { CliCommand, CliResult } from '../../types';

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false };
}

function fail(): CliResult {
  return { exitCode: 1, stdout: '', stderr: 'fail', timedOut: false };
}

describe('RoslynSdkProbe', () => {
  const sdkRoot = path.join('C:', 'dotnet', 'sdk', '10.0.301');
  const cscPath = path.join(sdkRoot, 'Roslyn', 'bincore', 'csc.dll');

  it('returns sdk + numeric compiler version from csc -version', async () => {
    const calls: string[][] = [];
    const probe = new RoslynSdkProbe(
      {
        run: async (cmd: CliCommand) => {
          calls.push(cmd.args);
          if (cmd.args[0] === '--version') return ok('10.0.301\n');
          if (cmd.args[0] === '--list-sdks') {
            return ok(`10.0.301 [${path.join('C:', 'dotnet', 'sdk')}]\n`);
          }
          if (cmd.args[0] === 'exec') return ok('5.6.0-2.26270.133 (abcdef)\n');
          return fail();
        },
      },
      (p) => p === cscPath,
    );

    await expect(probe.probe('/repo')).resolves.toEqual({
      sdkVersion: '10.0.301',
      compilerVersion: '5.6.0',
    });
    expect(calls[2]).toEqual(['exec', cscPath, '-version']);
  });

  it('returns null when csc -version fails', async () => {
    const probe = new RoslynSdkProbe(
      {
        run: async (cmd: CliCommand) => {
          if (cmd.args[0] === '--version') return ok('10.0.301\n');
          if (cmd.args[0] === '--list-sdks') {
            return ok(`10.0.301 [${path.join('C:', 'dotnet', 'sdk')}]\n`);
          }
          return fail();
        },
      },
      () => true,
    );

    await expect(probe.probe('/repo')).resolves.toBeNull();
  });

  it('returns null when csc.dll is missing', async () => {
    const probe = new RoslynSdkProbe(
      {
        run: async (cmd: CliCommand) => {
          if (cmd.args[0] === '--version') return ok('10.0.301\n');
          if (cmd.args[0] === '--list-sdks') {
            return ok(`10.0.301 [${path.join('C:', 'dotnet', 'sdk')}]\n`);
          }
          throw new Error('exec should not run');
        },
      },
      () => false,
    );

    await expect(probe.probe('/repo')).resolves.toBeNull();
  });
});
