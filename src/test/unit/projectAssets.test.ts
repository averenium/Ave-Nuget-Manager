import { promises as fs } from 'fs';
import { attachAssetsDependencies, stampListedDependencies } from '../../projectAssets';

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
