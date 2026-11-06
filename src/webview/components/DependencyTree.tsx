import React from 'react';
import { isTreeDepthCapped, treeIndentPx } from '../utils/treeNesting';

/** The shape the tree walks: anything with an identity and children of its own kind. */
export interface DependencyTreeNode {
  id: string;
  children: DependencyTreeNode[];
}

interface DependencyTreeProps<N extends DependencyTreeNode> {
  rows: N[];
  /**
   * What goes inside one row, left to right: the id and then the right-hand
   * slot. The tree owns the nesting around it; each caller owns what the slot
   * says (a resolved version in the details panel, a version pair in the
   * dependents proposal).
   */
  renderRow: (row: N, depth: number) => React.ReactNode;
  /** Draw nested rows in the muted colour, as the details panel does. */
  dimNested?: boolean;
  /** Extra classes for one row — the cascade dims a row it could not judge, and marks the one selected. */
  rowClass?: (row: N, depth: number) => string | undefined;
  /** Makes the rows clickable. The row element is a button-like row, not a link. */
  onRowClick?: (row: N) => void;
  /**
   * Gives every row the width it is indented by (`--bleed`), so a highlight can
   * run the whole width of the tree whatever the row's depth (#109).
   */
  bleed?: boolean;
}

/**
 * One nested tree for every list of dependencies (#137). A child list sits
 * inside its parent's node, behind a guide line, so the depth of a package is
 * visible: one hop away and five hops away no longer look alike. Indentation
 * grows for three levels and then stops, leaving the guide lines to carry the
 * rest — see `treeNesting.ts`.
 */
export function DependencyTree<N extends DependencyTreeNode>(props: DependencyTreeProps<N>) {
  return <TreeLevel {...props} depth={0} />;
}

function TreeLevel<N extends DependencyTreeNode>(props: DependencyTreeProps<N> & { depth: number }) {
  const { rows, depth, renderRow, dimNested = false, rowClass, onRowClick, bleed = false } = props;
  return (
    <>
      {rows.map((row) => {
        const classes = [
          'dep-row',
          dimNested && depth > 0 ? 'dep-row--dim' : '',
          onRowClick ? 'dep-row--pick' : '',
          rowClass?.(row, depth) ?? '',
        ].filter(Boolean).join(' ');
        return (
          <div className="dep-tree__node" key={row.id}>
            <div
              className={classes}
              style={bleed ? ({ '--bleed': `${treeIndentPx(depth)}px` } as React.CSSProperties) : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              role={onRowClick ? 'button' : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={onRowClick
                ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onRowClick(row);
                  }
                }
                : undefined}
            >
              {renderRow(row, depth)}
            </div>
            {row.children.length > 0 && (
              <div className={`dep-tree__children${isTreeDepthCapped(depth + 1) ? ' dep-tree__children--capped' : ''}`}>
                <TreeLevel {...props} rows={row.children as N[]} depth={depth + 1} />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
