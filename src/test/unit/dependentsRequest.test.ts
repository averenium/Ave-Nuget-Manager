import { dependentsRequestFor, panelMovedOn } from '../../webview/utils/dependentsRequest';
import type { InstalledPackage } from '../../types';

const entry = (over: Partial<InstalledPackage>): InstalledPackage => ({
  id: 'Example.Messaging.Transport', resolvedVersion: '6.8.1', projectPath: 'D:/src/Example.Shop.csproj', ...over,
} as InstalledPackage);

const base = {
  packageId: 'example.messaging.transport',
  projectPath: String.raw`d:\src\Example.Shop.csproj`,
  toVersion: '7.2.2',
};

describe('the dependents question for a write (#109)', () => {
  it('asks about the version the project has now, matching the id and the path without regard to case or slashes', () => {
    expect(dependentsRequestFor({ ...base, installed: [entry({ framework: 'net10.0' })] })).toEqual({
      packageId: 'example.messaging.transport', fromVersion: '6.8.1', toVersion: '7.2.2',
      projectPath: String.raw`d:\src\Example.Shop.csproj`, frameworks: ['net10.0'], confineFramework: undefined,
    });
  });

  it('asks nothing about a package the project does not reference yet', () => {
    expect(dependentsRequestFor({ ...base, installed: [entry({ projectPath: 'D:/src/Other.csproj' })] })).toBeUndefined();
    expect(dependentsRequestFor({ ...base, installed: [] })).toBeUndefined();
  });

  it('asks nothing when the version does not change, however it is written', () => {
    expect(dependentsRequestFor({ ...base, toVersion: '6.8.1', installed: [entry({})] })).toBeUndefined();
    expect(dependentsRequestFor({ ...base, toVersion: '6.8.1.0', installed: [entry({})] })).toBeUndefined();
  });

  it('starts from the lowest version a multi-targeted reference restored, and names every framework', () => {
    const request = dependentsRequestFor({
      ...base,
      installed: [
        entry({ resolvedVersion: '6.9.0', framework: 'net10.0' }),
        entry({ resolvedVersion: '6.8.1', framework: 'net8.0' }),
      ],
    });
    expect(request).toMatchObject({ fromVersion: '6.8.1', frameworks: ['net10.0', 'net8.0'] });
  });

  it('confines the question to the one framework a write is confined to', () => {
    const request = dependentsRequestFor({
      ...base, onlyFramework: 'net8.0',
      installed: [
        entry({ resolvedVersion: '6.9.0', framework: 'net10.0' }),
        entry({ resolvedVersion: '6.8.1', framework: 'net8.0' }),
      ],
    });
    expect(request).toMatchObject({ fromVersion: '6.8.1', frameworks: ['net8.0'], confineFramework: 'net8.0' });
  });

  it('falls back to the project frameworks when the reference names none', () => {
    const request = dependentsRequestFor({ ...base, projectFrameworks: ['net10.0', 'net8.0'], installed: [entry({})] });
    expect(request?.frameworks).toEqual(['net10.0', 'net8.0']);
  });
});

describe('the panel moving on from an open page (#109)', () => {
  const request = { packageId: 'Example.Messaging.Transport', fromVersion: '6.8.1', projectPath: 'D:/src/Example.Shop.csproj' };
  const installed = [entry({})];

  it('is not moved on while the same package is selected and still where the page left it', () => {
    expect(panelMovedOn(request, installed, 'example.messaging.transport')).toBe(false);
  });

  it('has moved on once another package is selected, or none', () => {
    expect(panelMovedOn(request, installed, 'Example.Core')).toBe(true);
    expect(panelMovedOn(request, installed, null)).toBe(true);
  });

  it('has moved on once the reference is on another version, or gone', () => {
    expect(panelMovedOn(request, [entry({ resolvedVersion: '7.2.2' })], request.packageId)).toBe(true);
    expect(panelMovedOn(request, [], request.packageId)).toBe(true);
    expect(panelMovedOn(request, [entry({ projectPath: 'D:/src/Other.csproj' })], request.packageId)).toBe(true);
  });

  it('does not take a different spelling of the same version for a move', () => {
    expect(panelMovedOn(request, [entry({ resolvedVersion: '6.8.1.0' })], request.packageId)).toBe(false);
  });
});
