/**
 * Windows DPAPI for nuget.config `<add key="Password" />`.
 * Matches NuGet.Configuration EncryptionUtility: UTF-8 entropy "NuGet", CurrentUser.
 * Non-Windows: NuGet only supports ClearTextPassword.
 */

import { spawn } from 'child_process';
import * as path from 'path';

export function supportsEncryptedNuGetPasswords(): boolean {
  return process.platform === 'win32';
}

function powershellPath(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const PROTECT = [
  'Add-Type -AssemblyName System.Security',
  "$ErrorActionPreference = 'Stop'",
  '$b64 = [Console]::In.ReadToEnd().Trim()',
  '$plain = [Convert]::FromBase64String($b64)',
  "$entropy = [Text.Encoding]::UTF8.GetBytes('NuGet')",
  '$enc = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Convert]::ToBase64String($enc)',
].join('; ');

const UNPROTECT = [
  'Add-Type -AssemblyName System.Security',
  "$ErrorActionPreference = 'Stop'",
  '$b64 = [Console]::In.ReadToEnd().Trim()',
  '$enc = [Convert]::FromBase64String($b64)',
  "$entropy = [Text.Encoding]::UTF8.GetBytes('NuGet')",
  '$plain = [Security.Cryptography.ProtectedData]::Unprotect($enc, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Convert]::ToBase64String($plain)',
].join('; ');

function runDpapi(command: string, stdinAscii: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (c: string) => stdout.push(c));
    child.stderr?.on('data', (c: string) => stderr.push(c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('DPAPI encryption timed out.'));
    }, 15_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = stdout.join('').trim();
      if (code !== 0 || !out) {
        reject(new Error(stderr.join('').trim() || `DPAPI failed (exit ${code ?? 'null'}).`));
        return;
      }
      resolve(out.replace(/\s+/g, ''));
    });
    child.stdin?.end(stdinAscii, 'utf-8');
  });
}

/** Encrypt a feed password the way NuGet writes `Password` on Windows. */
export async function encryptNuGetConfigPassword(plain: string): Promise<string> {
  if (!supportsEncryptedNuGetPasswords()) {
    throw new Error('Encrypted nuget.config passwords are only supported on Windows.');
  }
  return runDpapi(PROTECT, Buffer.from(plain, 'utf8').toString('base64'));
}

/** Decrypt a NuGet `Password` blob (tests / round-trip). Never send this to the webview. */
export async function decryptNuGetConfigPassword(blob: string): Promise<string> {
  if (!supportsEncryptedNuGetPasswords()) {
    throw new Error('Encrypted nuget.config passwords are only supported on Windows.');
  }
  const b64 = await runDpapi(UNPROTECT, blob.trim());
  return Buffer.from(b64, 'base64').toString('utf8');
}
