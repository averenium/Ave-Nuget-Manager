import { nugetApiKeyExportCommand } from '../../nugetApiKeyEnv';

describe('nugetApiKeyExportCommand', () => {
  it('wraps the key in a POSIX export', () => {
    expect(nugetApiKeyExportCommand('oy2-plain')).toBe("export NUGET_API_KEY='oy2-plain'");
  });

  it('escapes single quotes for the shell', () => {
    expect(nugetApiKeyExportCommand("a'b")).toBe("export NUGET_API_KEY='a'\\''b'");
  });
});
