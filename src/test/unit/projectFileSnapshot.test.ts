import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  snapshotProjectFiles,
  restoreFileSnapshots,
  readPackageVersionFromXml,
  readPackageVersionFromSnapshots,
} from '../../projectFileSnapshot';

describe('projectFileSnapshot', () => {
  it('reads PackageReference Version attribute', () => {
    const xml = `<Project><ItemGroup>
      <PackageReference Include="EFCore.NamingConventions" Version="10.0.0" />
    </ItemGroup></Project>`;
    expect(readPackageVersionFromXml(xml, 'EFCore.NamingConventions')).toBe('10.0.0');
  });

  it('reads PackageVersion from Directory.Packages.props', () => {
    const xml = `<Project><ItemGroup>
      <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
    </ItemGroup></Project>`;
    expect(readPackageVersionFromXml(xml, 'Newtonsoft.Json')).toBe('13.0.3');
  });

  it('snapshots csproj and restores previous content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-snap-'));
    const csproj = path.join(dir, 'App.csproj');
    const original = '<Project><PackageReference Include="Pkg" Version="1.0.0" /></Project>';
    await fs.writeFile(csproj, original, 'utf8');

    const snapshots = await snapshotProjectFiles(csproj);
    expect(readPackageVersionFromSnapshots(snapshots, 'Pkg')).toBe('1.0.0');

    await fs.writeFile(csproj, '<Project><PackageReference Include="Pkg" Version="2.0.0" /></Project>', 'utf8');
    await restoreFileSnapshots(snapshots);

    expect(await fs.readFile(csproj, 'utf8')).toBe(original);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
