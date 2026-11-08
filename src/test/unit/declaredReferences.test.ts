import { centralVersions, declaredReferences } from '../../declaredReferences';

const project = (items: string) => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  ${items}
</Project>`;

describe('declaredReferences (#138)', () => {
  it('lists the references the project file declares, with the version it states', () => {
    const xml = project(`<ItemGroup>
      <PackageReference Include="Serilog" Version="4.2.0" />
      <PackageReference Include="Example.NoSuchPackage.Ghost" Version="1.0.0" />
    </ItemGroup>`);

    expect(declaredReferences(xml)).toEqual([
      { id: 'Serilog', version: '4.2.0', conditional: false },
      { id: 'Example.NoSuchPackage.Ghost', version: '1.0.0', conditional: false },
    ]);
  });

  it('reads a version written as a child element, and either order of attributes', () => {
    const xml = project(`<ItemGroup>
      <PackageReference Version="2.0.0" Include="Example.A" />
      <PackageReference Include="Example.B"><Version>3.1.0</Version></PackageReference>
    </ItemGroup>`);

    expect(declaredReferences(xml).map((r) => [r.id, r.version])).toEqual([['Example.A', '2.0.0'], ['Example.B', '3.1.0']]);
  });

  it('takes the version from Directory.Packages.props when the project file carries none (central package management)', () => {
    const props = `<Project><ItemGroup>
      <PackageVersion Include="Example.A" Version="5.0.1" />
      <PackageVersion Version="6.0.0" Include="example.b" />
    </ItemGroup></Project>`;
    const xml = project(`<ItemGroup><PackageReference Include="Example.A" /><PackageReference Include="Example.B" /></ItemGroup>`);

    expect(declaredReferences(xml, props).map((r) => [r.id, r.version])).toEqual([['Example.A', '5.0.1'], ['Example.B', '6.0.0']]);
    expect(centralVersions(props).get('example.a')).toBe('5.0.1');
  });

  it('never shows an empty version when something states one: VersionOverride, then the central one', () => {
    const props = `<Project><PackageVersion Include="Example.A" Version="5.0.1" /></Project>`;
    const xml = project(`<ItemGroup><PackageReference Include="Example.A" VersionOverride="9.9.9" /></ItemGroup>`);
    expect(declaredReferences(xml, props)[0].version).toBe('9.9.9');
  });

  it('leaves the version empty when nothing states one', () => {
    expect(declaredReferences(project(`<ItemGroup><PackageReference Include="Example.A" /></ItemGroup>`))[0].version).toBe('');
  });

  it('does not count an Update item, an id written as a property, or a reference quoted in a comment', () => {
    const xml = project(`<ItemGroup>
      <PackageReference Update="Example.A" Version="2.0.0" />
      <PackageReference Include="$(PackageName)" Version="1.0.0" />
      <!-- <PackageReference Include="Example.Commented" Version="1.0.0" /> -->
      <PackageReference Include="Example.Real" Version="1.0.0" />
    </ItemGroup>`);

    expect(declaredReferences(xml).map((r) => r.id)).toEqual(['Example.Real']);
  });

  it('marks a reference conditional when it, or the group it sits in, has a Condition', () => {
    const xml = project(`<ItemGroup Condition="'$(Configuration)' == 'Debug'">
      <PackageReference Include="Example.InGroup" Version="1.0.0" />
    </ItemGroup>
    <ItemGroup>
      <PackageReference Include="Example.OnElement" Version="1.0.0" Condition="'$(UseIt)' == 'true'" />
      <PackageReference Include="Example.Plain" Version="1.0.0" />
    </ItemGroup>`);

    expect(declaredReferences(xml).map((r) => [r.id, r.conditional])).toEqual([
      ['Example.InGroup', true], ['Example.OnElement', true], ['Example.Plain', false],
    ]);
  });

  it('lists an id once, whatever its casing', () => {
    const xml = project(`<ItemGroup><PackageReference Include="Example.A" Version="1.0.0" /></ItemGroup>
      <ItemGroup><PackageReference Include="example.a" Version="2.0.0" /></ItemGroup>`);

    expect(declaredReferences(xml)).toHaveLength(1);
    expect(declaredReferences(xml)[0].version).toBe('1.0.0');
  });
});
