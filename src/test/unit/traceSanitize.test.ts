import * as path from 'path';
import {
  assignSourceAliases, sanitizeJsonLines, sanitizeText, sanitizeXml, sanitizeFeedUrl, buildPathReplacements, defaultTraceZipName,
} from '../../traceSanitize';

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

describe('sanitizeXml — proxy user / no_proxy (#38 review)', () => {
  it('redacts a proxy .user value that sits next to its .password sibling', () => {
    const xml = `
<configuration>
  <config>
    <add key="http_proxy" value="http://proxy.internal:8080" />
    <add key="http_proxy.user" value="realusername" />
    <add key="http_proxy.password" value="hunter2" />
  </config>
</configuration>`;
    const out = sanitizeXml(xml, ctx);
    expect(out).not.toContain('realusername');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('http_proxy.user');
    expect(out).toContain('<redacted>');
  });

  it('does not redact an unrelated key that merely contains "user" with no .password sibling', () => {
    const xml = `
<configuration>
  <packageSources>
    <add key="internal-user-feed" value="https://feed.example/v3/index.json" />
  </packageSources>
</configuration>`;
    const out = sanitizeXml(xml, ctx);
    expect(out).toContain('internal-user-feed');
  });

  it('redacts the whole no_proxy value, not just an exact hostname match', () => {
    const xml = `
<configuration>
  <config>
    <add key="no_proxy" value="10.0.0.1,*.internal-tld-a,*.internal-tld-b,localhost" />
  </config>
</configuration>`;
    const out = sanitizeXml(xml, ctx);
    expect(out).not.toContain('internal-tld-a');
    expect(out).not.toContain('internal-tld-b');
    expect(out).not.toContain('10.0.0.1');
    expect(out).toContain('no_proxy');
    expect(out).toContain('<redacted>');
  });
});

