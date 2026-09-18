import { solutionRowLabel, projectRowLabel, allProjectsRowLabel } from '../../webview/utils/scopeChooserTooltip';
import type { ScopeChoiceProject, ScopeChoiceSolution } from '../../types';

describe('solutionRowLabel', () => {
  it('reads as the relative path plus the project count for a solution at the folder root', () => {
    const solution: ScopeChoiceSolution = {
      path: '/root/Example.Shop.slnx',
      relativeDir: '',
      projectCount: 3,
      projectPaths: [],
    };
    expect(solutionRowLabel(solution)).toBe('Example.Shop.slnx — 3 projects');
  });

  it('includes the directory for a solution nested below the folder, not the absolute path', () => {
    const solution: ScopeChoiceSolution = {
      path: '/root/multi-tfm/Example.MultiTarget.slnx',
      relativeDir: 'multi-tfm',
      projectCount: 3,
      projectPaths: [],
    };
    expect(solutionRowLabel(solution)).toBe('multi-tfm/Example.MultiTarget.slnx — 3 projects');
  });

  it('keeps the singular "project" for a single-project solution', () => {
    const solution: ScopeChoiceSolution = {
      path: '/root/App.sln',
      relativeDir: '',
      projectCount: 1,
      projectPaths: [],
    };
    expect(solutionRowLabel(solution)).toBe('App.sln — 1 project');
  });
});

describe('projectRowLabel', () => {
  it('is the project\'s path relative to the folder — the only carrier in tight mode, where the row drops the directory entirely', () => {
    const project: ScopeChoiceProject = { path: '/root/src/Example.Api/Example.Api.csproj', name: 'Example.Api', relativePath: 'src/Example.Api/Example.Api.csproj' };
    expect(projectRowLabel(project)).toBe('src/Example.Api/Example.Api.csproj');
  });
});

describe('allProjectsRowLabel', () => {
  it('reads as the row\'s own "All N projects" wording plus what it covers', () => {
    expect(allProjectsRowLabel(5, 'ignores solution boundaries')).toBe('All 5 projects — ignores solution boundaries');
  });

  it('keeps the singular "project" for a single project', () => {
    expect(allProjectsRowLabel(1, 'no solution here')).toBe('All 1 project — no solution here');
  });
});
