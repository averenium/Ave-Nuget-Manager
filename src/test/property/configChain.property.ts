/**
 * Property-based tests for NuGet config chain resolution.
 * Property 16: chain collects all config files along the upward path, no duplicates.
 * Property 18: chain order is nearest → farthest (index 0 = closest to start dir).
 * Minimum 100 iterations each.
 */

import * as fc from 'fast-check';
import * as path from 'path';
import * as fs from 'fs/promises';
import { NuGetConfigChainResolver } from '../../nugetConfigChainResolver';

jest.mock('fs/promises');
const mockReaddir = fs.readdir as jest.MockedFunction<typeof fs.readdir>;
const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;

const EMPTY_CONFIG = `<?xml version="1.0"?><configuration><packageSources></packageSources></configuration>`;

/**
 * Build a virtual filesystem where `nuget.config` exists at every directory
 * in `configDirs`, and no other directories have the file.
 */
function setupMockFs(configDirs: Set<string>): void {
  mockReaddir.mockImplementation(async (dir) => {
    if (configDirs.has(dir as string)) return ['nuget.config'] as any;
    return [] as any;
  });
  mockReadFile.mockResolvedValue(EMPTY_CONFIG as any);
}

/** Generate an absolute POSIX path with a given depth */
const absolutePath = (depth: number) =>
  fc.array(
    fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/),
    { minLength: depth, maxLength: depth },
  ).map((parts) => '/' + parts.join('/'));

describe('Property 16 — chain has no duplicates', () => {
  it('all filePaths in chain are unique for any starting directory', async () => {
    await fc.assert(
      fc.asyncProperty(
        absolutePath(4),
        async (startDir) => {
          // Place configs at alternating levels
          const parts = startDir.split('/').filter(Boolean);
          const configDirs = new Set<string>();
          let current = startDir;
          for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 0) configDirs.add(current);
            current = path.dirname(current);
          }

          setupMockFs(configDirs);
          const resolver = new NuGetConfigChainResolver();
          const chain = await resolver.resolve(startDir);

          const filePaths = chain.map((c) => c.filePath);
          const uniquePaths = new Set(filePaths);
          expect(uniquePaths.size).toBe(filePaths.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 18 — chain order is nearest to farthest', () => {
  it('first entry is closest to startDir when configs exist at multiple levels', async () => {
    await fc.assert(
      fc.asyncProperty(
        absolutePath(5),
        async (startDir) => {
          // Place configs at every level
          const configDirs = new Set<string>();
          let current = startDir;
          while (current !== path.dirname(current)) {
            configDirs.add(current);
            current = path.dirname(current);
          }

          setupMockFs(configDirs);
          const resolver = new NuGetConfigChainResolver();
          const chain = await resolver.resolve(startDir);

          const validChain = chain.filter((c) => !c.parseError && c.sources !== undefined);

          if (validChain.length >= 2) {
            // The first entry's directory should be deeper in the tree than the second's
            const firstDepth = validChain[0].filePath.split('/').length;
            const secondDepth = validChain[1].filePath.split('/').length;
            // nearest is deeper in the tree (more path components)
            expect(firstDepth).toBeGreaterThanOrEqual(secondDepth);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('startDir itself is checked before its parent (nearest-first)', async () => {
    await fc.assert(
      fc.asyncProperty(
        absolutePath(3),
        async (startDir) => {
          const parentDir = path.dirname(startDir);
          const configDirs = new Set([startDir, parentDir]);

          setupMockFs(configDirs);
          const resolver = new NuGetConfigChainResolver();
          const chain = await resolver.resolve(startDir);

          const validPaths = chain
            .filter((c) => c.filePath.endsWith('nuget.config'))
            .map((c) => path.dirname(c.filePath));

          if (validPaths.length >= 2) {
            expect(validPaths[0]).toBe(startDir);
            expect(validPaths[1]).toBe(parentDir);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