describe('buildPathReplacements — dirname of an alias (#38 review)', () => {
  it('redacts a bare containing-directory path (e.g. a cli trace event\'s cwd)', () => {
    const aliased = {
      ...ctx,
      aliases: [{
        absPath: 'C:\\Users\\lesov\\repo\\Solution\\Area\\Contoso.Internal.SomeApp\\Contoso.Internal.SomeApp.csproj',
        dest: 'projects/p01.csproj',
      }],
    };
    const out = sanitizeText(
      'cwd: C:\\Users\\lesov\\repo\\Solution\\Area\\Contoso.Internal.SomeApp',
      aliased,
    );
    expect(out).not.toContain('Contoso');
    expect(out).not.toContain('Solution');
    expect(out).not.toContain('Area');
  });

  it('still rewrites the full file path to the dest id, not just its directory', () => {
    const aliased = {
      ...ctx,
      aliases: [{
        absPath: 'C:\\Users\\lesov\\repo\\Solution\\Area\\Contoso.Internal.SomeApp\\Contoso.Internal.SomeApp.csproj',
        dest: 'projects/p01.csproj',
      }],
    };
    const out = sanitizeText(
      'dotnet add C:\\Users\\lesov\\repo\\Solution\\Area\\Contoso.Internal.SomeApp\\Contoso.Internal.SomeApp.csproj package X',
      aliased,
    );
    expect(out).toContain('projects/p01.csproj');
    expect(out).not.toContain('Contoso');
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

describe('source aliases (#133)', () => {
  const A = 'https://nexus.example.com/repository/private-a/index.json';
  const B = 'https://nexus.example.com/repository/pub-b/index.json';
  const C = 'https://nexus.example.com/repository/snap-c/index.json';
  const base = { home: '/home/someone', workspaceRoots: [], hostname: 'workstation' };
  const withAliases = { ...base, sourceAliases: assignSourceAliases([A, B, C]) };
  const requests = [`GET ${A}`, `GET ${B}`, `GET ${C}`];

  it('numbers distinct sources in the order given, once each', () => {
    expect(assignSourceAliases([A, B, A, C]).map((a) => a.alias)).toEqual(['s01', 's02', 's03']);
  });

  it('tells three repositories on one host apart, which the host and id redaction alone cannot', () => {
    const plain = requests.map((line) => sanitizeText(line, base));
    expect(new Set(plain).size).toBe(1);

    expect(requests.map((line) => sanitizeText(line, withAliases))).toEqual([
      'GET <s01>/index.json', 'GET <s02>/index.json', 'GET <s03>/index.json',
    ]);
  });

  it("keeps what follows the source's address, so a request stays readable", () => {
    expect(sanitizeText('GET https://nexus.example.com/repository/pub-b/v3/search?q=Example.Core', withAliases))
      .toBe('GET <s02>/v3/search?q=Example.Core');
  });

  it("does not let one source's alias eat the front of a sibling whose name starts the same way", () => {
    const near = assignSourceAliases(['https://nexus.example.com/repository/a/index.json']);
    const out = sanitizeText('https://nexus.example.com/repository/ab/index.json', { ...base, sourceAliases: near });
    expect(out).not.toContain('<s01>');
  });

  it('shows which source a config entry is, through the same names', () => {
    const xml = `<configuration><packageSources><add key="Private" value="${A}" /></packageSources></configuration>`;
    expect(sanitizeXml(xml, withAliases)).toContain('value="<s01>/index.json"');
  });
});

describe('sanitizeJsonLines — the trace stays valid JSON Lines (#134)', () => {
  const jsonCtx = {
    home: 'C:\\Users\\lesov',
    workspaceRoots: ['C:\\Users\\lesov\\repo'],
    hostname: 'DEVBOX',
    aliases: [{ absPath: 'C:\\Users\\lesov\\repo\\src\\App\\App.csproj', dest: 'projects/p01.csproj' }],
  };

  // A `dotnet package search --format json` answer is itself JSON, carried as a
  // string inside a trace event: escapes within escapes.
  const nestedStdout = '{\n  "version": 2,\n  "problems": [],\n  "searchResult": [{"id": "Example.Core", "note": "a quoted word"}]\n}\n';

  const events = [
    {
      kind: 'cli', at: '2026-10-29T11:41:00.000Z', command: 'dotnet', args: ['package', 'search', 'Example.Core'],
      cwd: 'C:\\Users\\lesov\\repo\\src\\App', exitCode: 0, timedOut: false, durationMs: 412,
      stdout: nestedStdout, stderr: '',
    },
    {
      kind: 'http', at: '2026-10-29T11:41:01.000Z', url: 'https://feed.example.com/v3/index.json', status: 200,
      body: '{"resources":[{"@id":"https://feed.example.com/v3/query","@type":"SearchQueryService"}]}',
    },
    { kind: 'broker', at: '2026-10-29T11:41:02.000Z', step: 'path', detail: { file: 'C:\\Users\\lesov\\repo\\src\\App\\App.csproj', tab: 'a\tb', slash: 'back\\slash' } },
  ];
  const jsonl = events.map((event) => JSON.stringify(event)).join('\n') + '\n';

  it('leaves every line parseable, which sanitising the encoded text did not', () => {
    const out = sanitizeJsonLines(jsonl, jsonCtx);
    const lines = out.split('\n').filter(Boolean);

    expect(lines).toHaveLength(events.length);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('keeps the escapes of the line itself as they were: the newlines inside a payload, and nested JSON that is still readable as JSON', () => {
    const [cli] = sanitizeJsonLines(jsonl, jsonCtx).split('\n').map((line) => (line ? JSON.parse(line) : undefined));

    expect(cli.stdout).toContain('\n  "version": 2');
    expect(() => JSON.parse(cli.stdout)).not.toThrow();
    expect(JSON.parse(cli.stdout).searchResult[0].note).toBe('a quoted word');
  });

  it('still redacts what it was there to redact: a Windows path becomes its alias', () => {
    const parsed = sanitizeJsonLines(jsonl, jsonCtx).split('\n').filter(Boolean).map((line) => JSON.parse(line));

    expect(parsed[0].cwd).not.toContain('lesov');
    expect(parsed[2].detail.file).toBe('projects/p01.csproj');
    expect(JSON.stringify(parsed)).not.toContain('DEVBOX');
  });

  it('redacts a credential inside a response body without breaking the line', () => {
    const line = JSON.stringify({ kind: 'http', body: '{"password": "hunter2", "ok": true}' });
    const [out] = sanitizeJsonLines(`${line}\n`, jsonCtx).split('\n').filter(Boolean);

    const body = JSON.parse(out).body as string;
    expect(body).not.toContain('hunter2');
  });

  it('redacts a value by the name of its key, but leaves a flag that merely names a secret', () => {
    const line = JSON.stringify({ kind: 'broker', detail: { clearApiKey: false, apiKey: 'abc', password: 42, hasSecret: null } });
    const [out] = sanitizeJsonLines(`${line}\n`, jsonCtx).split('\n').filter(Boolean);

    expect(JSON.parse(out).detail).toEqual({ clearApiKey: false, apiKey: '<redacted>', password: '<redacted>', hasSecret: null });
  });

  it('turns a line that is not JSON into one that is, instead of passing it through', () => {
    const out = sanitizeJsonLines('{"kind":"broker"}\nnot json at all C:\\Users\\lesov\\x\n', jsonCtx);
    const lines = out.split('\n').filter(Boolean);

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ kind: 'unparseable' });
    expect(lines[1]).not.toContain('lesov');
  });

  it('is empty for an empty file', () => {
    expect(sanitizeJsonLines('', jsonCtx)).toBe('');
  });

  it('sanitises the keys of an object too: INSTALL_PACKAGE_MULTI keys its frameworks by project path', () => {
    const event = {
      kind: 'webview', type: 'INSTALL_PACKAGE_MULTI',
      payload: { frameworks: { 'C:\\Users\\lesov\\repo\\src\\App\\App.csproj': ['net8.0'] } },
    };
    const [out] = sanitizeJsonLines(`${JSON.stringify(event)}\n`, jsonCtx).split('\n').filter(Boolean);

    expect(JSON.parse(out).payload.frameworks).toEqual({ 'projects/p01.csproj': ['net8.0'] });
    expect(out).not.toContain('lesov');
  });

  it('keeps two keys that sanitise to the same name apart instead of dropping one', () => {
    const event = { map: { 'C:\\Users\\lesov\\repo\\x\\App.csproj': 1, 'C:\\Users\\lesov\\repo\\y\\App.csproj': 2 } };
    const [out] = sanitizeJsonLines(`${JSON.stringify(event)}\n`, {
      ...jsonCtx, aliases: [],
    }).split('\n').filter(Boolean);

    expect(Object.values(JSON.parse(out).map).sort()).toEqual([1, 2]);
  });

  describe('JSON carried inside a payload keeps its own escapes', () => {
    const httpLine = (body: string) => `${JSON.stringify({ kind: 'http', at: 't', url: 'https://feed.example.com/x', status: 200, body })}\n`;
    const bodyOf = (out: string) => JSON.parse(out.split('\n').filter(Boolean)[0]).body as string;

    it('a response body with newlines and quotes in its own strings still parses', () => {
      const body = '{"description":"Line one\\nLine two says \\"hi\\" é"}';
      const out = bodyOf(sanitizeJsonLines(httpLine(body), jsonCtx));

      expect(JSON.parse(out)).toEqual({ description: 'Line one\nLine two says "hi" é' });
    });

    it('a pretty-printed stdout keeps its layout and its trailing newline', () => {
      const stdout = '{\n  "version": 2,\n  "items": [\n    "a"\n  ]\n}\n';
      const out = bodyOf(sanitizeJsonLines(httpLine(stdout), jsonCtx));

      expect(out).toBe(stdout);
    });

    it('a path inside the nested JSON is still redacted, as data', () => {
      const body = JSON.stringify({ file: 'C:\\Users\\lesov\\repo\\src\\App\\App.csproj' });
      const out = bodyOf(sanitizeJsonLines(httpLine(body), jsonCtx));

      expect(JSON.parse(out)).toEqual({ file: 'projects/p01.csproj' });
    });

    it('a body cut off by the preview limit keeps the escapes it had, though it cannot be parsed', () => {
      const cut = '{"description":"Line one\\nLine two says \\"hi\\" and then it is cut o';
      const out = bodyOf(sanitizeJsonLines(httpLine(cut), jsonCtx));

      expect(out).toContain('\\n');
      expect(out).toContain('\\"hi\\"');
      expect(out).not.toContain('/n');
    });

    it('JSON inside JSON inside the payload is handled the same way', () => {
      const inner = JSON.stringify({ note: 'say "hi"\nthen go', file: 'C:\\Users\\lesov\\repo\\src\\App\\App.csproj' });
      const out = bodyOf(sanitizeJsonLines(httpLine(JSON.stringify({ wrapped: inner })), jsonCtx));

      const wrapped = JSON.parse(JSON.parse(out).wrapped);
      expect(wrapped).toEqual({ note: 'say "hi"\nthen go', file: 'projects/p01.csproj' });
    });
  });
});

describe('credentials written into an address (#135)', () => {
  const base = { home: '/home/someone', workspaceRoots: [], hostname: 'workstation' };
  const WITH_CREDENTIALS = 'https://user:pw@nexus.corp.internal/repository/private-a/index.json';

  it('takes the host with the credentials, as it does for any other feed address', () => {
    const out = sanitizeText(`GET ${WITH_CREDENTIALS}`, base);

    expect(out).toBe('GET https://<host>/repository/<id>/index.json');
    expect(out).not.toContain('corp.internal');
    expect(out).not.toContain('pw');
  });

  it('does the same inside a JSON Lines payload', () => {
    const line = JSON.stringify({ kind: 'http', url: WITH_CREDENTIALS, body: `{"next":"${WITH_CREDENTIALS}"}` });
    const [out] = sanitizeJsonLines(`${line}\n`, base).split('\n').filter(Boolean);

    expect(out).not.toContain('corp.internal');
    expect(JSON.parse(out).url).toBe('https://<host>/repository/<id>/index.json');
  });

  it('covers a proxy address written with its user and password', () => {
    const out = sanitizeText('http_proxy=http://proxyuser:proxypw@proxy.corp.internal:8080', base);

    expect(out).not.toContain('proxy.corp.internal');
    expect(out).not.toContain('proxypw');
  });

  it('still gives a source written with credentials its alias', () => {
    const sourceAliases = assignSourceAliases(['https://nexus.corp.internal/repository/private-a/index.json']);
    const out = sanitizeText(`GET ${WITH_CREDENTIALS}`, { ...base, sourceAliases });

    expect(out).toBe('GET <s01>/index.json');
  });

  it('leaves the placeholder for a scheme no address pass owns', () => {
    expect(sanitizeText('remote=ssh://deploy:secret@git.corp.internal/repo', base))
      .toBe('remote=ssh://<redacted>@git.corp.internal/repo');
  });
});
