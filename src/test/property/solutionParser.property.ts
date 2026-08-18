/**
 * Property-based tests for SolutionParser helpers.
 * Property 1: shouldShowContextMenu is true IFF at least one direct-child
 * filename ends with .sln, .slnx, .csproj, or .fsproj.
 * Minimum 100 iterations.
 */

import * as fc from 'fast-check';
import { shouldShowContextMenu } from '../../solutionParser';

const SOLUTION_EXTENSIONS = ['.sln', '.slnx', '.csproj', '.fsproj'];
const NON_SOLUTION_EXTENSIONS = ['.ts', '.json', '.md', '.txt', '.xml', '.cs', '.fs', '.py'];

/** Generates an arbitrary non-solution filename */
const nonSolutionFile = fc.tuple(
  fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/),
  fc.constantFrom(...NON_SOLUTION_EXTENSIONS),
).map(([name, ext]) => `${name}${ext}`);

/** Generates an arbitrary solution/project filename */
const solutionFile = fc.tuple(
  fc.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/),
  fc.constantFrom(...SOLUTION_EXTENSIONS),
).map(([name, ext]) => `${name}${ext}`);

describe('Property 1 — shouldShowContextMenu', () => {
  it('returns false for any directory containing only non-solution files', () => {
    fc.assert(
      fc.property(
        fc.array(nonSolutionFile, { minLength: 0, maxLength: 20 }),
        (files) => {
          expect(shouldShowContextMenu(files)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns true whenever at least one solution/project file is present', () => {
    fc.assert(
      fc.property(
        fc.array(nonSolutionFile, { minLength: 0, maxLength: 10 }),
        solutionFile,
        fc.array(nonSolutionFile, { minLength: 0, maxLength: 10 }),
        (before, sol, after) => {
          const files = [...before, sol, ...after];
          expect(shouldShowContextMenu(files)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('is insensitive to file order — presence anywhere triggers true', () => {
    fc.assert(
      fc.property(
        fc.array(nonSolutionFile, { minLength: 0, maxLength: 10 }),
        solutionFile,
        (others, sol) => {
          // Regardless of where we insert the solution file, result must be true
          for (let i = 0; i <= others.length; i++) {
            const files = [...others.slice(0, i), sol, ...others.slice(i)];
            expect(shouldShowContextMenu(files)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('multiple solution files: still returns true (no off-by-one)', () => {
    fc.assert(
      fc.property(
        fc.array(solutionFile, { minLength: 2, maxLength: 5 }),
        fc.array(nonSolutionFile, { minLength: 0, maxLength: 5 }),
        (sols, others) => {
          const files = [...sols, ...others];
          expect(shouldShowContextMenu(files)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
