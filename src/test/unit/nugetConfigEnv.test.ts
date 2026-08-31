import { expandNuGetConfigValue } from '../../nugetConfigEnv';

describe('expandNuGetConfigValue', () => {
  const env = { HOME: '/home/dev', FEED_HOST: 'nexus.example' };

  it('expands %VAR% using the provided env', () => {
    expect(expandNuGetConfigValue('https://%FEED_HOST%/index.json', env)).toBe(
      'https://nexus.example/index.json',
    );
    expect(expandNuGetConfigValue('%HOME%/packages', env)).toBe('/home/dev/packages');
  });

  it('does not expand $VAR even on Unix-style values', () => {
    expect(expandNuGetConfigValue('$HOME/packages', env)).toBe('$HOME/packages');
  });

  it('keeps the literal token when the variable is missing', () => {
    expect(expandNuGetConfigValue('%MISSING%/pkgs', env)).toBe('%MISSING%/pkgs');
  });

  it('matches variable names case-insensitively', () => {
    expect(expandNuGetConfigValue('%home%/pkgs', env)).toBe('/home/dev/pkgs');
  });
});
