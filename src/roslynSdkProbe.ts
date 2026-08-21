import * as fs from 'fs';
import * as path from 'path';
import type { CliRunner } from './cliRunner';
import {
  parseCscNumericVersion,
  parseDotnetVersion,
  parseListSdks,
  type RoslynCap,
  type SdkListEntry,
} from './roslynSdkCap';

const PROBE_TIMEOUT_MS = 10_000;

export function resolveSdkRoot(activeVersion: string, sdks: SdkListEntry[]): string | undefined {
  if (!activeVersion) return undefined;
  const match = sdks.find((s) => s.version === activeVersion);
  if (!match) return undefined;
  return path.join(match.directory, match.version);
}

export type RoslynProbeRunner = Pick<CliRunner, 'run'>;

/**
 * Resolves the Roslyn version bundled with the SDK that `dotnet --version`
 * selected (`global.json` included via `cwd`).
 */
export class RoslynSdkProbe {
  constructor(
    private readonly runner: RoslynProbeRunner,
    private readonly fileExists: (filePath: string) => boolean = (p) => fs.existsSync(p),
  ) {}

  async probe(cwd: string): Promise<RoslynCap | null> {
    const versionResult = await this.runner.run({
      args: ['--version'],
      cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (versionResult.timedOut || versionResult.cancelled || versionResult.exitCode !== 0) {
      return null;
    }
    const sdkVersion = parseDotnetVersion(versionResult.stdout);
    if (!sdkVersion) return null;

    const listResult = await this.runner.run({
      args: ['--list-sdks'],
      cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (listResult.timedOut || listResult.cancelled || listResult.exitCode !== 0) {
      return null;
    }
    const sdkRoot = resolveSdkRoot(sdkVersion, parseListSdks(listResult.stdout));
    if (!sdkRoot) return null;

    const cscPath = path.join(sdkRoot, 'Roslyn', 'bincore', 'csc.dll');
    if (!this.fileExists(cscPath)) return null;

    const cscResult = await this.runner.run({
      args: ['exec', cscPath, '-version'],
      cwd,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (cscResult.timedOut || cscResult.cancelled || cscResult.exitCode !== 0) {
      return null;
    }
    const compilerVersion = parseCscNumericVersion(`${cscResult.stdout}\n${cscResult.stderr}`);
    if (!compilerVersion) return null;

    return { sdkVersion, compilerVersion };
  }
}
