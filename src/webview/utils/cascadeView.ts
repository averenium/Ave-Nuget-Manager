import {
  CASCADE_POPUP_ROWS,
  impliedCount,
  type CascadeMode,
  type CascadeNode,
  type CascadeResult,
} from '../../cascadeResult';
import { compareSemVer } from '../../semver';
import { classifyDependencyRow, parseNuGetVersionRange, versionSatisfiesRange } from '../../packageVersionRanges';
import type { CascadeAction } from '../../messages';
import { packageIdKey } from '../../pathCompare';

/**
 * What the dependents proposal says and offers, as plain data (#109). The
 * popup and the page both draw from these, so what they say is decided — and
 * tested — in one place, and the components only lay it out.
 */

/** Which surface the closure belongs on. */
export type CascadeContainer =
  /** Nothing has to move: the write goes ahead, or the person is told so. */
  | 'none'
  | 'popup'
  /** Too large to read in a popup, and nothing is waiting: straight to the page. */
  | 'page';

/** A run of a sentence, so a number can be bold and an id can be code without markup in the data. */
export interface Segment {
  text: string;
  strong?: boolean;
  code?: boolean;
}

export interface CascadeButton {
  /** `review` opens the page; `close` just dismisses. The rest are the decisions the host knows. */
  action: CascadeAction | 'review' | 'close';
  label: string;
  primary?: boolean;
}

export type PairTone = 'up' | 'down' | 'flat';

const seg = (text: string, flags: Omit<Segment, 'text'> = {}): Segment => ({ text, ...flags });

/** Dependents the closure proposes to move, plus those it could not judge — the rows below the root. */
export function rowCount(result: CascadeResult): number {
  // Every row that is drawn, the ones that move with the packages above included.
  return result.moves + result.unknowns + result.leftOut + impliedCount(result);
}

/** What a row that moves with the ones above prints where a range would be. */
export const VIRTUAL_LABEL = 'moves with those above';

export function containerFor(result: CascadeResult, mode: CascadeMode): CascadeContainer {
  if (result.outcome === 'clear') return 'none';
  // A dead end is always a popup: one row of consequence and one decision.
  if (result.outcome === 'dead-end') return 'popup';
  // With nothing to propose there is no tree, so nothing a page would show.
  if (result.outcome === 'unknown') return 'popup';
  // A write already in flight cannot wait for a surface to open.
  if (mode === 'apply') return 'popup';
  return rowCount(result) > CASCADE_POPUP_ROWS ? 'page' : 'popup';
}

