import {
  declaredFrameworks,
  frameworksToUpdate,
  hasSharedReference,
  isFrameworkScopedReference,
  referenceConditions,
  versionForFramework,
} from '../../frameworkConditions';

/** The Core project of demo/multi-tfm — conditions on the ItemGroup. */
const GROUP_CONDITIONS = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net9.0;net10.0</TargetFrameworks>
  </PropertyGroup>

  <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
    <PackageReference Include="Microsoft.Extensions.Http" Version="9.0.0" />
    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="9.0.0" />
  </ItemGroup>

  <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
    <PackageReference Include="Microsoft.Extensions.Http" Version="10.0.0" />
    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="10.0.0" />
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
  </ItemGroup>
</Project>`;

/** The Workers project — conditions on the PackageReference element. */
const ELEMENT_CONDITIONS = `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="8.0.0" Condition="'$(TargetFramework)' == 'net8.0'" />
    <PackageReference Include="Microsoft.Extensions.Logging.Abstractions" Version="10.0.0" Condition="'$(TargetFramework)' == 'net10.0'" />
    <PackageReference Include="Serilog" Version="3.1.0" />
  </ItemGroup>
</Project>`;

describe('referenceConditions', () => {
  it('reads a condition off the enclosing ItemGroup', () => {
    expect(referenceConditions(GROUP_CONDITIONS, 'Microsoft.Extensions.Http')).toEqual([
      { framework: 'net9.0', version: '9.0.0' },
      { framework: 'net10.0', version: '10.0.0' },
    ]);
  });

  it('reads a condition off the PackageReference element', () => {
    expect(referenceConditions(ELEMENT_CONDITIONS, 'Microsoft.Extensions.Logging.Abstractions')).toEqual([
      { framework: 'net8.0', version: '8.0.0' },
      { framework: 'net10.0', version: '10.0.0' },
    ]);
  });

  it('reports an unconditional reference as neither framework-scoped nor unknown', () => {
    expect(referenceConditions(GROUP_CONDITIONS, 'Newtonsoft.Json')).toEqual([{ version: '13.0.1' }]);
    expect(referenceConditions(ELEMENT_CONDITIONS, 'Serilog')).toEqual([{ version: '3.1.0' }]);
  });

  it('does not attribute a sibling group condition to a reference outside it', () => {
    // Serilog sits in the plain ItemGroup that follows the conditional ones.
    const xml = `<Project>
  <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
    <PackageReference Include="Foo" Version="1.0.0" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Serilog" Version="3.1.0" />
  </ItemGroup>
</Project>`;
    expect(referenceConditions(xml, 'Serilog')).toEqual([{ version: '3.1.0' }]);
  });

  it('accepts the spacing and ordering variants a hand-written project uses', () => {
    const xml = `<Project>
  <ItemGroup Condition="'$(TargetFramework)'=='net9.0'">
    <PackageReference Include="Foo" Version="1.0.0" />
  </ItemGroup>
  <ItemGroup Condition=" 'net10.0' == '$(TargetFramework)' ">
    <PackageReference Include="Foo" Version="2.0.0" />
  </ItemGroup>
  <ItemGroup Condition="$(TargetFramework) == 'net8.0'">
    <PackageReference Include="Foo" Version="3.0.0" />
  </ItemGroup>
</Project>`;
    expect(referenceConditions(xml, 'Foo')).toEqual([
      { framework: 'net9.0', version: '1.0.0' },
      { framework: 'net10.0', version: '2.0.0' },
      { framework: 'net8.0', version: '3.0.0' },
    ]);
  });

  it('refuses to read a negated condition as a pin', () => {
    const xml = `<Project>
  <ItemGroup Condition="'$(TargetFramework)' != 'net9.0'">
    <PackageReference Include="Foo" Version="1.0.0" />
  </ItemGroup>
</Project>`;
    expect(referenceConditions(xml, 'Foo')).toEqual([{ unknown: true, version: '1.0.0' }]);
  });

  it('refuses a condition built on anything other than the framework', () => {
    const xml = `<Project>
  <ItemGroup Condition="'$(Configuration)' == 'Debug'">
    <PackageReference Include="Foo" Version="1.0.0" />
  </ItemGroup>
</Project>`;
    expect(referenceConditions(xml, 'Foo')).toEqual([{ unknown: true, version: '1.0.0' }]);
  });

  it('is not fooled by an ItemGroup named inside a comment (#85)', () => {
    const xml = `<Project>
  <!-- <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'"> was here once -->
  <ItemGroup>
    <PackageReference Include="Foo" Version="1.0.0" />
  </ItemGroup>
