import {
  detectProjectPackageStyle,
  isSdkStyleProject,
} from '../../projectPackageStyle';
import {
  countPackageReferences,
  removePackageReferences,
  upsertPackageReference,
} from '../../legacyPackageReference';

const ISSUE_LEGACY_CSPROJ = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="4.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Import Project="$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props" Condition="Exists('$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props')" />
  <PropertyGroup>
    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>
    <RuntimeIdentifier>win</RuntimeIdentifier>
  </PropertyGroup>
  <ItemGroup>
    <Reference Include="System" />
  </ItemGroup>
  <ItemGroup>
    <Compile Include="Program.cs" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.SignalR.Client.Core" Version="9.0.6" />
    <PackageReference Include="Microsoft.AspNetCore.SignalR.Client.Core" Version="10.0.11" />
    <PackageReference Include="Microsoft.AspNetCore.SignalR.Client.Core" Version="10.0.11" />
    <PackageReference Include="Microsoft.AspNetCore.SignalR.Client.Core" Version="10.0.11" />
    <PackageReference Include="Microsoft.AspNetCore.SignalR.Client.Core" Version="10.0.11" />
    <PackageReference Include="Microsoft.AspNetCore.SignalR.Client.Core" Version="9.0.6" />
    <PackageReference Include="Microsoft.AspNetCore.SignalR.Client.Core" Version="10.0.11" />
    <PackageReference Include="MongoDB.Driver" Version="3.4.0" />
    <PackageReference Include="MongoDB.Driver" Version="3.11.0" />
    <PackageReference Include="MongoDB.Driver" Version="3.11.0" />
    <PackageReference Include="MongoDB.Driver" Version="3.11.0" />
    <PackageReference Include="MongoDB.Driver" Version="3.4.0" />
    <PackageReference Include="MongoDB.Driver" Version="3.4.0" />
    <PackageReference Include="MongoDB.Driver" Version="3.4.0" />
    <PackageReference Include="MongoDB.Driver" Version="3.11.0" />
  </ItemGroup>
  <Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />
</Project>
`;

describe('detectProjectPackageStyle', () => {
  it('treats Project Sdk= as SDK, including net48', () => {
    const sdk48 = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>';
    const sdk8 = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>';
    expect(isSdkStyleProject(sdk48)).toBe(true);
    expect(detectProjectPackageStyle(sdk48, false)).toBe('sdk');
    expect(detectProjectPackageStyle(sdk8, false)).toBe('sdk');
  });

  it('treats ToolsVersion + PackageReference as legacy', () => {
    expect(detectProjectPackageStyle(ISSUE_LEGACY_CSPROJ, false)).toBe('legacy-packageref');
  });

  it('skips packages.config when the project is not SDK-style', () => {
    const xml = '<Project ToolsVersion="4.0"><PropertyGroup><TargetFrameworkVersion>v4.8</TargetFrameworkVersion></PropertyGroup></Project>';
    expect(detectProjectPackageStyle(xml, true)).toBe('packages-config');
  });

  it('uses the XML path when PackageReference exists even if packages.config is leftover', () => {
    const xml = `<Project ToolsVersion="4.0">
  <ItemGroup>
    <PackageReference Include="MongoDB.Driver" Version="3.4.0" />
  </ItemGroup>
</Project>`;
    expect(detectProjectPackageStyle(xml, true)).toBe('legacy-packageref');
  });

  it('prefers SDK over a leftover packages.config', () => {
    expect(detectProjectPackageStyle('<Project Sdk="Microsoft.NET.Sdk"></Project>', true)).toBe('sdk');
  });

  it('falls back to SDK when XML is empty so callers keep dotnet add', () => {
    expect(detectProjectPackageStyle('', false)).toBe('sdk');
  });

  it('falls back to SDK for a PackageReference fragment without a Project root', () => {
    expect(detectProjectPackageStyle(
      '<PackageReference Include="Pkg" Version="1.0.0" />',
      false,
    )).toBe('sdk');
  });

  it('is not misled by a comment mentioning Sdk= or PackageReference (#85)', () => {
    // A legacy project whose only "Sdk=" or "PackageReference" mention is
    // inside a migration-note comment must keep routing through the
    // XML-edit path, not `dotnet add` (which only legacy-packageref/sdk
    // detection gates).
    const legacyWithComment = `<Project ToolsVersion="4.0">
  <!-- migrated from Sdk="Microsoft.NET.Sdk" -->
  <ItemGroup>
    <!-- was <PackageReference Include="Old" Version="1.0.0" /> -->
    <PackageReference Include="MongoDB.Driver" Version="3.4.0" />
  </ItemGroup>
