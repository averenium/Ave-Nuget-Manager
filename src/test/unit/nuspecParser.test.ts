import { parseNuspec } from '../../nuspecParser';

// Real fixtures pulled from ~/.nuget/packages, byte-for-byte, to catch
// discrepancies a hand-written fixture might paper over — see #86.

const DAPPER_NUSPEC = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>Dapper</id>
    <version>2.0.123</version>
    <title>Dapper</title>
    <authors>Sam Saffron,Marc Gravell,Nick Craver</authors>
    <owners>Sam Saffron,Marc Gravell,Nick Craver</owners>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <license type="expression">Apache-2.0</license>
    <licenseUrl>https://licenses.nuget.org/Apache-2.0</licenseUrl>
    <projectUrl>https://github.com/DapperLib/Dapper</projectUrl>
    <description>A high performance Micro-ORM supporting SQL Server, MySQL, Sqlite, SqlCE, Firebird etc..</description>
    <releaseNotes>https://dapperlib.github.io/Dapper/</releaseNotes>
    <copyright>2019 Stack Exchange, Inc.</copyright>
    <tags>orm sql micro-orm</tags>
    <repository type="git" url="https://github.com/DapperLib/Dapper" commit="2a837ad7d036671ac9a75c9945bb970aa41b7de9" />
    <dependencies>
      <group targetFramework=".NETFramework4.6.1" />
      <group targetFramework=".NETFramework5.0" />
      <group targetFramework=".NETStandard2.0">
        <dependency id="System.Reflection.Emit.Lightweight" version="4.7.0" exclude="Build,Analyzers" />
      </group>
    </dependencies>
    <icon>Dapper.png</icon>
  </metadata>
</package>`;

const EASYNETQ_NUSPEC = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>EasyNetQ</id>
    <version>7.8.0</version>
    <authors>Mike Hadlow,Michael Denny,Yury Pliner,Wiebe Tijsma,Contributors (see GitHub repo)</authors>
    <license type="file">licence.txt</license>
    <licenseUrl>https://aka.ms/deprecateLicenseUrl</licenseUrl>
    <icon>EasyNetQ.png</icon>
    <projectUrl>https://github.com/EasyNetQ/EasyNetQ</projectUrl>
    <description>A nice .NET API for RabbitMQ</description>
    <tags>RabbitMQ Messaging AMQP C#</tags>
    <repository type="git" url="https://github.com/EasyNetQ/EasyNetQ" commit="8dfc8679d5b91919435e639553f5611da63dcafa" />
    <dependencies>
      <group targetFramework=".NETStandard2.0">
        <dependency id="RabbitMQ.Client" version="6.8.1" exclude="Build,Analyzers" />
      </group>
    </dependencies>
  </metadata>
</package>`;

const HUMANIZER_UK_NUSPEC = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata minClientVersion="2.12">
    <id>Humanizer.Core.uk</id>
    <version>3.0.1</version>
    <title>Humanizer Locale (uk)</title>
    <authors>Claire Novotny, Mehdi Khalili</authors>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <license type="expression">MIT</license>
    <licenseUrl>https://licenses.nuget.org/MIT</licenseUrl>
    <icon>logo.png</icon>
    <projectUrl>https://github.com/Humanizr/Humanizer</projectUrl>
    <description>Humanizer Locale Ukrainian (uk)</description>
    <copyright>Copyright (c) .NET Foundation and Contributors</copyright>
    <language>uk</language>
    <repository type="git" url="https://github.com/Humanizr/Humanizer" commit="6e54d3786f4c4fe2cf665fa41d74a6e79bf9a85f" />
    <dependencies>
      <dependency id="Humanizer.Core" version="[3.0.1]" />
    </dependencies>
  </metadata>
</package>`;

describe('parseNuspec', () => {
  it('parses Dapper: comma-separated authors/owners, space-separated tags, license expression, repository', () => {
    const meta = parseNuspec(DAPPER_NUSPEC);
    expect(meta).toBeDefined();
    expect(meta?.id).toBe('Dapper');
    expect(meta?.version).toBe('2.0.123');
    expect(meta?.authors).toBe('Sam Saffron, Marc Gravell, Nick Craver');
    expect(meta?.owners).toBe('Sam Saffron, Marc Gravell, Nick Craver');
    expect(meta?.tags).toEqual(['orm', 'sql', 'micro-orm']);
    expect(meta?.license).toEqual({ type: 'expression', value: 'Apache-2.0' });
    expect(meta?.licenseUrl).toBe('https://licenses.nuget.org/Apache-2.0');
    expect(meta?.copyright).toBe('2019 Stack Exchange, Inc.');
    expect(meta?.repository).toEqual({
      url: 'https://github.com/DapperLib/Dapper',
      commit: '2a837ad7d036671ac9a75c9945bb970aa41b7de9',
    });
  });

  it('parses EasyNetQ: license type="file" has a value but is not a URL, distinct from an expression', () => {
    const meta = parseNuspec(EASYNETQ_NUSPEC);
    expect(meta?.license).toEqual({ type: 'file', value: 'licence.txt' });
    expect(meta?.licenseUrl).toBe('https://aka.ms/deprecateLicenseUrl');
  });

  it('parses Humanizer.Core.uk: comma-separated authors with existing internal spacing preserved', () => {
    const meta = parseNuspec(HUMANIZER_UK_NUSPEC);
    // "Claire Novotny, Mehdi Khalili" already has internal spacing after the
    // comma — splitCommaList must not collapse it to a double space or a
    // single merged name.
    expect(meta?.authors).toBe('Claire Novotny, Mehdi Khalili');
  });

  it('unwraps a CDATA-wrapped description instead of leaking the markers', () => {
    const xml = `<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>Foo</id>
    <version>1.0.0</version>
    <authors>Someone</authors>
    <description><![CDATA[A <b>bold</b> claim & a "quote".]]></description>
  </metadata>
</package>`;
    const meta = parseNuspec(xml);
    expect(meta?.description).toBe('A <b>bold</b> claim & a "quote".');
    expect(meta?.description).not.toContain('CDATA');
    expect(meta?.description).not.toContain(']]>');
  });

  it('is not fooled by a comment mentioning a tag name (#85-style safety, reused via maskXmlComments)', () => {
    const xml = `<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>Foo</id>
    <version>1.0.0</version>
    <authors>Someone</authors>
    <!-- old description was <description>stale</description> -->
    <description>Real description</description>
  </metadata>
</package>`;
    const meta = parseNuspec(xml);
    expect(meta?.description).toBe('Real description');
  });

  it('returns undefined for XML with no <metadata> section', () => {
    expect(parseNuspec('<package></package>')).toBeUndefined();
  });

  it('returns undefined when id or version is missing', () => {
    expect(parseNuspec('<package><metadata><authors>X</authors></metadata></package>')).toBeUndefined();
  });
});
