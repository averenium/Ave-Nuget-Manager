import * as path from 'path';
import { sanitizeText, sanitizeXml, sanitizeFeedUrl, buildPathReplacements, defaultTraceZipName } from '../../traceSanitize';

const ctx = {
  home: 'C:\\Users\\lesov',
  workspaceRoots: ['C:\\Users\\lesov\\repo'],
  hostname: 'DEVBOX',
};

describe('sanitizeText', () => {
  it('rewrites the workspace root before home so the repo is not ~/repo', () => {
    const out = sanitizeText('C:\\Users\\lesov\\repo\\Foo.csproj and C:\\Users\\lesov\\.nuget\\packages', ctx);
    expect(out).toContain('<workspace>/Foo.csproj');
    expect(out).not.toContain('lesov');
    expect(out).toContain('~/.nuget/packages');
  });

  it('redacts emails, host, and password-style secrets', () => {
    const out = sanitizeText(
      'user@contoso.com on DEVBOX password=hunter2 apikey=abc ://u:p@feed.example/v3',
      ctx,
    );
    expect(out).toContain('<email>');
    expect(out).toContain('<host>');
    expect(out).toContain('password=<redacted>');
    expect(out).toContain('apikey=<redacted>');
    expect(out).toContain('://<redacted>@');
    expect(out).not.toContain('hunter2');
  });

  it('redacts JSON keys that contain password or apikey', () => {
    const out = sanitizeText('{"nugetApiKey":"leak","ok":1,"dbPassword":"pw"}', ctx);
    expect(out).not.toContain('leak');
    expect(out).not.toContain('"pw"');
    expect(out).toContain('"ok":1');
  });

  it('sorts replacements longest-first', () => {
    const rows = buildPathReplacements(ctx);
    expect(rows[0].from.length).toBeGreaterThanOrEqual(rows[1].from.length);
  });

  it('uses the same dest id for a project path, basename, and zip entry', () => {
    const aliased = {
      ...ctx,
      aliases: [{
        absPath: 'C:\\Users\\lesov\\repo\\src\\MyApp.csproj',
        dest: 'projects/p01.csproj',
      }],
    };
    const log = sanitizeText(
      'dotnet add C:\\Users\\lesov\\repo\\src\\MyApp.csproj package Newtonsoft.Json\nproject: MyApp.csproj',
      aliased,
    );
    expect(log).toContain('projects/p01.csproj');
    expect(log).not.toContain('MyApp');
    expect(log).not.toContain('lesov');
  });

  it('rewrites JSON-escaped Windows paths in jsonl to the dest id', () => {
    const aliased = {
      home: 'C:\\Users\\lesov',
      workspaceRoots: ['D:\\Repository\\AVE.ElectricityBot'],
      hostname: 'DEVBOX',
      aliases: [{
        absPath: 'D:\\Repository\\AVE.ElectricityBot\\AVE.ElectricityBot.Data\\AVE.ElectricityBot.Data.csproj',
        dest: 'projects/p04.csproj',
      }],
    };
    const jsonl = JSON.stringify({
      stdout: 'Failed to restore d:\\Repository\\AVE.ElectricityBot\\AVE.ElectricityBot.Data\\AVE.ElectricityBot.Data.csproj',
    });
    const out = sanitizeText(jsonl, aliased);
    expect(out).toContain('projects/p04.csproj');
    expect(out).not.toContain('ElectricityBot');
    expect(out).not.toContain('Repository');
    expect(out).not.toMatch(/[A-Za-z]:\/\//);
  });

  it('maps leftover doubled-slash drive paths onto the workspace', () => {
    const out = sanitizeText(
      'Failed to restore d://Repository//AVE.ElectricityBot//AVE.ElectricityBot.Data//p04.csproj',
      {
        home: 'C:\\Users\\lesov',
        workspaceRoots: ['D:\\Repository\\AVE.ElectricityBot'],
        hostname: 'DEVBOX',
      },
    );
    expect(out).toBe('Failed to restore <workspace>/AVE.ElectricityBot.Data/p04.csproj');
  });

  it('does not map a shared basename to a single dest', () => {
    const aliased = {
      ...ctx,
      aliases: [
        { absPath: 'C:\\Users\\lesov\\repo\\a\\Foo.csproj', dest: 'projects/p01.csproj' },
        { absPath: 'C:\\Users\\lesov\\repo\\b\\Foo.csproj', dest: 'projects/p02.csproj' },
      ],
    };
    const log = sanitizeText(
      'C:\\Users\\lesov\\repo\\a\\Foo.csproj then C:\\Users\\lesov\\repo\\b\\Foo.csproj',
      aliased,
    );
    expect(log).toContain('projects/p01.csproj');
    expect(log).toContain('projects/p02.csproj');
  });
});

describe('defaultTraceZipName', () => {
  it('includes local date and time', () => {
    const name = defaultTraceZipName(new Date(2026, 7, 21, 0, 31, 12));
    expect(name).toBe('nuget-manager-trace-2026-08-21_00-31-12.zip');
  });
});

describe('sanitizeFeedUrl', () => {
  it('leaves nuget.org alone', () => {
    const url = 'https://api.nuget.org/v3/index.json';
    expect(sanitizeFeedUrl(url)).toBe(url);
  });

  it('keeps Azure shape and redacts org/project/feed', () => {
    const out = sanitizeFeedUrl(
      'https://pkgs.dev.azure.com/myorg/myproject/_packaging/myfeed/nuget/v3/index.json',
    );
    expect(out).toContain('pkgs.dev.azure.com');
    expect(out).toContain('/<org>/<project>/_packaging/<feed>/nuget/v3/index.json');
    expect(out).not.toContain('myorg');
  });
});

describe('sanitizeXml', () => {
  it('drops packageSourceCredentials and HintPath bodies', () => {
    const xml = `
<configuration>
  <packageSources>
    <add key="private" value="https://pkgs.dev.azure.com/myorg/proj/_packaging/f/nuget/v3/index.json" />
  </packageSources>
  <packageSourceCredentials>
    <private>
      <add key="Username" value="pat" />
      <add key="ClearTextPassword" value="secret-token" />
    </private>
  </packageSourceCredentials>
  <HintPath>${path.join(ctx.home, 'libs', 'Foo.dll')}</HintPath>
</configuration>`;
    const out = sanitizeXml(xml, ctx);
    expect(out).not.toContain('secret-token');
    expect(out).not.toContain('packageSourceCredentials');
    expect(out).toContain('<HintPath><redacted></HintPath>');
    expect(out).toContain('<org>');
  });

  it('masks container registry and Windows registry settings in a csproj', () => {
    const xml = `
<Project>
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ContainerRegistry>myacr.azurecr.io</ContainerRegistry>
    <ContainerRepository>contoso/orders-api</ContainerRepository>
    <ContainerImageName>orders</ContainerImageName>
    <ContainerBaseImage>mcr.microsoft.com/dotnet/aspnet:8.0</ContainerBaseImage>
    <DockerfileContext>..\\docker</DockerfileContext>
    <ContainerPort>8080</ContainerPort>
    <EnableSdkContainerSupport>true</EnableSdkContainerSupport>
  </PropertyGroup>
  <ItemGroup>
    <ContainerEnvironmentVariable Include="ConnectionString" Value="Server=db;Password=x" />
    <ContainerLabel Include="org.opencontainers.image.source" Value="https://github.com/contoso/app" />
    <RegistryValue Key="HKLM\\Software\\Contoso" Name="InstallDir" Value="C:\\Apps" />
  </ItemGroup>
</Project>`;
    const out = sanitizeXml(xml, ctx);
    expect(out).toContain('net8.0');
    expect(out).toContain('<EnableSdkContainerSupport>true</EnableSdkContainerSupport>');
    expect(out).not.toContain('myacr.azurecr.io');
    expect(out).not.toContain('contoso');
    expect(out).not.toContain('orders-api');
    expect(out).not.toContain('HKLM');
    expect(out).toContain('<ContainerRegistry><redacted></ContainerRegistry>');
    expect(out).toContain('Value="<redacted>"');
  });

  it('masks elements and keys whose names contain password or apikey', () => {
    const xml = `
<Project>
  <SqlPassword>hunter2</SqlPassword>
  <NugetApiKey>nupkg-secret</NugetApiKey>
  <add key="ClearTextPassword" value="from-key" />
  <add key="MyApiKey" value="from-apikey" />
  <Item Include="REDIS_PASSWORD" Value="rpass" />
  <Foo DatabasePassword="db-secret" AzureApiKey="az-secret" />
</Project>`;
    const out = sanitizeXml(xml, ctx);
    expect(out).toContain('<SqlPassword><redacted></SqlPassword>');
    expect(out).toContain('<NugetApiKey><redacted></NugetApiKey>');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('nupkg-secret');
    expect(out).not.toContain('from-key');
    expect(out).not.toContain('from-apikey');
    expect(out).not.toContain('rpass');
    expect(out).not.toContain('db-secret');
    expect(out).not.toContain('az-secret');
  });

  it('rewrites relative ProjectReference and sln paths to dest ids', () => {
    const aliased = {
      ...ctx,
      aliases: [
        {
          absPath: 'C:\\Users\\lesov\\repo\\AVE.ElectricityBot.YasnoApi\\AVE.ElectricityBot.YasnoApi.csproj',
          dest: 'projects/p02.csproj',
        },
      ],
    };
    const xml = `<ProjectReference Include="..\\AVE.ElectricityBot.YasnoApi\\AVE.ElectricityBot.YasnoApi.csproj" />`;
    const xmlOut = sanitizeXml(xml, aliased);
    expect(xmlOut).toContain('Include="projects/p02.csproj"');
    expect(xmlOut).not.toContain('ElectricityBot');

    const leftover = `<ProjectReference Include="../AVE.ElectricityBot.YasnoApi/p02.csproj" />`;
    expect(sanitizeXml(leftover, aliased)).toContain('Include="projects/p02.csproj"');
    expect(sanitizeXml(leftover, aliased)).not.toContain('YasnoApi');

    const leftoverSln = `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "AVE.ElectricityBot", "AVE.ElectricityBot/p01.csproj", "{F52DED62-BBC2-4EDF-A95E-CD827B52867F}"`;
    const leftoverCtx = {
      ...ctx,
      aliases: [{
        absPath: 'C:\\Users\\lesov\\repo\\AVE.ElectricityBot\\AVE.ElectricityBot.csproj',
        dest: 'projects/p01.csproj',
      }],
    };
    const leftoverSlnOut = sanitizeXml(leftoverSln, leftoverCtx);
    expect(leftoverSlnOut).toBe(
      'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "p01", "projects/p01.csproj", "{F52DED62-BBC2-4EDF-A95E-CD827B52867F}"',
    );

    const sln = `Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "AVE.ElectricityBot.YasnoApi", "AVE.ElectricityBot.YasnoApi\\AVE.ElectricityBot.YasnoApi.csproj", "{GUID}"`;
    const slnOut = sanitizeText(sln, aliased);
    expect(slnOut).toContain('= "p02"');
    expect(slnOut).toContain('projects/p02.csproj');
    expect(slnOut).not.toContain('ElectricityBot');
  });

  it('rewrites slnx Path and fsproj ProjectReference to dest ids', () => {
    const aliased = {
      ...ctx,
      aliases: [
        {
          absPath: 'C:\\Users\\lesov\\repo\\Domain\\Domain.fsproj',
          dest: 'projects/p02.fsproj',
        },
        {
          absPath: 'C:\\Users\\lesov\\repo\\Api\\Api.csproj',
          dest: 'projects/p01.csproj',
        },
      ],
    };
    const slnx = `<Solution>
  <Project Path="src/Domain/Domain.fsproj" />
  <Project Path="Api/p01.csproj" Name="Api" />
</Solution>`;
    const slnxOut = sanitizeXml(slnx, aliased);
    expect(slnxOut).toContain('Path="projects/p02.fsproj"');
    expect(slnxOut).toContain('Path="projects/p01.csproj"');
    expect(slnxOut).toContain('Name="p01"');
    expect(slnxOut).not.toContain('Domain');
    expect(slnxOut).not.toContain('Api/');

    const fsproj = `<ProjectReference Include="..\\Domain\\Domain.fsproj" />`;
    expect(sanitizeXml(fsproj, aliased)).toContain('Include="projects/p02.fsproj"');

    const leftoverFs = `Project("{F2A71F9B-5D33-465A-A702-920D77279786}") = "Domain", "Domain/p02.fsproj", "{GUID}"`;
    const leftoverFsOut = sanitizeXml(leftoverFs, aliased);
    expect(leftoverFsOut).toContain('= "p02"');
    expect(leftoverFsOut).toContain('"projects/p02.fsproj"');
    expect(leftoverFsOut).not.toContain('Domain');
  });
});
