import { unresolvedForProject, unresolvedReferences, wasAboutAnotherVersion, type UnresolvedDeps } from '../../unresolvedReferences';
import type { RestoreOutcome } from '../../restoreOutcome';
import type { InstalledPackage } from '../../types';

const PROJECT = 'D:/src/Example.Shop/Example.Shop.csproj';
const OTHER = 'D:/src/Example.Shop/Example.Shop.Worker.csproj';

const xml = (refs: string) => `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>${refs}</ItemGroup></Project>`;
const ref = (id: string, version: string, extra = '') => `<PackageReference Include="${id}" Version="${version}"${extra} />`;

const listed = (id: string, projectPath = PROJECT): InstalledPackage => ({
  id, requestedVersion: '1.0.0', resolvedVersion: '1.0.0', projectPath,
});

const failure = (code: string, libraryId: string, message = `${code} for ${libraryId}`, frameworks = ['net8.0']) => ({
  code, libraryId, message, frameworks,
});

function deps(over: {
  project?: string | null;
  projectMtime?: number;
  props?: string | null;
  propsMtime?: number;
  outcome?: RestoreOutcome | null;
} = {}): UnresolvedDeps {
  return {
    readProject: async () => (over.project === null ? null : { xml: over.project ?? xml(''), mtimeMs: over.projectMtime ?? 100, path: PROJECT }),
    readProps: async () => (over.props ? { xml: over.props, mtimeMs: over.propsMtime ?? 100, path: 'D:/src/Directory.Packages.props' } : null),
    readOutcome: async () => (over.outcome === undefined ? { success: true, failures: [], writtenAt: 200 } : over.outcome),
  };
}

