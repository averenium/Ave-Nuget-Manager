import { litProjectPathsFor, isProjectDimmed } from '../../webview/utils/scopeChooserHighlight';
import type { ScopeChoiceSolution } from '../../types';

const SOLUTIONS: ScopeChoiceSolution[] = [
  {
    path: '/root/App.sln',
    relativeDir: '',
    projectCount: 1,
    // Written in a different case than the folder's own scan of the same
    // file would produce — Windows paths compare case-insensitively.
    projectPaths: ['/root/SRC/A.csproj'],
  },
  {
    path: '/root/tools/Tools.sln',
    relativeDir: 'tools',
    projectCount: 1,
    projectPaths: ['/root/tools/B.csproj'],
  },
];

describe('litProjectPathsFor', () => {
  it('is null when nothing is hovered', () => {
    expect(litProjectPathsFor(SOLUTIONS, null)).toBeNull();
  });

  it('returns the hovered solution\'s own project paths', () => {
    expect(litProjectPathsFor(SOLUTIONS, '/root/tools/Tools.sln')).toEqual(['/root/tools/B.csproj']);
  });
});

describe('isProjectDimmed', () => {
  it('never dims while nothing is hovered', () => {
    expect(isProjectDimmed(null, '/root/src/A.csproj')).toBe(false);
  });

  it('does not dim a project the hovered solution covers, even when the case differs from the scan', () => {
    // The solution's own `projectPaths` came from SolutionParser reading the
    // .sln text; the row being rendered came from the folder's independent
    // recursive scan — same file, different case here. A `===` comparison
    // would call this "not covered" and wrongly dim the row.
    const lit = litProjectPathsFor(SOLUTIONS, '/root/App.sln');
    expect(isProjectDimmed(lit, '/root/src/A.csproj')).toBe(false);
  });

  it('dims a project that genuinely belongs to a different solution', () => {
    const lit = litProjectPathsFor(SOLUTIONS, '/root/App.sln');
    expect(isProjectDimmed(lit, '/root/tools/B.csproj')).toBe(true);
  });
});
