import { searchableConfigFiles } from '../../searchConfigFiles';
import type { NuGetConfigFile, PackageSource } from '../../types';

const source = (name: string, enabled: boolean, configFilePath: string): PackageSource =>
  ({ name, url: `https://example.com/${name}`, enabled, configFilePath });

const file = (filePath: string, sources: PackageSource[]): NuGetConfigFile =>
  ({ filePath, sources });

describe('searchableConfigFiles', () => {
  it('drops a config file that declares no sources at all', () => {
    // The real Microsoft.VisualStudio.FallbackLocation.config case: every query
    // against it exits 1 with "No package sources found."
    const chain = [
      file('C:/repo/nuget.config', [source('nuget.org', true, 'C:/repo/nuget.config')]),
      file('C:/Program Files (x86)/NuGet/Config/Microsoft.VisualStudio.FallbackLocation.config', []),
    ];
    expect(searchableConfigFiles(chain)).toEqual(['C:/repo/nuget.config']);
  });

  it('drops a config file whose every source is disabled in that same file', () => {
    const chain = [
      file('a.config', [source('corp', false, 'a.config'), source('old', false, 'a.config')]),
      file('b.config', [source('nuget.org', true, 'b.config')]),
    ];
    expect(searchableConfigFiles(chain)).toEqual(['b.config']);
  });

  it('keeps a file with at least one enabled source among disabled ones', () => {
    const chain = [file('a.config', [source('off', false, 'a.config'), source('on', true, 'a.config')])];
    expect(searchableConfigFiles(chain)).toEqual(['a.config']);
  });

  it('drops a file that failed to parse, since the resolver leaves it sourceless', () => {
    const broken: NuGetConfigFile = { filePath: 'broken.config', sources: [], parseError: 'Unexpected end of file' };
    expect(searchableConfigFiles([broken, file('ok.config', [source('nuget.org', true, 'ok.config')])]))
      .toEqual(['ok.config']);
  });

  it('preserves chain order for the files it keeps — the search loop stops at the first hit', () => {
    const chain = [
      file('near.config', [source('corp', true, 'near.config')]),
      file('empty.config', []),
      file('far.config', [source('nuget.org', true, 'far.config')]),
    ];
    expect(searchableConfigFiles(chain)).toEqual(['near.config', 'far.config']);
  });

  it('returns nothing when the whole chain is sourceless', () => {
    expect(searchableConfigFiles([file('a.config', []), file('b.config', [])])).toEqual([]);
    expect(searchableConfigFiles([])).toEqual([]);
  });
});
