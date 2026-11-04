import React from 'react';
import { isTreeDepthCapped } from '../utils/treeNesting';

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
}

/**
 * One nested tree for every list of dependencies (#137). A child list sits
 * inside its parent's node, behind a guide line, so the depth of a package is
 * visible: one hop away and five hops away no longer look alike. Indentation
 * grows for three levels and then stops, leaving the guide lines to carry the
 * rest — see `treeNesting.ts`.
 */
export function DependencyTree<N extends DependencyTreeNode>({ rows, renderRow, dimNested = false }: DependencyTreeProps<N>) {
  return <TreeLevel rows={rows} depth={0} renderRow={renderRow} dimNested={dimNested} />;
}

function TreeLevel<N extends DependencyTreeNode>({ rows, depth, renderRow, dimNested }: DependencyTreeProps<N> & { depth: number }) {
  return (
    <>
      {rows.map((row) => (
        <div className="dep-tree__node" key={row.id}>
          <div className={`dep-row${dimNested && depth > 0 ? ' dep-row--dim' : ''}`}>
            {renderRow(row, depth)}
          </div>
          {row.children.length > 0 && (
            <div className={`dep-tree__children${isTreeDepthCapped(depth + 1) ? ' dep-tree__children--capped' : ''}`}>
              <TreeLevel rows={row.children as N[]} depth={depth + 1} renderRow={renderRow} dimNested={dimNested} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}
