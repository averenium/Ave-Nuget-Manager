import { NuspecReader } from '../../nugetNuspecFetch';
import { SourceCapabilityStore, type HttpJsonResponse } from '../../nugetSourceCapabilities';

const SOURCE = 'https://feed.example/v3/index.json';
const CONTENT = 'https://feed.example/v3/flat/';
const NUSPEC = `${CONTENT}example.imaging/3.1.5/example.imaging.nuspec`;

const INDEX = {
  status: 200,
  json: { resources: [{ '@type': 'PackageBaseAddress/3.0.0', '@id': CONTENT }] },
};

/** The measured shape: a file licence is named nowhere but here. */
const FILE_LICENCE_NUSPEC = `<?xml version="1.0"?>
<package><metadata>
  <id>Example.Imaging</id><version>3.1.5</version>
  <license type="file">LICENSE</license>
  <description>d</description>
</metadata></package>`;

function readerOver(routes: Record<string, HttpJsonResponse>) {
  const calls: string[] = [];
  const fetchJson = async (url: string): Promise<HttpJsonResponse> => {
    calls.push(url);
    return routes[url] ?? { status: 404 };
  };
  const capabilities = new SourceCapabilityStore(fetchJson, undefined, Date.now, () => true);
  return { reader: new NuspecReader(capabilities, fetchJson), calls };
}

const target = { url: SOURCE };

describe('NuspecReader', () => {
  it('names a file licence, which no other resource states', async () => {
    const { reader } = readerOver({
      [SOURCE]: INDEX,
      [NUSPEC]: { status: 200, text: FILE_LICENCE_NUSPEC },
    });

    expect(await reader.license(target, 'Example.Imaging', '3.1.5'))
      .toEqual({ type: 'file', value: 'LICENSE' });
  });

  it('builds the address from the source own content resource, lowercased', async () => {
    const { reader, calls } = readerOver({
      [SOURCE]: INDEX,
      [NUSPEC]: { status: 200, text: FILE_LICENCE_NUSPEC },
    });

    await reader.license(target, 'Example.Imaging', '3.1.5');

    expect(calls).toContain(NUSPEC);
  });

  it('asks once per address and remembers, since a published version never changes', async () => {
    const { reader, calls } = readerOver({
      [SOURCE]: INDEX,
      [NUSPEC]: { status: 200, text: FILE_LICENCE_NUSPEC },
    });

    await reader.license(target, 'Example.Imaging', '3.1.5');
    await reader.license(target, 'Example.Imaging', '3.1.5');

    expect(calls.filter((u) => u === NUSPEC)).toHaveLength(1);
  });

  it('drops build metadata, which is no part of the address', async () => {
    // `1.0.0+sha.abc` and `1.0.0` are one version to NuGet, and only the
    // normalised form exists on the feed — asking with the suffix is a 404,
    // which this layer swallows, so the licence would silently go unread.
    const { reader, calls } = readerOver({
      [SOURCE]: INDEX,
      [NUSPEC]: { status: 200, text: FILE_LICENCE_NUSPEC },
    });

    expect(await reader.license(target, 'Example.Imaging', '3.1.5+sha.abc'))
      .toEqual({ type: 'file', value: 'LICENSE' });
    expect(calls).toContain(NUSPEC);
  });

  it('says nothing when the package is not on this feed', async () => {
    const { reader } = readerOver({ [SOURCE]: INDEX });
    expect(await reader.license(target, 'Example.Imaging', '3.1.5')).toBeUndefined();
  });

  it('says nothing when the body is not a nuspec', async () => {
    const { reader } = readerOver({
      [SOURCE]: INDEX,
      [NUSPEC]: { status: 200, text: '<html>a portal</html>' },
    });
    expect(await reader.license(target, 'Example.Imaging', '3.1.5')).toBeUndefined();
  });

  it('says nothing when the source publishes no content resource', async () => {
    const { reader } = readerOver({
      [SOURCE]: { status: 200, json: { resources: [{ '@type': 'SearchQueryService', '@id': 'https://feed.example/s' }] } },
    });
    expect(await reader.license(target, 'Example.Imaging', '3.1.5')).toBeUndefined();
  });
});