describe('the references restore could not resolve (#138)', () => {
  it('gives a row to a reference restore failed on with NU1101, with the declared version and restore\'s own words', async () => {
    const rows = await unresolvedForProject(PROJECT, [listed('Serilog')], deps({
      project: xml(ref('Serilog', '4.2.0') + ref('Example.NoSuchPackage.Ghost', '1.0.0')),
      outcome: { success: false, failures: [failure('NU1101', 'Example.NoSuchPackage.Ghost', 'Unable to find package')], writtenAt: 200 },
    }));

    expect(rows).toEqual([{
      id: 'Example.NoSuchPackage.Ghost', requestedVersion: '1.0.0', resolvedVersion: '1.0.0', projectPath: PROJECT,
      unresolved: { code: 'NU1101', message: 'Unable to find package', frameworks: ['net8.0'] },
    }]);
  });

  it('does the same for NU1102, a version that does not exist rather than a package that does not', async () => {
    const rows = await unresolvedForProject(PROJECT, [listed('Serilog')], deps({
      project: xml(ref('Serilog', '4.2.0') + ref('Newtonsoft.Json', '99.99.99')),
      outcome: { success: false, failures: [failure('NU1102', 'Newtonsoft.Json')], writtenAt: 200 },
    }));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'Newtonsoft.Json', resolvedVersion: '99.99.99', unresolved: { code: 'NU1102' } });
  });

  it('gives no row to a project that restored cleanly', async () => {
    const rows = await unresolvedForProject(PROJECT, [listed('Serilog'), listed('Example.A')], deps({
      project: xml(ref('Serilog', '4.2.0') + ref('Example.A', '1.0.0')),
    }));

    expect(rows).toEqual([]);
  });

  it('matches the log\'s id to the project file\'s reference whatever the casing', async () => {
    const rows = await unresolvedForProject(PROJECT, [], deps({
      project: xml(ref('Example.NoSuchPackage.Ghost', '1.0.0')),
      outcome: { success: false, failures: [failure('NU1101', 'example.nosuchpackage.ghost')], writtenAt: 200 },
    }));

    expect(rows.map((r) => r.id)).toEqual(['Example.NoSuchPackage.Ghost']);
  });

  it('does not count a reference the listing has, whatever the casing', async () => {
    const rows = await unresolvedForProject(PROJECT, [listed('SERILOG')], deps({
      project: xml(ref('Serilog', '4.2.0')),
      outcome: { success: false, failures: [failure('NU1101', 'Serilog')], writtenAt: 200 },
    }));

    expect(rows).toEqual([]);
  });

  it('counts a package another project has listed as missing from this one', async () => {
    const rows = await unresolvedForProject(PROJECT, [listed('Example.A', OTHER)], deps({
      project: xml(ref('Example.A', '1.0.0')),
      outcome: { success: false, failures: [failure('NU1101', 'Example.A')], writtenAt: 200 },
    }));

    expect(rows).toHaveLength(1);
  });

  describe('a cache that says nothing', () => {
    it('is no rows when it is missing: nothing known is never nothing wrong', async () => {
      const rows = await unresolvedForProject(PROJECT, [], deps({ project: xml(ref('Example.A', '1.0.0')), outcome: null }));
      expect(rows).toEqual([]);
    });

    it('is no rows and no error when it cannot be read, for the whole scope', async () => {
      const rows = await unresolvedReferences([PROJECT, OTHER], [], {
        ...deps({ project: xml(ref('Example.A', '1.0.0')) }),
        readOutcome: async () => { throw new Error('EACCES'); },
      });
      expect(rows).toEqual([]);
    });

    it('is no rows when the project file cannot be read', async () => {
      expect(await unresolvedForProject(PROJECT, [], deps({ project: null }))).toEqual([]);
    });
  });

  describe('a reference added after the last restore', () => {
    it('is shown as not restored yet, with no reason, when the project file is newer than the cache', async () => {
      const rows = await unresolvedForProject(PROJECT, [listed('Serilog')], deps({
        project: xml(ref('Serilog', '4.2.0') + ref('Example.Telemetry.Client', '1.2.0')),
        projectMtime: 300,
        outcome: { success: true, failures: [], writtenAt: 200 },
      }));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'Example.Telemetry.Client', resolvedVersion: '1.2.0', unresolved: { notRestored: true } });
      expect(rows[0].unresolved?.code).toBeUndefined();
      expect(rows[0].unresolved?.message).toBeUndefined();
    });

    it('counts a central version edited after restore as well, since that is where the version lives', async () => {
      const rows = await unresolvedForProject(PROJECT, [], deps({
        project: xml('<PackageReference Include="Example.A" />'),
        props: '<Project><PackageVersion Include="Example.A" Version="1.0.0" /></Project>',
        propsMtime: 300,
        outcome: { success: true, failures: [], writtenAt: 200 },
      }));

      expect(rows).toEqual([expect.objectContaining({ id: 'Example.A', resolvedVersion: '1.0.0', unresolved: { notRestored: true } })]);
    });

    it('is not claimed when the cache is newer than the project file: nothing explains why it is absent', async () => {
      const rows = await unresolvedForProject(PROJECT, [], deps({
        project: xml(ref('Example.A', '1.0.0')), projectMtime: 100,
        outcome: { success: true, failures: [], writtenAt: 200 },
      }));

      expect(rows).toEqual([]);
    });

    it('is not claimed for a reference with a Condition, which may simply not apply', async () => {
      const rows = await unresolvedForProject(PROJECT, [], deps({
        project: xml(ref('Example.A', '1.0.0', ` Condition="'$(UseIt)' == 'true'"`)), projectMtime: 300,
        outcome: { success: true, failures: [], writtenAt: 200 },
      }));

      expect(rows).toEqual([]);
    });

    it('drops an NU1102 message once the version it was about has been edited: an old answer does not stand beside a new question', async () => {
      const rows = await unresolvedForProject(PROJECT, [], deps({
        // the log says 99.99.99; the project says 13.0.3 now and has not been restored since
        project: xml(ref('Newtonsoft.Json', '13.0.3')), projectMtime: 300,
        outcome: {
          success: false, writtenAt: 200,
          failures: [failure('NU1102', 'Newtonsoft.Json', 'Unable to find package Newtonsoft.Json with version (>= 99.99.99)')],
        },
      }));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ resolvedVersion: '13.0.3', unresolved: { notRestored: true } });
      expect(rows[0].unresolved?.message).toBeUndefined();
    });

    it('keeps an NU1102 message while the version it was about is still the declared one, though the file was edited for something else', async () => {
      const rows = await unresolvedForProject(PROJECT, [], deps({
        project: xml(ref('Newtonsoft.Json', '99.99.99')), projectMtime: 300,
        outcome: {
          success: false, writtenAt: 200,
          failures: [failure('NU1102', 'Newtonsoft.Json', 'Unable to find package Newtonsoft.Json with version (>= 99.99.99)')],
        },
      }));

      expect(rows[0].unresolved).toMatchObject({ code: 'NU1102' });
    });

    it('keeps an NU1101 message after the version is edited: it is about the id, and an edit to the version leaves it as true as it was', async () => {
      const rows = await unresolvedForProject(PROJECT, [], deps({
        project: xml(ref('Example.NoSuchPackage.Ghost', '2.0.0')), projectMtime: 300,
        outcome: {
          success: false, writtenAt: 200,
          failures: [failure('NU1101', 'Example.NoSuchPackage.Ghost', 'Unable to find package Example.NoSuchPackage.Ghost. No packages exist with this id in source(s): nuget.org')],
        },
      }));

      expect(rows[0].unresolved).toMatchObject({ code: 'NU1101' });
    });

    it('does not take an edit to a version the log never named for a reason to drop the message', async () => {
      const rows = await unresolvedForProject(PROJECT, [], deps({
        project: xml(ref('Example.A', '2.0.0')), projectMtime: 300,
        outcome: { success: false, failures: [failure('NU1101', 'Example.A', 'Unable to find package')], writtenAt: 200 },
      }));

      expect(rows[0].unresolved?.notRestored).toBeUndefined();
    });

    it('is not what a reference with an error in the log is: that has a reason', async () => {
      const rows = await unresolvedForProject(PROJECT, [], deps({
        project: xml(ref('Example.A', '1.0.0')), projectMtime: 300,
        outcome: { success: false, failures: [failure('NU1101', 'Example.A')], writtenAt: 200 },
      }));

      expect(rows[0].unresolved).toMatchObject({ code: 'NU1101' });
      expect(rows[0].unresolved?.notRestored).toBeUndefined();
    });
  });

  it('answers per project over a whole scope, once for a project listed twice', async () => {
    const perProject: UnresolvedDeps = {
      readProject: async (p) => ({ xml: xml(ref('Example.Ghost', '1.0.0')), mtimeMs: 100, path: p }),
      readProps: async () => null,
      readOutcome: async (p) => (p === PROJECT
        ? { success: false, failures: [failure('NU1101', 'Example.Ghost')], writtenAt: 200 }
        : { success: true, failures: [], writtenAt: 200 }),
    };

    const rows = await unresolvedReferences([PROJECT, PROJECT, OTHER], [], perProject);

    expect(rows.map((r) => r.projectPath)).toEqual([PROJECT]);
  });
});

