import * as path from 'path';
import { classifyConfigSources, isLocalSourceValue } from '../../localPackageSources';

const CONFIG = path.join('C:', 'cfg', 'nuget.config');
const resolved = (p: string) => path.resolve(path.dirname(CONFIG), p);

describe('isLocalSourceValue', () => {
  it('treats a path as local and a feed as not', () => {
    expect(isLocalSourceValue('C:\\Program Files (x86)\\Microsoft SDKs\\NuGetPackages\\')).toBe(true);
    expect(isLocalSourceValue('\\\\build\\drops\\packages')).toBe(true);
    expect(isLocalSourceValue('../packages')).toBe(true);
    expect(isLocalSourceValue('https://api.nuget.org/v3/index.json')).toBe(false);
    expect(isLocalSourceValue('http://nexus.corp/repository/nuget')).toBe(false);
  });

  it('does not claim a file:// url as a folder — resolving it is more ways to be wrong than the call it saves', () => {
    expect(isLocalSourceValue('file:///C:/packages')).toBe(false);
  });
});

describe('classifyConfigSources', () => {
  it('reads the real Microsoft.VisualStudio.Offline.config shape as folder-only', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="Microsoft Visual Studio Offline Packages" value="C:\\Program Files (x86)\\Microsoft SDKs\\NuGetPackages\\"/>
  </packageSources>
</configuration>`;
    expect(classifyConfigSources(xml, CONFIG)).toEqual({
      folders: [path.resolve('C:\\Program Files (x86)\\Microsoft SDKs\\NuGetPackages\\')],
      hasNonLocal: false,
    });
  });

  it('marks a config with any feed as non-local, so it is always asked', () => {
    const xml = `<configuration><packageSources>
      <add key="local" value="../drops" />
      <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
    </packageSources></configuration>`;
    expect(classifyConfigSources(xml, CONFIG).hasNonLocal).toBe(true);
  });

  it('resolves a relative folder against the config file, not the process cwd', () => {
    const xml = '<configuration><packageSources><add key="drops" value="../drops" /></packageSources></configuration>';
    expect(classifyConfigSources(xml, CONFIG).folders).toEqual([resolved('../drops')]);
  });

  it('ignores a source disabled elsewhere in the same file', () => {
    const xml = `<configuration>
      <packageSources>
        <add key="feed" value="https://corp/index.json" />
        <add key="drops" value="C:\\drops" />
      </packageSources>
      <disabledPackageSources><add key="feed" value="true" /></disabledPackageSources>
    </configuration>`;
    expect(classifyConfigSources(xml, CONFIG)).toEqual({
      folders: [path.resolve('C:\\drops')],
      hasNonLocal: false,
    });
  });

  it('does not read sources out of an XML comment (the #85 class of bug)', () => {
    const xml = `<configuration><packageSources>
      <!-- <add key="ghost" value="https://ghost/index.json" /> -->
      <add key="drops" value="C:\\drops" />
    </packageSources></configuration>`;
    expect(classifyConfigSources(xml, CONFIG)).toEqual({
      folders: [path.resolve('C:\\drops')],
      hasNonLocal: false,
    });
  });

  it('falls back to "ask the CLI" for an entry it cannot read', () => {
    const xml = '<configuration><packageSources><add value="C:\\drops" /></packageSources></configuration>';
    expect(classifyConfigSources(xml, CONFIG).hasNonLocal).toBe(true);
  });
});
