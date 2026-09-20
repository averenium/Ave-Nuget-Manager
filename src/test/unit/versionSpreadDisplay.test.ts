import { resolveVersionSpread } from '../../packageResolvedVersions';
import { versionCellFor, versionSpreadTooltip } from '../../webview/utils/versionSpreadDisplay';

describe('versionCellFor', () => {
  it('shows the primary and every other version when they all fit', () => {
    const entries = [
      { resolvedVersion: '3.4.0', projectPath: '/s/A.csproj' },
      { resolvedVersion: '3.1.0', projectPath: '/s/B.csproj' },
    ];
    const spread = resolveVersionSpread([entries[0]], [entries[1]])!;
    expect(versionCellFor(spread, entries)).toEqual({
      primary: '3.4.0', rest: ['3.1.0'], moreCount: 0, crossesMajor: false,
    });
  });

  it('folds whatever does not fit into a count, newest-of-the-rest first', () => {
    const entries = [
      { resolvedVersion: '9.0.0', projectPath: '/s/A.csproj' },
      { resolvedVersion: '8.0.1', projectPath: '/s/B.csproj' },
      { resolvedVersion: '6.0.0', projectPath: '/s/C.csproj' },
      { resolvedVersion: '4.0.0', projectPath: '/s/D.csproj' },
      { resolvedVersion: '2.0.0', projectPath: '/s/E.csproj' },
    ];
    const spread = resolveVersionSpread(entries, [])!;
    expect(versionCellFor(spread, entries)).toEqual({
      primary: '9.0.0', rest: ['8.0.1'], moreCount: 3, crossesMajor: true,
    });
  });

  it('marks a major-crossing spread with the axis badge when nothing folds into a count (#115)', () => {
    // Two projects, one major apart — both versions fit inline, so `moreCount`
    // is 0 and has nothing to colour. Decided on the issue: revive the cell
    // mockup's variant C for exactly this case, naming what the spread is
    // between rather than just flagging that it crosses a major.
    const entries = [
      { resolvedVersion: '9.0.0', projectPath: '/s/A.csproj' },
      { resolvedVersion: '6.0.0', projectPath: '/s/B.csproj' },
    ];
    const spread = resolveVersionSpread([entries[0]], [entries[1]])!;
    expect(versionCellFor(spread, entries)).toEqual({
      primary: '9.0.0', rest: ['6.0.0'], moreCount: 0, crossesMajor: true, axis: '2 projects',
    });
  });

  it('names frameworks instead of projects when the spread is within one project', () => {
    const entries = [
      { resolvedVersion: '10.0.0', projectPath: '/s/Core.csproj', framework: 'net10.0' },
      { resolvedVersion: '9.0.0', projectPath: '/s/Core.csproj', framework: 'net9.0' },
    ];
    const spread = resolveVersionSpread(entries, [])!;
    expect(versionCellFor(spread, entries).axis).toBe('2 TFM');
  });

  it('dedupes the framework axis the same way the project axis already does', () => {
    // dotnet list never reports one framework twice for the same project
    // today, but the project branch already refuses to trust the raw entry
    // count — the framework branch should not quietly stay the odd one out.
    const entries = [
      { resolvedVersion: '10.0.0', projectPath: '/s/Core.csproj', framework: 'net10.0' },
      { resolvedVersion: '10.0.0', projectPath: '/s/Core.csproj', framework: 'NET10.0' },
      { resolvedVersion: '9.0.0', projectPath: '/s/Core.csproj', framework: 'net9.0' },
    ];
    const spread = resolveVersionSpread(entries, [])!;
    expect(versionCellFor(spread, entries).axis).toBe('2 TFM');
  });

  it('counts distinct projects, not project-framework entries, when some are multi-targeted (#115)', () => {
    // The real report: a package on 11.0.1 in one project and 8.0.1 everywhere
    // else, where two of those "everywhere else" projects are multi-targeted.
    // The raw entry count is 9 (1 + 2 + 4 + 1 + 1), but only 5 distinct
    // projects are actually involved — the badge has to say 5, not 9.
    const entries = [
      { resolvedVersion: '11.0.1', projectPath: '/s/Sample.NexusLab.csproj' },
      { resolvedVersion: '8.0.1', projectPath: '/s/Example.MultiTarget.Core.csproj', framework: 'net10.0' },
      { resolvedVersion: '8.0.1', projectPath: '/s/Example.MultiTarget.Core.csproj', framework: 'net9.0' },
      { resolvedVersion: '8.0.1', projectPath: '/s/Example.MultiTarget.Workers.csproj', framework: 'net10.0' },
      { resolvedVersion: '8.0.1', projectPath: '/s/Example.MultiTarget.Workers.csproj', framework: 'net9.0' },
      { resolvedVersion: '8.0.1', projectPath: '/s/Example.MultiTarget.Workers.csproj', framework: 'net8.0' },
      { resolvedVersion: '8.0.1', projectPath: '/s/Example.MultiTarget.Workers.csproj', framework: 'netstandard2.0' },
      { resolvedVersion: '8.0.1', projectPath: '/s/Example.Shop.Domain.csproj' },
      { resolvedVersion: '8.0.1', projectPath: '/s/Example.Shop.OpenApi.csproj' },
    ];
    const spread = resolveVersionSpread(entries, [])!;
    const cell = versionCellFor(spread, entries);
    expect(cell.moreCount).toBe(0);
    expect(cell.crossesMajor).toBe(true);
    expect(cell.axis).toBe('5 projects');
  });

  it('does not mark the count when every version stays in the primary\'s major line', () => {
    const entries = [
      { resolvedVersion: '3.4.0', projectPath: '/s/A.csproj' },
      { resolvedVersion: '3.1.0', projectPath: '/s/B.csproj' },
      { resolvedVersion: '3.0.4', projectPath: '/s/C.csproj' },
      { resolvedVersion: '3.0.2', projectPath: '/s/D.csproj' },
    ];
    const spread = resolveVersionSpread(entries, [])!;
    const cell = versionCellFor(spread, entries);
    expect(cell.crossesMajor).toBe(false);
    expect(cell.axis).toBeUndefined();
  });

  it('marks the count even when the major-crossing version is itself folded away, not shown', () => {
    const entries = [
      { resolvedVersion: '9.0.5', projectPath: '/s/A.csproj' },
      { resolvedVersion: '9.0.3', projectPath: '/s/B.csproj' },
      { resolvedVersion: '9.0.1', projectPath: '/s/C.csproj' },
      { resolvedVersion: '6.0.0', projectPath: '/s/D.csproj' },
    ];
    const spread = resolveVersionSpread(entries, [])!;
    const cell = versionCellFor(spread, entries);
    expect(cell.rest).toEqual(['9.0.3']);
    expect(cell.moreCount).toBe(2);
    expect(cell.crossesMajor).toBe(true);
    // The count already carries the mark here, so the axis badge stays out of the way.
    expect(cell.axis).toBeUndefined();
  });
});

