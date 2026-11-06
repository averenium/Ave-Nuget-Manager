import React, { useMemo } from 'react';
import type { CascadeNode } from '../../cascadeResult';
import { packageIdKey } from '../../pathCompare';
import { pairOf, rangeLabel, rangeTooltip } from '../utils/cascadeView';
import { DependencyTree } from './DependencyTree';

interface Props {
  rows: CascadeNode[];
  /** Draws a row as the closure's root: bold id, no range. */
  rootId?: string;
  selectedId?: string | null;
  onSelect?: (node: CascadeNode) => void;
  /** Rows bleed to the tree's left edge, so a selection spans the line (the page). */
  bleed?: boolean;
  /** Members that go against the root, by package id key — each carries the word. */
  against?: ReadonlyMap<string, 'upgrade' | 'downgrade'>;
  /** Under a central version, where a row comes from — printed before its range (the page). */
  inOf?: (node: CascadeNode) => string | undefined;
}

/** Ids of every row between the root and `selectedId`, so the chain up to the header reads without a second selected row. */
function pathTo(rows: CascadeNode[], selectedId: string | null | undefined): Set<string> {
  const path = new Set<string>();
  if (!selectedId) return path;
  const visit = (node: CascadeNode, trail: string[]): boolean => {
    if (node.id === selectedId) {
      trail.forEach((id) => path.add(id));
      return true;
    }
    return node.children.some((child) => visit(child, [...trail, node.id]));
  };
  rows.some((row) => visit(row, []));
  return path;
}

/**
 * The closure as `DependencyTree` rows (#109): the right-hand slot holds the
 * range the dependent declares for what it hangs from, and the version pair.
 * A dependent that could not be judged stays in the tree, dimmed, with its
 * reason in the range's place — dim, don't remove.
 */
export function CascadeTree({ rows, rootId, selectedId, onSelect, bleed, against, inOf }: Props) {
  const onPath = useMemo(() => pathTo(rows, selectedId), [rows, selectedId]);

  return (
    <div className={`cascade-tree${bleed ? ' cascade-tree--pick' : ''}${rootId ? ' cascade-tree--root' : ''}`}>
      <DependencyTree
        rows={rows}
        bleed={bleed}
        onRowClick={onSelect}
        rowClass={(node) => [
          node.status === 'unknown' || node.status === 'left-out' ? 'popup__item--incompatible' : '',
          node.id === selectedId ? 'dep-row--selected' : '',
          onPath.has(node.id) ? 'dep-row--onpath' : '',
        ].filter(Boolean).join(' ')}
        renderRow={(node) => {
          const pair = pairOf(node);
          const unknown = node.status === 'unknown' || node.status === 'left-out';
          const isRoot = node.id === rootId;
          return (
            <>
              <span
                className="dep-row__id"
                title={unknown && node.reason ? `${node.id} — ${node.reason.detail}` : node.id}
              >
                {isRoot ? <span className="cascade-row__root">{node.id}</span> : node.id}
              </span>
              <span className="cascade-row__meta">
                {against?.get(packageIdKey(node.id)) && (
                  <span className="cascade-row__src">{against.get(packageIdKey(node.id))}</span>
                )}
                {inOf?.(node) && <span className="cascade-row__in">{inOf(node)}</span>}
                {unknown
                  ? <span className="cascade-row__why">{node.reason?.label}</span>
                  : node.range && !isRoot
                    ? <span className="cascade-row__range" title={rangeTooltip(node)}>{rangeLabel(node)}</span>
                    : null}
                {!node.project && (
                  <span className={`popup__ver popup__ver--${pair.tone}`}>
                    {pair.from} → {pair.to}
                  </span>
                )}
              </span>
            </>
          );
        }}
      />
    </div>
  );
}