describe('whether a restore message was about another version than the one declared (#138)', () => {
  // The message formats below were measured with `dotnet restore` on the English SDK.
  it('reads a bare version, an exact one and a range from the normalized range at the end of the message', () => {
    expect(wasAboutAnotherVersion('Unable to find package X with version (>= 99.99.99)', '13.0.3')).toBe(true);
    expect(wasAboutAnotherVersion('Unable to find package X with version (>= 99.99.99)', '99.99.99')).toBe(false);

    expect(wasAboutAnotherVersion('Unable to find package X with version (= 99.99.99)', '[13.0.3]')).toBe(true);
    expect(wasAboutAnotherVersion('Unable to find package X with version (= 99.99.99)', '[99.99.99]')).toBe(false);

    expect(wasAboutAnotherVersion('Unable to find package X with version (>= 98.0.0 && < 99.0.0)', '[98.0.0, 99.0.0)')).toBe(false);
    expect(wasAboutAnotherVersion('Unable to find package X with version (>= 98.0.0 && < 99.0.0)', '[12.0.0, 13.0.0)')).toBe(true);

    expect(wasAboutAnotherVersion('Unable to find package X with version (> 97.0.0)', '(97.0.0, )')).toBe(false);
    expect(wasAboutAnotherVersion('Unable to find package X with version (> 97.0.0)', '(5.0.0, )')).toBe(true);
  });

  it('does not depend on the language the SDK wrote the sentence in', () => {
    expect(wasAboutAnotherVersion('Не вдалося знайти пакет X із версією (>= 99.99.99)', '13.0.3')).toBe(true);
    expect(wasAboutAnotherVersion('Paket X mit Version (>= 99.99.99) wurde nicht gefunden', '99.99.99')).toBe(false);
  });

  it('takes a different spelling of the same version for the same version', () => {
    expect(wasAboutAnotherVersion('with version (>= 6.8.1)', '6.8.1.0')).toBe(false);
  });

  it('leaves the message alone when there is nothing to compare', () => {
    expect(wasAboutAnotherVersion('Unable to find package X. No packages exist with this id', '13.0.3')).toBe(false);
    expect(wasAboutAnotherVersion('with version (>= 1.0.0)', '1.*')).toBe(false);
    expect(wasAboutAnotherVersion('with version (>= 1.0.0)', '')).toBe(false);
    expect(wasAboutAnotherVersion('with version (< 2.0.0)', '[1.0.0, 3.0.0)')).toBe(false);
  });
});