</Project>`;
    expect(referenceConditions(xml, 'Foo')).toEqual([{ version: '1.0.0' }]);
  });

  it('says nothing about a package the project does not reference', () => {
    expect(referenceConditions(GROUP_CONDITIONS, 'Dapper')).toEqual([]);
  });
});

describe('frameworksToUpdate', () => {
  it('lists both conditional groups, so each is written on its own', () => {
    expect(frameworksToUpdate(GROUP_CONDITIONS, 'Microsoft.Extensions.Http'))
      .toEqual(['net9.0', 'net10.0']);
    expect(frameworksToUpdate(ELEMENT_CONDITIONS, 'Microsoft.Extensions.Logging.Abstractions'))
      .toEqual(['net8.0', 'net10.0']);
  });

  it('is empty for an unconditional reference — one plain write, as before', () => {
    expect(frameworksToUpdate(GROUP_CONDITIONS, 'Newtonsoft.Json')).toEqual([]);
  });

  it('is empty for a package that is not there yet', () => {
    expect(frameworksToUpdate(GROUP_CONDITIONS, 'Dapper')).toEqual([]);
  });

  it('falls back to the plain write when any condition is unreadable', () => {
    const xml = `<Project>
  <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
    <PackageReference Include="Foo" Version="1.0.0" />
  </ItemGroup>
  <ItemGroup Condition="'$(Configuration)' == 'Debug'">
    <PackageReference Include="Foo" Version="2.0.0" />
  </ItemGroup>
</Project>`;
    expect(frameworksToUpdate(xml, 'Foo')).toEqual([]);
  });

  it('falls back when one reference is conditional and another is not', () => {
    const xml = `<Project>
  <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
    <PackageReference Include="Foo" Version="1.0.0" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Foo" Version="2.0.0" />
  </ItemGroup>
</Project>`;
    expect(frameworksToUpdate(xml, 'Foo')).toEqual([]);
  });

  it('does not repeat a framework that carries two references', () => {
    const xml = `<Project>
  <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
    <PackageReference Include="Foo" Version="1.0.0" />
    <PackageReference Include="Foo" Version="1.0.0" />
  </ItemGroup>
</Project>`;
    expect(frameworksToUpdate(xml, 'Foo')).toEqual(['net9.0']);
  });
});

describe('frameworksToUpdate, narrowed to a version line', () => {
  it('writes only the group already in the target version line', () => {
    // A 9.x target belongs to the net9.0 group; the net10.0 group is not its business.
    expect(frameworksToUpdate(GROUP_CONDITIONS, 'Microsoft.Extensions.Http', '9.0.20'))
      .toEqual(['net9.0']);
    expect(frameworksToUpdate(GROUP_CONDITIONS, 'Microsoft.Extensions.Http', '10.0.12'))
      .toEqual(['net10.0']);
  });

  it('writes every group when they share the target line', () => {
    // Two conditional groups both on 13.x: a 13.0.4 target is for both of them.
    const xml = `<Project>
  <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
    <PackageReference Include="Foo" Version="13.0.1" />
  </ItemGroup>
  <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
    <PackageReference Include="Foo" Version="13.0.2" />
  </ItemGroup>
</Project>`;
    expect(frameworksToUpdate(xml, 'Foo', '13.0.4')).toEqual(['net9.0', 'net10.0']);
  });

  it('keeps a group whose own version cannot be read rather than skipping it', () => {
    const xml = `<Project>
  <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
    <PackageReference Include="Foo" />
  </ItemGroup>
</Project>`;
    expect(frameworksToUpdate(xml, 'Foo', '10.0.0')).toEqual(['net9.0']);
  });

  it('reads a version written as a child element', () => {
    const xml = `<Project>
  <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
    <PackageReference Include="Foo"><Version>9.0.0</Version></PackageReference>
  </ItemGroup>
</Project>`;
    expect(referenceConditions(xml, 'Foo')).toEqual([{ framework: 'net9.0', version: '9.0.0' }]);
  });

  it('does not mistake another attribute ending in Version for the version', () => {
    const xml = `<Project>
  <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
    <PackageReference Include="Foo" AssemblyVersion="1.2.3" Version="9.0.0" />
  </ItemGroup>
