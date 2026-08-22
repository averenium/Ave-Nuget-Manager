import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  findingsFromNuGetHttpCache,
  matchVdbPages,
  parseVulnerabilityPage,
} from '../../nugetHttpCacheVdb';

const page = {
  sharpcompress: [
    {
      url: 'https://github.com/advisories/GHSA-6c8g-7p36-r338',
      severity: 1,
      versions: '(, 0.32.0)',
    },
  ],
};

describe('parseVulnerabilityPage', () => {
  it('reads severity integers from the VDB schema', () => {
    const parsed = parseVulnerabilityPage(page);
    expect(parsed?.sharpcompress[0].severity).toBe('moderate');
  });

  it('skips extra non-array fields instead of rejecting the file', () => {
    const parsed = parseVulnerabilityPage({
      comment: 'ignore',
      version: '1',
      sharpcompress: page.sharpcompress,
    });
    expect(parsed?.sharpcompress).toHaveLength(1);
  });
});

describe('matchVdbPages', () => {
  it('matches installed and implicit versions against the range', () => {
    const findings = matchVdbPages([parseVulnerabilityPage(page)!], [
      { id: 'SharpCompress', requestedVersion: '0.30.1', resolvedVersion: '0.30.1', projectPath: '/p/App.csproj' },
    ], []);
    expect(findings).toEqual([
      expect.objectContaining({
        packageId: 'SharpCompress',
        version: '0.30.1',
        severity: 'moderate',
        source: 'nuget-cache',
      }),
    ]);
    expect(matchVdbPages([parseVulnerabilityPage(page)!], [
      { id: 'SharpCompress', requestedVersion: '0.32.0', resolvedVersion: '0.32.0', projectPath: '/p/App.csproj' },
    ], [])).toEqual([]);
  });
});

describe('findingsFromNuGetHttpCache', () => {
  it('loads hashed cache files that look like VDB JSON', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nuget-vdb-'));
    await fs.writeFile(path.join(dir, 'other.json'), JSON.stringify({ ignore: true }));
    await fs.writeFile(path.join(dir, 'a1b2c3d4e5f67890abcdef'), JSON.stringify(page));
    const findings = await findingsFromNuGetHttpCache(dir, [
      { id: 'SharpCompress', requestedVersion: '0.30.1', resolvedVersion: '0.30.1', projectPath: '/p/App.csproj' },
    ], []);
    expect(findings).toHaveLength(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
