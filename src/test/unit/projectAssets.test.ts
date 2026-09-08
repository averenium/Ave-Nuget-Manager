import { promises as fs } from 'fs';
import { attachAssetsDependencies, stampListedDependencies, readProjectFloors, readProjectAssets, readPackageFolders } from '../../projectAssets';

describe('attachAssetsDependencies', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stamps direct deps from the project assets file', async () => {
    jest.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      targets: {
        'net8.0': {
          'Microsoft.Extensions.Http/10.0.0': {
            type: 'package',
            dependencies: { 'Microsoft.Extensions.Logging.Abstractions': '10.0.0' },
          },
        },
      },
    }) as never);

    const [http] = await attachAssetsDependencies([
      {
        id: 'Microsoft.Extensions.Http',
        requestedVersion: '10.0.0',
        resolvedVersion: '10.0.0',
        projectPath: '/p/App.csproj',
      },
      {
        id: 'Microsoft.Extensions.Logging.Abstractions',
        requestedVersion: '10.0.0',
        resolvedVersion: '10.0.0',
        projectPath: '/p/App.csproj',
      },
    ]);
    expect(http.dependencies).toEqual(['Microsoft.Extensions.Logging.Abstractions']);
    expect(fs.readFile).toHaveBeenCalledWith(
      expect.stringMatching(/obj[\\/]project\.assets\.json$/),
      'utf8',
    );
  });

  it('leaves packages unchanged when assets.json is missing', async () => {
    jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
    const [pkg] = await attachAssetsDependencies([
      {
        id: 'A',
        requestedVersion: '1.0.0',
        resolvedVersion: '1.0.0',
        projectPath: '/p/App.csproj',
      },
    ]);
    expect(pkg.dependencies).toBeUndefined();
  });
});

describe('readProjectFloors', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads version floors from the project assets file (#38)', async () => {
    jest.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      targets: {
        'net10.0': {
          'DDAS.EcaAuthorization.OpenTelemetry/1.0.0': {
            type: 'project',
            dependencies: { 'OpenTelemetry.Extensions.Hosting': '1.18.0' },
          },
        },
      },
    }) as never);

    const floors = await readProjectFloors('/p/App.csproj');
    expect(floors.get('opentelemetry.extensions.hosting')).toBe('1.18.0');
    expect(fs.readFile).toHaveBeenCalledWith(
      expect.stringMatching(/obj[\\/]project\.assets\.json$/),
      'utf8',
    );
  });

  it('returns an empty map when assets.json is missing', async () => {
    jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
    const floors = await readProjectFloors('/p/App.csproj');
    expect(floors.size).toBe(0);
  });
});

describe('readProjectAssets', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads dependencies and floors from a single parse (#38 perf)', async () => {
    const readFileSpy = jest.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      targets: {
        'net10.0': {
          'DDAS.EcaAuthorization.OpenTelemetry/1.0.0': {
            type: 'project',
            dependencies: { 'OpenTelemetry.Extensions.Hosting': '1.18.0' },
          },
          'Microsoft.Extensions.Http/10.0.0': {
            type: 'package',
            dependencies: { 'Microsoft.Extensions.Logging.Abstractions': '10.0.0' },
          },
        },
      },
    }) as never);

    const { dependencies, floors } = await readProjectAssets('/p/App.csproj');
    expect(floors.get('opentelemetry.extensions.hosting')).toBe('1.18.0');
    expect(dependencies.get('microsoft.extensions.http')).toEqual(['Microsoft.Extensions.Logging.Abstractions']);
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  it('returns empty maps when assets.json is missing', async () => {
    jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
    const { dependencies, floors } = await readProjectAssets('/p/App.csproj');
    expect(dependencies.size).toBe(0);
    expect(floors.size).toBe(0);
  });
});

describe('readPackageFolders', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads the NuGet cache folder names dotnet restore resolved from (#86)', async () => {
    jest.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      packageFolders: {
        'C:\\Users\\me\\.nuget\\packages\\': {},
        'C:\\Program Files (x86)\\Microsoft Visual Studio\\Shared\\NuGetPackages': {},
      },
    }) as never);

    const folders = await readPackageFolders('/p/App.csproj');
    expect(folders).toEqual([
      'C:\\Users\\me\\.nuget\\packages\\',
      'C:\\Program Files (x86)\\Microsoft Visual Studio\\Shared\\NuGetPackages',
    ]);
  });

  it('returns an empty array when assets.json is missing or has no packageFolders', async () => {
    jest.spyOn(fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
    expect(await readPackageFolders('/p/App.csproj')).toEqual([]);

    jest.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({ targets: {} }) as never);
    expect(await readPackageFolders('/p/App.csproj')).toEqual([]);
  });
});

describe('stampListedDependencies', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lets an installed package list an implicit restore-graph dependency', async () => {
    jest.spyOn(fs, 'readFile').mockResolvedValue(JSON.stringify({
      targets: {
        'net8.0': {
          'Microsoft.Extensions.Http/10.0.0': {
            type: 'package',
            dependencies: { 'Microsoft.Extensions.Logging.Abstractions': '10.0.0' },
          },
          'Microsoft.Extensions.Logging.Abstractions/10.0.0': {
            type: 'package',
          },
        },
      },
    }) as never);

    const { installed, implicit } = await stampListedDependencies(
      [{
        id: 'Microsoft.Extensions.Http',
        requestedVersion: '10.0.0',
        resolvedVersion: '10.0.0',
        projectPath: '/p/App.csproj',
      }],
      [{
        id: 'Microsoft.Extensions.Logging.Abstractions',
        resolvedVersion: '10.0.0',
        projectPath: '/p/App.csproj',
      }],
    );

    expect(installed[0].dependencies).toEqual(['Microsoft.Extensions.Logging.Abstractions']);
    expect(implicit[0].dependencies).toBeUndefined();
  });
});