describe('versionSpreadTooltip', () => {
  it('returns nothing for a single entry — there is no spread to explain', () => {
    expect(versionSpreadTooltip([{ resolvedVersion: '8.0.4', projectPath: '/s/Only.csproj' }], undefined))
      .toBeUndefined();
  });

  it('lists version first, one line per project, newest project group first (#115)', () => {
    const tooltip = versionSpreadTooltip([
      { resolvedVersion: '3.1.0', projectPath: '/s/Example.Shop.Api.csproj' },
      { resolvedVersion: '3.1.0', projectPath: '/s/Example.Shop.Admin.csproj' },
      { resolvedVersion: '2.8.1', projectPath: '/s/Example.Shop.Jobs.csproj' },
    ], false);
    expect(tooltip).toBe(
      'Versions across projects\n'
      + '3.1.0  Example.Shop.Admin\n'
      + '3.1.0  Example.Shop.Api\n'
      + '2.8.1  Example.Shop.Jobs',
    );
  });

  it('names the project once, in the heading, when the spread is between its own frameworks', () => {
    const tooltip = versionSpreadTooltip([
      { resolvedVersion: '3.1.0', projectPath: '/s/Example.Shop.Api.csproj', framework: 'net10.0' },
      { resolvedVersion: '2.8.1', projectPath: '/s/Example.Shop.Api.csproj', framework: 'net8.0' },
    ], true);
    expect(tooltip).toBe(
      'Versions across frameworks — Example.Shop.Api\n'
      + '3.1.0  net10.0\n'
      + '2.8.1  net8.0',
    );
  });

  it('groups the same project by its normalized path, not the raw string (#82 pairKey precedent)', () => {
    const tooltip = versionSpreadTooltip([
      { resolvedVersion: '3.1.0', projectPath: 'D:\\src\\Example.Shop.Api.csproj', framework: 'net10.0' },
      { resolvedVersion: '2.8.1', projectPath: 'd:/src/Example.Shop.Api.csproj', framework: 'net8.0' },
    ], false);
    expect(tooltip).toBe(
      'Versions across projects\n'
      + 'Example.Shop.Api\n'
      + '  3.1.0  net10.0\n'
      + '  2.8.1  net8.0',
    );
  });

  it('keeps the project shape for a mix, indenting the one project that is itself framework-split', () => {
    const tooltip = versionSpreadTooltip([
      { resolvedVersion: '3.1.0', projectPath: '/s/Example.Shop.Api.csproj', framework: 'net10.0' },
      { resolvedVersion: '2.8.1', projectPath: '/s/Example.Shop.Api.csproj', framework: 'net8.0' },
      { resolvedVersion: '2.8.1', projectPath: '/s/Example.Shop.Jobs.csproj' },
    ], false);
    expect(tooltip).toBe(
      'Versions across projects\n'
      + 'Example.Shop.Api\n'
      + '  3.1.0  net10.0\n'
      + '  2.8.1  net8.0\n'
      + '2.8.1  Example.Shop.Jobs',
    );
  });
});