</Project>`;
    expect(isSdkStyleProject(legacyWithComment)).toBe(false);
    expect(detectProjectPackageStyle(legacyWithComment, false)).toBe('legacy-packageref');
  });
});

describe('upsertPackageReference', () => {
  it('heals duplicate MongoDB.Driver nodes from the issue fixture to a single 3.11.0', () => {
    const next = upsertPackageReference(ISSUE_LEGACY_CSPROJ, 'MongoDB.Driver', '3.11.0');
    expect(countPackageReferences(next, 'MongoDB.Driver')).toBe(1);
    expect(next).toContain('<PackageReference Include="MongoDB.Driver" Version="3.11.0" />');
    expect(next.match(/MongoDB\.Driver/g)).toHaveLength(1);
    expect(countPackageReferences(next, 'Microsoft.AspNetCore.SignalR.Client.Core')).toBe(7);
  });

  it('keeps child Version element shape', () => {
    const xml = `<Project>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json">
      <Version>12.0.1</Version>
    </PackageReference>
  </ItemGroup>
</Project>`;
    const next = upsertPackageReference(xml, 'Newtonsoft.Json', '13.0.3');
    expect(next).toContain('<Version>13.0.3</Version>');
    expect(next).not.toContain('12.0.1');
  });

  it('does not corrupt the file when a comment mentions <PackageReference> before a real non-self-closing element (#85)', () => {
    // The highest-severity #85 finding: the non-self-closing alternative's
    // lazy `[\s\S]*?` body capture treats the comment's bare `<PackageReference>`
    // mention as a fake opening tag and swallows through to the real
    // closing tag — `includeMatches` then finds the real `Include="Foo"`
    // inside that bogus span and accepts it, so the edit splices the file
    // starting mid-comment, silently truncating it.
    const xml = `<Project>
  <ItemGroup>
    <!-- remove <PackageReference> for Foo once upgraded -->
    <PackageReference Include="Foo">
      <PrivateAssets>all</PrivateAssets>
      <Version>1.0.0</Version>
    </PackageReference>
  </ItemGroup>
</Project>`;
    const next = upsertPackageReference(xml, 'Foo', '2.0.0');
    expect(next).toContain('<!-- remove <PackageReference> for Foo once upgraded -->');
    expect(next).toContain('<PrivateAssets>all</PrivateAssets>');
    expect(next).toContain('<Version>2.0.0</Version>');
    expect(next).not.toContain('<Version>1.0.0</Version>');
    expect(countPackageReferences(next, 'Foo')).toBe(1);
  });

  it('inserts a new id in a new unconditioned ItemGroup', () => {
    const xml = `<Project>
  <ItemGroup Condition="'$(Configuration)' == 'Debug'">
    <PackageReference Include="A" Version="1.0.0" />
  </ItemGroup>
</Project>`;
    const next = upsertPackageReference(xml, 'B', '2.0.0');
    expect(countPackageReferences(next, 'A')).toBe(1);
    expect(countPackageReferences(next, 'B')).toBe(1);
    expect(next).toMatch(/<ItemGroup>\s*<PackageReference Include="B" Version="2.0.0" \/>/);
    expect(next).toContain(`Condition="'$(Configuration)' == 'Debug'"`);
    expect(next.indexOf('Include="A"')).toBeLessThan(next.indexOf('Include="B"'));
  });
});

describe('removePackageReferences', () => {
  it('deletes every PackageReference for the id', () => {
    const next = removePackageReferences(ISSUE_LEGACY_CSPROJ, 'MongoDB.Driver');
    expect(countPackageReferences(next, 'MongoDB.Driver')).toBe(0);
    expect(countPackageReferences(next, 'Microsoft.AspNetCore.SignalR.Client.Core')).toBe(7);
  });

  it('does not delete a comment mentioning <PackageReference> along with the real element (#85)', () => {
    const xml = `<Project>
  <ItemGroup>
    <!-- was <PackageReference Include="Foo" Version="1.0.0" /> -->
    <PackageReference Include="Foo" Version="1.0.0" />
    <PackageReference Include="Bar" Version="2.0.0" />
  </ItemGroup>
</Project>`;
    const next = removePackageReferences(xml, 'Foo');
    expect(next).toContain('<!-- was <PackageReference Include="Foo" Version="1.0.0" /> -->');
    expect(countPackageReferences(next, 'Foo')).toBe(0);
    expect(countPackageReferences(next, 'Bar')).toBe(1);
  });
});