/** Whether the popup states the count and offers the page instead of drawing it all. */
export function offersPage(result: CascadeResult, mode: CascadeMode): boolean {
  return result.outcome === 'proposal' && mode === 'apply' && rowCount(result) > CASCADE_POPUP_ROWS;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** Small counts as words inside a sentence ("forces two other packages"), digits past ten. */
const countWord = (n: number): string => (n >= 0 && n < COUNT_WORDS.length ? COUNT_WORDS[n] : String(n));

/** The file a central write goes to, as its name. */
export function propsName(result: CascadeResult): string | undefined {
  return result.central?.propsFile.split(/[\\/]/).pop();
}

/** How many of the closure's rows stand for a project that could not be judged. */
export function projectUnknowns(result: CascadeResult): number {
  let n = 0;
  const walk = (node: CascadeNode): void => {
    if (node.project && node.status === 'unknown') n += 1;
    node.children.forEach(walk);
  };
  walk(result.root);
  return n;
}

/** Where a row comes from, for the page's *In* column: the project's name, or how many. Absent without a central version. */
export function inLabel(node: CascadeNode, result: CascadeResult): string | undefined {
  if (!result.central || node.project || !node.projects || node.projects.length === 0) return undefined;
  return node.projects.length === 1 ? projectLabel(node.projects[0]) : `${node.projects.length} projects`;
}

/** The page's header under a central version: the file, then a badge per project, cut to a few with the rest counted. */
export function centralBadges(result: CascadeResult, shownProjects = 3): { file: string; shown: string[]; more: number; all: string[] } | undefined {
  if (!result.central) return undefined;
  const all = result.central.projects.map(projectLabel);
  return { file: propsName(result)!, shown: all.slice(0, shownProjects), more: Math.max(0, all.length - shownProjects), all };
}

/**
 * The members that move the other way from the root, by id: inside an upgrade
 * one that goes down, inside a downgrade one that goes up. Both are legitimate
 * — a dependent whose newer versions cap what the root is going to — but one
 * must not read like the rest, and colour alone is not enough, so the row says
 * it in a word. A closure with no such member draws exactly as before.
 */
export function movesAgainstRoot(result: CascadeResult): Map<string, 'upgrade' | 'downgrade'> {
  const against = new Map<string, 'upgrade' | 'downgrade'>();
  const rootTone = pairTone(result.fromVersion, result.toVersion);
  if (rootTone === 'flat') return against;
  const walk = (node: CascadeNode): void => {
    if (node !== result.root && node.status === 'moves') {
      const tone = pairOf(node).tone;
      if (tone !== 'flat' && tone !== rootTone) against.set(packageIdKey(node.id), tone === 'down' ? 'downgrade' : 'upgrade');
    }
    node.children.forEach(walk);
  };
  walk(result.root);
  return against;
}

/** The lead's clause for members that go against the root: "— 1 of them moves down." */
function directionClause(result: CascadeResult, asSentence = false): Segment[] {
  const n = movesAgainstRoot(result).size;
  if (n === 0) return [];
  const way = pairTone(result.fromVersion, result.toVersion) === 'up' ? 'down' : 'up';
  return [
    seg(asSentence ? ' ' : ' — '), seg(String(n), { strong: true }),
    seg(` of them ${plural(n, 'moves', 'move')} ${way}`),
  ];
}

export function leadFor(result: CascadeResult, mode: CascadeMode, surface: 'popup' | 'page' = 'popup'): Segment[] {
  const target = seg(result.toVersion, { strong: true });
  const projectCount = result.central?.projects.length ?? 0;

  if (result.outcome === 'dead-end' && result.deadEnd?.constraints) {
    const node = result.deadEnd;
    const fixed = node.constraints!.find((c) => c.kind === 'fixed');
    const disagreeing = disagreeingProjects(result);
    if (disagreeing.length > 1) {
      // Between projects: one version is asked of all of them, and these disagree.
      return [
        seg('No version of '), seg(node.id, { code: true }), seg(` suits all ${projectCount} projects at once. `),
        seg(`${countWord(disagreeing.length)[0].toUpperCase()}${countWord(disagreeing.length).slice(1)} of them disagree:`),
      ];
    }
    return fixed
      ? [
        seg('No version of '), seg(node.id, { code: true }), seg(' works with '), seg(fixed.id, { code: true }), seg(' '),
        seg(fixed.version ?? '', { strong: true }), seg(', the version being installed:'),
      ]
      : [seg('No version of '), seg(node.id, { code: true }), seg(' satisfies everything that has to hold at once:')];
  }

  if (result.outcome === 'dead-end' && result.deadEnd) {
    const node = result.deadEnd;
    const ranges = node.deadEndRanges ?? [];
    const edge = ranges.length === 1
      ? [seg(' — every release stops at '), seg(ranges[0], { code: true }), seg('.')]
      : [seg(' — its releases declare '), ...ranges.flatMap((r, i) => [seg(i > 0 ? ', ' : ''), seg(r, { code: true })]), seg('.')];
    return [
      seg('No version of '), seg(node.id, { code: true }), seg(' declares a range wide enough for '), target,
      ...(ranges.length > 0 ? edge : [seg('.')]),
      seg(' Taking this version breaks '), seg(node.id, { code: true }),
      seg(' at runtime with nothing that would bring it back in line.'),
    ];
  }

  if (result.outcome === 'unknown') {
    if (result.unknowns === 0) {
      // Everything that depends on it was judged and is left out on purpose.
      return [
        target, seg(' is depended on by '), seg(String(result.leftOut), { strong: true }),
        seg(` ${plural(result.leftOut, 'package that is', 'packages that are')} left out of the proposal — each row says why.`),
      ];
    }
    if (result.leftOut > 0) {
      return [
        target, seg(' may need other packages to move with it. For '), seg(String(result.unknowns), { strong: true }),
        seg(' we could not establish whether any version admits it.'),
        ...leftOutClause(result.leftOut),
      ];
    }
    if (projectUnknowns(result) === result.unknowns) {
      // Only projects could not be judged: say what could not be established, not who depends on it.
      const n = result.unknowns;
      return [
        target, seg(' may need other packages to move with it, but for '), seg(String(n), { strong: true }),
        seg(` ${plural(n, 'project', 'projects')} we could not establish what has to move.`),
      ];
    }
    return [
      target,
      seg(' may need other packages to move with it, but for '),
      ...(result.unknowns === 1
        ? [seg('the one package that depends on it')]
        : [seg('all '), seg(String(result.unknowns), { strong: true }), seg(' that depend on it')]),
      seg(' we could not establish whether any version admits it.'),
    ];
  }

  const moves = result.moves;
  const others = [seg(String(moves), { strong: true }), seg(` other ${plural(moves, 'package', 'packages')}`)];
  const unjudgedProjects = projectUnknowns(result);
  const unjudgedPackages = result.unknowns - unjudgedProjects;
  const unknown = [
    ...(unjudgedPackages > 0
      ? [
        seg(' For '), seg(String(unjudgedPackages), { strong: true }),
        seg(' more we could not establish whether any version of them admits it.'),
      ]
      : []),
    ...(unjudgedProjects > 0
      ? [
        seg(' For '), seg(String(unjudgedProjects), { strong: true }),
        seg(` ${plural(unjudgedProjects, 'project', 'projects')} we could not establish what has to move.`),
      ]
      : []),
  ];

  const left = result.leftOut > 0 ? leftOutClause(result.leftOut) : [];
  const direction = directionClause(result);
  if (result.central && surface === 'popup' && unjudgedProjects === 0 && !offersPage(result, mode)) {
    // Said where the reader starts: the file the version is set in, and how many
    // projects were checked, in the same breath as the count.
    return [
      target, seg(` forces ${countWord(moves)} other ${plural(moves, 'package', 'packages')} to move in turn. It is set in `),
      seg(propsName(result)!, { code: true }), seg(`; the ${projectCount} projects that use it were checked.`),
      ...(direction.length > 0 ? [...directionClause(result, true), seg('.')] : []),
      ...unknown, ...left,
    ];
  }
  if (offersPage(result, mode)) {
    return [
      target, seg(' needs '), ...others,
      seg(' to move with it — more than fits in a popup. Review them on a page beside the package list, or take them all.'),
      ...(direction.length > 0 ? [...directionClause(result, true), seg('.')] : []),
      ...unknown, ...left,
    ];
  }
  return [target, seg(' needs '), ...others, seg(' to move with it'), ...(direction.length > 0 ? direction : []), seg('.'), ...unknown, ...left];
}

/**
 * Taking the proposal over a set with rows left out writes a set that is
 * incomplete by choice, which is not the same as one that is incomplete because
 * the feed could not say. The difference is read before the button is pressed.
 */
function leftOutClause(n: number): Segment[] {
  return [
    seg(' '), seg(String(n), { strong: true }),
    seg(` ${plural(n, 'more is', 'more are')} left out and not written — each row says why.`),
  ];
}

/**
 * The constraints that cannot both hold, one line each, under the lead of a dead
 * end between several (decision 4). Empty for a dead end with one reason.
 */
export function deadEndLines(result: CascadeResult): Segment[][] {
  const node = result.deadEnd;
  if (result.outcome !== 'dead-end' || !node?.constraints) return [];
  const between = disagreeingProjects(result).length > 1;
  return node.constraints.map((c): Segment[] => {
    if (between && c.projects && c.projects.length > 0) return betweenLine(node, c);
    const who = seg(`${c.id}${c.version ? ` ${c.version}` : ''}`, { strong: true });
    switch (c.kind) {
      case 'requires':
        return [who, seg(' requires '), seg(c.range ?? '', { code: true })];
      case 'admits':
        return [who, seg(' — '), seg(node.id, { code: true }), seg(' has to declare a range that admits it')];
      case 'floor':
        // A project this one references: its requirement is a minimum, and it is
        // said to be one, since nothing about the row's package names it.
        return [seg(c.id, { strong: true }), seg(', a project this one references, requires '), seg(c.range ?? '', { code: true })];
      case 'fixed':
        return c.range
          ? [who, seg(' — every release of '), seg(node.id, { code: true }), seg(' that high declares '), seg(c.range, { code: true })]
          : [who, seg(' — the version being installed')];
    }
  });
}

/** The projects whose constraints meet in a dead end, once each (paths). */
function disagreeingProjects(result: CascadeResult): string[] {
  const out: string[] = [];
  for (const c of result.deadEnd?.constraints ?? []) {
    for (const p of c.projects ?? []) if (!out.some((o) => o === p)) out.push(p);
  }
  return result.central ? out : [];
}

/** One line of a dead end between projects: the project in front, then what it states. */
function betweenLine(node: CascadeNode, c: NonNullable<CascadeNode['constraints']>[number]): Segment[] {
  const projects = seg((c.projects ?? []).map(projectLabel).join(', '), { strong: true });
  switch (c.kind) {
    case 'requires':
      return [projects, seg(' — '), seg(c.id, { code: true }), seg(` ${c.version ?? ''} requires `), seg(node.id, { code: true }), seg(' '), seg(c.range ?? '', { code: true })];
    case 'admits':
      return [projects, seg(' — admitting '), seg(c.id, { code: true }), seg(` ${c.version ?? ''} needs `), seg(node.id, { code: true }), seg(' to declare a range that admits it')];
    case 'floor':
      return [projects, seg(' — '), seg(c.id, { code: true }), seg(', a project this one references, requires '), seg(c.range ?? '', { code: true })];
    case 'fixed':
      return [projects, seg(' — the version being installed')];
  }
}

/**
 * Under a dead end between projects: the real remedy, named though no button
 * performs it. Writing an override is its own decision; it goes to a project
 * file, not the central one, and it un-centralises an id on purpose.
 */
export function overrideNote(result: CascadeResult): Segment[] {
  const node = result.deadEnd;
  if (!node || disagreeingProjects(result).length < 2) return [];
  return [seg('A project can take its own version of '), seg(node.id, { code: true }), seg(' with '), seg('VersionOverride', { code: true }), seg('.')];
}

/** The sentence under the dead end's lead — the thing the decision is about. */
export function deadEndAdvice(): string {
  return "This bump isn't safe yet. Blocking it keeps it off every batch update until that changes.";
}

export function takeAllLabel(result: CascadeResult): string {
  return result.moves === 1 ? 'Take both' : `Take all ${result.moves}`;
}

/**
 * What each state carries (#109, the design's "rule, state by state").
 *
 * The bump on its own is one button away in every state. Two labels, each with
 * one meaning: **Update only this package** declines a proposal and writes the
 * bump alone; **Update anyway** goes ahead with what was established — the bump
 * alone when nothing was, so with nothing to decline it is the only way out and
 * there is no second button. Neither lets a dependent be left out of a proposal
 * that is taken: there are no checkboxes, and a cascade's members are linked.
 */
export function actionsFor(result: CascadeResult, mode: CascadeMode): CascadeButton[] {
  const dismiss: CascadeButton = mode === 'apply'
    ? { action: 'cancel', label: 'Cancel' }
    : { action: 'close', label: 'Close' };
  const updateOnly: CascadeButton = { action: 'update-only', label: 'Update only this package' };

  if (result.outcome === 'dead-end') {
    // A dead end that offered only the dismissal or the block would trap the
    // update: it has just been said what it breaks, and it is still the
    // person's update. Block stays the primary because it is what is recommended.
    return [
      dismiss,
      { action: 'update-anyway', label: 'Update anyway' },
      { action: 'block', label: 'Block this update', primary: true },
    ];
  }

  if (result.outcome === 'unknown') {
    // Nothing was established, so there is nothing to decline.
    return [dismiss, { action: 'update-anyway', label: 'Update anyway', primary: true }];
  }

  if (result.unknowns > 0) {
    // Never "take all" over a set that is not complete. Asked on a row, nothing
    // is in flight: the incomplete answer has no primary action.
    return mode === 'apply'
      ? [dismiss, updateOnly, { action: 'update-anyway', label: 'Update anyway', primary: true }]
      : [dismiss, updateOnly];
  }

  const take: CascadeButton = { action: 'take-all', label: takeAllLabel(result), primary: true };
  if (offersPage(result, mode)) return [dismiss, { action: 'review', label: 'Review on a page' }, updateOnly, take];
  return [dismiss, updateOnly, take];
}

/** The reasons dependents could not be judged, each with the packages it applies to — one line per reason. */
export function unknownGroups(result: CascadeResult): Array<{ label: string; ids: string[] }> {
  const groups: Array<{ label: string; ids: string[] }> = [];
  const walk = (node: CascadeNode): void => {
    if ((node.status === 'unknown' || node.status === 'left-out') && node.reason) {
      const group = groups.find((g) => g.label === node.reason!.label);
      if (group) group.ids.push(node.id);
      else groups.push({ label: node.reason.label, ids: [node.id] });
    }
    node.children.forEach(walk);
  };
  walk(result.root);
  return groups;
}

export function pairTone(from: string, to: string | undefined): PairTone {
  if (!to) return 'flat';
  const cmp = compareSemVer(to, from);
  return cmp > 0 ? 'up' : cmp < 0 ? 'down' : 'flat';
}

/** `2.4.0 → —` for a row that cannot say where it moves to. */
export function pairOf(node: CascadeNode): { from: string; to: string; tone: PairTone } {
  const to = node.status === 'moves' ? node.proposedVersion : undefined;
  return { from: node.installedVersion, to: to ?? '—', tone: pairTone(node.installedVersion, to) };
}

/**
 * The tree cut to its first `rows` rows below the root, in the order the walk
 * found them — shallowest first — so a closure past the threshold shows what
 * kind of set it is. `hidden` is what was left out.
 */
export function previewOf(result: CascadeResult, rows: number): { root: CascadeNode; hidden: number } {
  let remaining = rows;
  const queue: Array<{ source: CascadeNode; copy: CascadeNode }> = [];
  const copyOf = (source: CascadeNode): CascadeNode => ({ ...source, children: [] });
  const root = copyOf(result.root);
  queue.push({ source: result.root, copy: root });
  let shown = 0;
  while (queue.length > 0 && remaining > 0) {
    const { source, copy } = queue.shift()!;
    for (const child of source.children) {
      if (remaining === 0) break;
      const next = copyOf(child);
      copy.children.push(next);
      queue.push({ source: child, copy: next });
      remaining -= 1;
      shown += 1;
    }
  }
  return { root, hidden: Math.max(0, rowCount(result) - shown) };
}

/**
 * What the page's foot says. Normally what a decision writes; on a page the
 * panel has moved on from, that the figures belong to the moment it was
 * computed; and nothing at all when part of the set could not be judged, because
 * what *Update anyway* would write is then not a number the page stands behind.
 */
export function consequenceLine(result: CascadeResult, stale = false): string {
  if (stale) return 'Computed for the versions above';
  if (result.unknowns > 0) return '';
  const changes = result.moves + 1;
  // Packages are counted once, and the projects separately: one version moves them all.
  if (result.central) {
    return `${changes} ${plural(changes, 'change', 'changes')} in ${propsName(result)}, used by ${result.central.projects.length} projects`;
  }
  return `${changes} ${plural(changes, 'change', 'changes')} in ${projectLabel(result.projectPath)}`;
}

export function projectLabel(projectPath: string): string {
  const name = projectPath.split(/[\\/]/).pop() ?? projectPath;
  return name.replace(/\.(cs|fs|vb)proj$/i, '');
}

/** One sentence about a row's range, for its tooltip — the edge points the other way from the details panel. */
export function rangeTooltip(node: CascadeNode): string | undefined {
  if (!node.parentId || !node.range) return undefined;
  if (node.direction === 'forward') {
    // The edge runs the other way: the package above requires this row.
    const by = node.requirements?.[0];
    return by ? `${by.id} ${by.version} requires ${node.id} ${node.range}` : undefined;
  }
  return `${node.id} ${node.proposedVersion ?? node.installedVersion} declares ${node.parentId} ${node.range}`;
}

/** What a row prints in its range slot: the range alone for a reverse row, `required` before it for a forward one. */
export function rangeLabel(node: CascadeNode): string | undefined {
  if (!node.range) return undefined;
  return node.direction === 'forward' ? `required ${node.range}` : node.range;
}

// ── The page's detail pane ──────────────────────────────────────────────────

export function findNode(result: CascadeResult, id: string | null | undefined): CascadeNode | undefined {
  if (!id) return undefined;
  const visit = (node: CascadeNode): CascadeNode | undefined => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(result.root);
}

/** The package a row hangs from, with the version it moves to — what its range is measured against. */
export function parentOf(result: CascadeResult, node: CascadeNode): CascadeNode | undefined {
  return node.parentId ? findNode(result, node.parentId) : undefined;
}

const majorOf = (version: string): string => version.split(/[.-]/, 1)[0] ?? '';

export interface ClosureMakeup {
  total: number;
  direct: number;
  indirect: number;
  crossMajor: number;
  sameLine: number;
  sources: Array<{ name: string; count: number }>;
  unknown: number;
  leftOut: number;
  /** Rows that move with the ones above and are not written. */
  implied: number;
}

/** What kind of set the closure is — the pane's first frame, before any row is picked. */
export function closureMakeup(result: CascadeResult): ClosureMakeup {
  const moving: CascadeNode[] = [];
  let unknown = 0;
  let leftOut = 0;
  let implied = 0;
  const walk = (node: CascadeNode): void => {
    if (node !== result.root) {
      if (node.status === 'moves' && node.virtual) implied += 1;
      else if (node.status === 'moves') moving.push(node);
      else if (node.status === 'unknown') unknown += 1;
      else if (node.status === 'left-out') leftOut += 1;
    }
    node.children.forEach(walk);
  };
  walk(result.root);

  const crossMajor = moving.filter((n) => majorOf(n.installedVersion) !== majorOf(n.proposedVersion ?? '')).length;
  const sources: ClosureMakeup['sources'] = [];
  for (const node of moving) {
    if (!node.sourceName) continue;
    const found = sources.find((s) => s.name === node.sourceName);
    if (found) found.count += 1;
    else sources.push({ name: node.sourceName, count: 1 });
  }
  sources.sort((a, b) => b.count - a.count);

  const direct = moving.filter((n) => n.parentId === result.root.id).length;
  return {
    total: moving.length,
    direct,
    indirect: moving.length - direct,
    crossMajor,
    sameLine: moving.length - crossMajor,
    sources,
    unknown,
    leftOut,
    implied,
  };
}

/** Why this row has to move: what its installed version declared, set against the version its parent goes to. */
export function whyLine(node: CascadeNode, parent: CascadeNode | undefined): Segment[] {
  const parentId = node.parentId ?? parent?.id;
  const parentTo = parent?.proposedVersion;
  if (!parentId || !parentTo) return [];
  if (node.direction === 'forward' && node.requirements?.[0] && node.status !== 'unknown' && node.status !== 'left-out') {
    // The forward reading of the reverse row's sentence: the package above
    // requires this row, rather than this row declaring the package above.
    const by = node.requirements[0];
    const range = parseNuGetVersionRange(by.range);
    const side = range.minVersion && compareSemVer(node.installedVersion, range.minVersion) < 0 ? 'below' : 'above';
    return [
      seg(by.id, { code: true }), seg(' '), seg(by.version, { strong: true }), seg(' requires '),
      seg(node.id, { code: true }), seg(' '), seg(by.range, { code: true }),
      seg('. The project has '), seg(node.installedVersion, { strong: true }), seg(`, which is ${side} it.`),
    ];
  }
  const declared = node.installedRange;
  if (node.virtual && node.proposedVersion) {
    return [
      seg(node.id, { code: true }),
      seg(' is not referenced by this project, so nothing is written for it. It moves to '),
      seg(node.proposedVersion, { strong: true }),
      seg(' once the packages above it do.'),
    ];
  }
  if (node.project && node.reason) {
    return [seg('We do not know what '), seg(node.id, { code: true }), seg(' needs of '), seg(parentId, { code: true }), seg(`: ${node.reason.detail}.`)];
  }
  if (node.status === 'unknown' && node.reason) {
    return [
      seg('We do not know whether any version of '), seg(node.id, { code: true }), seg(' admits '),
      seg(parentTo, { strong: true }), seg(` — ${node.reason.detail}.`),
    ];
  }
  if (node.status === 'left-out' && node.reason) {
    return [seg(node.id, { code: true }), seg(` is left out — ${node.reason.detail}.`)];
  }
  const where = inProjects(node);
  if (!declared) {
    return [...where, seg(node.installedVersion, { strong: true }), seg(' declares no range for '), seg(parentId, { code: true }), seg('.')];
  }
  if (!rangeAdmits(declared, parentTo)) {
    return [
      ...where,
      seg(node.installedVersion, { strong: true }), seg(' declares '), seg(parentId, { code: true }), seg(' '),
      seg(declared, { code: true }),
      seg(', which leaves out '), seg(parentTo, { strong: true }), seg(', the version '), seg(parentId, { code: true }), seg(' moves to.'),
    ];
  }
  const floor = parseNuGetVersionRange(declared).minVersion;
  if (floor && classifyDependencyRow(declared, parentTo).status === 'major-lifted') {
    // Asked for on a row: the range lets the new version in, but it is a minimum
    // from another major line, so the dependent was built against something else.
    // The root is the one version being installed; any other parent moves to its.
    const parentIsRoot = !parent?.parentId;
    return [
      ...where,
      seg(node.installedVersion, { strong: true }), seg(' asked for '), seg(parentId, { code: true }), seg(' '),
      seg(declared, { code: true }), seg(` — a minimum from the ${majorOf(floor)}.x line. `),
      seg(parentTo, { strong: true }),
      ...(parentIsRoot
        ? [seg(', the version being installed')]
        : [seg(', the version '), seg(parentId, { code: true }), seg(' moves to')]),
      seg(`, is a different major, so ${node.installedVersion} was built against something else.`),
    ];
  }
  return [
    ...where,
    seg(node.installedVersion, { strong: true }), seg(' declares '), seg(parentId, { code: true }), seg(' '),
    seg(declared, { code: true }), seg('.'),
  ];
}

/** "In Example.Shop.Worker, " — under a central version a sentence says which project it is about. */
function inProjects(node: CascadeNode): Segment[] {
  if (!node.projects || node.projects.length === 0) return [];
  return node.projects.length === 1
    ? [seg('In '), seg(projectLabel(node.projects[0]), { code: true }), seg(', ')]
    : [seg(`In ${node.projects.length} projects, `)];
}

/** Under an unknown row's sentence: what the page does not do, and where the rest of it is. */
/** Under a project that could not be judged: the rest of the answer is not in doubt. */
export const PROJECT_NOTE = 'Nothing is proposed for it. The rest of the answer stands.';

export const UNKNOWN_NOTE = 'Nothing is proposed for it. The package, the source and the step that gave up are in the Log tab.';

/** Under a row that moves with the ones above: why it is a row at all. */
export const VIRTUAL_NOTE = 'The packages that hold it are in the list below it; they are what is written.';

/** Under a left-out row's sentence: it was judged, and taking the proposal leaves it as it is. */
export const LEFT_OUT_NOTE = 'Nothing is proposed for it, and taking the proposal leaves it as it is.';

function rangeAdmits(range: string, version: string): boolean {
  // The walk decided this already; the sentence only needs to say which kind of
  // reason it was, so a plain re-check is enough.
  return versionSatisfiesRange(version, parseNuGetVersionRange(range));
}

export interface LadderRow {
  version: string;
  range: string;
  admits: boolean;
  tag: 'installed' | 'proposed' | '';
  proposed: boolean;
}

/**
 * The dependent's versions as the page's "Which version" ladder, oldest first,
 * as the mockup draws it.
 *
 * `parentVersion` is the version the package it hangs from goes to. A row whose
 * range lets that version in but is not marked as admitting it is a bare minimum
 * from an earlier major line, which an asked question does not accept; it reads
 * `asked [8.1.0, )`, so the reader sees why a range that formally fits is not
 * the one chosen.
 */
export function ladderRows(node: CascadeNode, parentVersion?: string): { rows: LadderRow[]; older: number; newer: number } {
  const rows = [...(node.window ?? [])].reverse().map((w): LadderRow => {
    const installed = compareSemVer(w.version, node.installedVersion) === 0;
    const proposed = !!node.proposedVersion && compareSemVer(w.version, node.proposedVersion) === 0;
    const lifted = !!parentVersion && !!w.range && !w.admits
      && versionSatisfiesRange(parentVersion, parseNuGetVersionRange(w.range))
      && classifyDependencyRow(w.range, parentVersion).status === 'major-lifted';
    return {
      version: w.version,
      // On a forward row there is one requirement for every version, stated
      // once above the ladder: a range on each row would print the same text.
      range: node.direction === 'forward' ? '' : lifted ? `asked ${w.range}` : (w.range ?? 'no dependency'),
      admits: w.admits,
      tag: proposed ? 'proposed' : installed ? 'installed' : '',
      proposed,
    };
  });
  return { rows, older: node.windowOlder ?? 0, newer: node.windowNewer ?? 0 };
}
