import {
  decryptNuGetConfigPassword,
  encryptNuGetConfigPassword,
  supportsEncryptedNuGetPasswords,
} from '../../nugetConfigDpapi';

describe('nugetConfigDpapi', () => {
  it('is Windows-only', () => {
    expect(supportsEncryptedNuGetPasswords()).toBe(process.platform === 'win32');
  });

  it('round-trips a password with NuGet DPAPI entropy on Windows', async () => {
    if (process.platform !== 'win32') return;
    const blob = await encryptNuGetConfigPassword('hunter2');
    expect(blob).not.toContain('hunter2');
    expect(blob).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(await decryptNuGetConfigPassword(blob)).toBe('hunter2');
  });
});
