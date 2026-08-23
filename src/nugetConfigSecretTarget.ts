/**
 * Secrets (password / API key) are read from the whole nuget.config chain,
 * but writes never go closer than the user/global config.
 * Workspace files only lose leftover secret blocks so they cannot override user config.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  getGlobalNuGetConfigDir,
  getLegacyGlobalNuGetConfigDir,
  isGlobalNuGetConfigPath,
  isMachineWideNuGetConfigPath,
} from './nugetConfigChainResolver';
import {
  mergePackageSourceCredentials,
  patchNuGetConfigFile,
  readNuGetConfigText,
  setApiKeyEntry,
  setClearTextApiKeyEntry,
  writeSourceApiKey,
} from './nugetConfigEdit';
import { pathsEqual } from './pathCompare';

export const EMPTY_NUGET_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
</configuration>
`;

export type SecretWritePlan = {
  targetPath: string;
  /** Workspace (or other closer) file to strip after writing to user config. */
  stripPath?: string;
};

export function planSecretWrite(declaredFilePath: string, userConfigPath: string): SecretWritePlan {
  if (pathsEqual(declaredFilePath, userConfigPath) || isGlobalNuGetConfigPath(declaredFilePath)) {
    return { targetPath: declaredFilePath };
  }
  if (isMachineWideNuGetConfigPath(declaredFilePath)) {
    return { targetPath: userConfigPath };
  }
  return { targetPath: userConfigPath, stripPath: declaredFilePath };
}

export async function findNuGetConfigInDir(dir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const match = names.find((n) => n.toLowerCase() === 'nuget.config');
  return match ? path.join(dir, match) : undefined;
}

export async function resolveUserNuGetConfigPath(): Promise<string> {
  const found =
    (await findNuGetConfigInDir(getGlobalNuGetConfigDir()))
    ?? (await findNuGetConfigInDir(getLegacyGlobalNuGetConfigDir()));
  return found ?? path.join(getGlobalNuGetConfigDir(), 'NuGet.Config');
}

export async function ensureNuGetConfigFile(filePath: string): Promise<string> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, EMPTY_NUGET_CONFIG, 'utf-8');
  }
  return filePath;
}

export async function ensureUserNuGetConfigFile(): Promise<string> {
  return ensureNuGetConfigFile(await resolveUserNuGetConfigPath());
}

export async function writeSourceSecrets(opts: {
  declaredFilePath: string;
  userConfigPath: string;
  sourceName: string;
  sourceUrl: string;
  username?: string;
  password?: string;
  passwordEncrypted?: boolean;
  clearCredentials?: boolean;
  apiKey?: string | null;
}): Promise<{ targetPath: string; strippedDeclared: boolean }> {
  const plan = planSecretWrite(opts.declaredFilePath, opts.userConfigPath);
  await ensureNuGetConfigFile(plan.targetPath);

  const declaredXml = plan.stripPath
    ? await readNuGetConfigText(plan.stripPath).catch(() => '')
    : '';

  const writeCredentials = opts.clearCredentials || opts.username !== undefined;
  const writeApiKey = opts.apiKey !== undefined;

  if (writeCredentials) {
    await patchNuGetConfigFile(plan.targetPath, (xml) => mergePackageSourceCredentials(xml, opts.sourceName, {
      username: opts.username ?? '',
      password: opts.password,
      passwordEncrypted: opts.passwordEncrypted,
      clear: opts.clearCredentials,
      passwordFallbackXml: declaredXml || undefined,
    }));
    if (plan.stripPath) {
      await patchNuGetConfigFile(plan.stripPath, (xml) => mergePackageSourceCredentials(xml, opts.sourceName, {
        username: '',
        clear: true,
      })).catch(() => { /* declared file may already be gone */ });
    }
  }

  if (writeApiKey) {
    await writeSourceApiKey(plan.targetPath, opts.sourceUrl, opts.apiKey ?? null);
    if (plan.stripPath) {
      await patchNuGetConfigFile(plan.stripPath, (xml) => (
        setClearTextApiKeyEntry(setApiKeyEntry(xml, opts.sourceUrl, null), opts.sourceUrl, null)
      )).catch(() => { /* ignore */ });
    }
  }

  return { targetPath: plan.targetPath, strippedDeclared: !!plan.stripPath };
}