</Project>`;
    expect(referenceConditions(xml, 'Foo')).toEqual([{ framework: 'net9.0', version: '9.0.0' }]);
  });
});

describe('hasSharedReference', () => {
  it('is true for one unconditional reference', () => {
    expect(hasSharedReference(GROUP_CONDITIONS, 'Newtonsoft.Json')).toBe(true);
  });

  it('is false once every reference names its framework', () => {
    expect(hasSharedReference(GROUP_CONDITIONS, 'Microsoft.Extensions.Http')).toBe(false);
    expect(hasSharedReference(ELEMENT_CONDITIONS, 'Microsoft.Extensions.Logging.Abstractions')).toBe(false);
  });

  it('is false for a package the project does not reference', () => {
    expect(hasSharedReference(GROUP_CONDITIONS, 'Dapper')).toBe(false);
  });
});

describe('a group that is already at the target', () => {
  // The shape the fixture ended up in after a split: one framework moved on,
  // the other stayed behind on its own line.
  const AFTER_SPLIT = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net8.0;net10.0;net9.0</TargetFrameworks>
  </PropertyGroup>
  <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
    <PackageReference Include="Serilog" Version="4.4.0" />
  </ItemGroup>
  <ItemGroup Condition="'$(TargetFramework)' == 'net8.0'">
    <PackageReference Include="Serilog" Version="3.1.0" />
  </ItemGroup>
</Project>`;

  it('has nothing to write when the only group in the line is already there', () => {
    expect(frameworksToUpdate(AFTER_SPLIT, 'Serilog', '4.4.0')).toEqual([]);
  });

  it('still writes the group that is behind inside its own line', () => {
    expect(frameworksToUpdate(AFTER_SPLIT, 'Serilog', '3.1.1')).toEqual(['net8.0']);
  });

  it('lists both when no target narrows it', () => {
    expect(frameworksToUpdate(AFTER_SPLIT, 'Serilog')).toEqual(['net10.0', 'net8.0']);
  });

  it('knows every reference names a framework', () => {
    expect(isFrameworkScopedReference(AFTER_SPLIT, 'Serilog')).toBe(true);
    expect(isFrameworkScopedReference(GROUP_CONDITIONS, 'Newtonsoft.Json')).toBe(false);
    expect(isFrameworkScopedReference(GROUP_CONDITIONS, 'Dapper')).toBe(false);
  });

  it('reads one framework version without being confused by the others', () => {
    // The reason this exists: reading "the" version of a package with several
    // references answers with whichever comes first in the file.
    expect(versionForFramework(AFTER_SPLIT, 'Serilog', 'net8.0')).toBe('3.1.0');
    expect(versionForFramework(AFTER_SPLIT, 'Serilog', 'net10.0')).toBe('4.4.0');
    expect(versionForFramework(AFTER_SPLIT, 'Serilog', 'net9.0')).toBeUndefined();
  });
});

describe('the frameworks a project states (#82)', () => {
  it('reads a multi-targeted project', () => {
    expect(declaredFrameworks(GROUP_CONDITIONS)).toEqual(['net9.0', 'net10.0']);
  });

  it('reads a single-targeted project', () => {
    expect(declaredFrameworks(
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
    )).toEqual(['net10.0']);
  });

  it('says nothing when the value comes from a property', () => {
    // Rebuilding a shared reference from half the set would take the package
    // out of the frameworks left over, so a guess is worse than no answer.
    expect(declaredFrameworks(
      '<Project><PropertyGroup><TargetFrameworks>$(RepoTargetFrameworks)</TargetFrameworks></PropertyGroup></Project>',
    )).toEqual([]);
  });

  it('says nothing when two elements state it', () => {
    // One of them is conditioned on something only MSBuild can evaluate, so
    // which one wins is not for a regex to decide.
    expect(declaredFrameworks(
      '<Project><PropertyGroup Condition="true"><TargetFrameworks>net10.0</TargetFrameworks></PropertyGroup>'
      + '<PropertyGroup><TargetFrameworks>net8.0;net10.0</TargetFrameworks></PropertyGroup></Project>',
    )).toEqual([]);
  });

  it('ignores a commented-out declaration', () => {
    expect(declaredFrameworks(
      '<Project><PropertyGroup><!-- <TargetFrameworks>net6.0</TargetFrameworks> -->'
      + '<TargetFrameworks>net8.0;net10.0</TargetFrameworks></PropertyGroup></Project>',
    )).toEqual(['net8.0', 'net10.0']);
  });

  it('says nothing when the project states none', () => {
    expect(declaredFrameworks('<Project Sdk="Microsoft.NET.Sdk"></Project>')).toEqual([]);
  });
});
