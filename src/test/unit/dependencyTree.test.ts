import { readFileSync } from 'fs';
import { join } from 'path';
import {
  TREE_CAPPED_STEP_PX,
  TREE_MAX_STEPS,
  TREE_STEP_PX,
  isTreeDepthCapped,
  treeGuideCount,
  treeIndentPx,
  treeStepPx,
} from '../../webview/utils/treeNesting';
import { dependencyRowParts } from '../../webview/utils/dependencyRowParts';
import type { DependencyRow } from '../../types';

const css = readFileSync(join(__dirname, '../../webview/styles/global.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.>[\]()]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1];
}

function px(declarations: string, property: string): number {
  const match = new RegExp(`${property}:\\s*(\\d+)(?:px)?`).exec(declarations);
  if (!match) throw new Error(`no ${property} in ${declarations}`);
  return Number(match[1]);
}

describe('tree indentation (#137)', () => {
  it('gives three distinct indentations to a tree three levels deep', () => {
    const edges = [0, 1, 2, 3].map(treeIndentPx);
    expect(new Set(edges).size).toBe(4);
    expect(edges).toEqual([0, 14, 28, 42]);
  });

  it('stops indenting after three steps and leaves the guide lines to carry the depth', () => {
    expect(isTreeDepthCapped(TREE_MAX_STEPS)).toBe(false);
    expect(isTreeDepthCapped(TREE_MAX_STEPS + 1)).toBe(true);

    // The fifth level sits where the third does, give or take the lines it adds:
    // 2px each, against the 14px a step costs before the cap.
    expect(treeStepPx(4)).toBe(TREE_CAPPED_STEP_PX);
    expect(treeStepPx(5)).toBe(TREE_CAPPED_STEP_PX);
    expect(treeIndentPx(5) - treeIndentPx(3)).toBe(2 * TREE_CAPPED_STEP_PX);

    // ...and under distinct guide lines: one more per ancestor.
    expect(treeGuideCount(3)).toBe(3);
    expect(treeGuideCount(5)).toBe(5);
    expect(treeGuideCount(0)).toBe(0);
  });

  it('keeps the deepest walk anything produces inside the narrowest details pane', () => {
    const MIN_DETAIL_PX = 180; // SplitPane.tsx
    // Measured: the deepest tree under demo/ has four levels of rows, three steps.
    expect(treeIndentPx(3)).toBeLessThanOrEqual(3 * TREE_STEP_PX);
    // The cascade of #109 caps its walk at ten levels.
    expect(treeIndentPx(10)).toBeLessThanOrEqual(56);
    expect(MIN_DETAIL_PX - treeIndentPx(10)).toBeGreaterThanOrEqual(124);
  });

  it('draws in the stylesheet the same steps the code reasons with', () => {
    const level = rule('.dep-tree__children');
    // margin + padding + the one-pixel guide line
    expect(px(level, 'margin-left') + px(level, 'padding-left') + 1).toBe(TREE_STEP_PX);
    expect(level).toMatch(/border-left:\s*1px solid var\(--color-tree-guide\)/);

    const capped = rule('.dep-tree__children--capped');
    expect(px(capped, 'margin-left') + px(capped, 'padding-left') + 1).toBe(TREE_CAPPED_STEP_PX);
  });

  it('takes the editor tree-guide token for the guide line, the border where a theme has none', () => {
    expect(css).toMatch(/--color-tree-guide:\s*var\(--vscode-tree-indentGuidesStroke,\s*var\(--color-border\)\)/);
  });
});

describe('dependencyRowParts (#86, #137)', () => {
  const row = (over: Partial<DependencyRow>): DependencyRow => ({
    id: 'Example.Core',
    resolvedVersion: '2.1.0',
    declaredRange: '[2.0.0, )',
    status: 'ok',
    showDeclared: false,
    children: [],
    ...over,
  });

  it('shows only the resolved version for a bare floor that was simply met', () => {
    expect(dependencyRowParts(row({}))).toEqual({
      hint: undefined, warning: false, range: undefined, version: '2.1.0', versionBad: false,
    });
  });

  it('shows the range of an ok row whose range has a ceiling', () => {
    expect(dependencyRowParts(row({ showDeclared: true, declaredRange: '[2.0.0, 3.0.0)' }))).toMatchObject({
      range: '[2.0.0, 3.0.0)', warning: false, versionBad: false,
    });
  });

  it('marks an outside-range row with the glyph, the range and a red version', () => {
    expect(dependencyRowParts(row({ status: 'outside-range', showDeclared: true, declaredRange: '[1.0.0, 2.0.0)' }))).toEqual({
      hint: undefined, warning: true, range: '[1.0.0, 2.0.0)', version: '2.1.0', versionBad: true,
    });
  });

  it('replaces the range with "asked X" for a major-lifted row, and never turns the version red', () => {
    expect(dependencyRowParts(row({ status: 'major-lifted', showDeclared: true, declaredRange: '1.0.0' }))).toEqual({
      hint: 'asked 1.0.0', warning: false, range: undefined, version: '2.1.0', versionBad: false,
    });
  });

  it('prints a dash where the dependency has no resolved version', () => {
    expect(dependencyRowParts(row({ resolvedVersion: undefined })).version).toBe('—');
  });
});
