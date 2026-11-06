import type { CascadeNode, CascadeResult, UnknownReason } from '../../cascadeResult';
import { CASCADE_POPUP_ROWS } from '../../cascadeResult';
import {
  actionsFor,
  consequenceLine,
  containerFor,
  deadEndAdvice,
  deadEndLines,
  leadFor,
  movesAgainstRoot,
  offersPage,
  pairOf,
  previewOf,
  rangeLabel,
  rangeTooltip,
  unknownGroups,
  UNKNOWN_NOTE,
  LEFT_OUT_NOTE,
  overrideNote,
  PROJECT_NOTE,
  centralBadges,
  closureMakeup,
  findNode,
  inLabel,
  ladderRows,
  parentOf,
  whyLine,
  type Segment,
} from '../../webview/utils/cascadeView';

const TRANSPORT = 'Example.Messaging.Transport';

const moves = (id: string, from: string, to: string, children: CascadeNode[] = [], parentId = TRANSPORT): CascadeNode => ({
  id, installedVersion: from, proposedVersion: to, parentId, status: 'moves', range: '[7.2.0, )', children,
});
const unknown = (id: string, reason: Partial<UnknownReason> = {}): CascadeNode => ({
  id, installedVersion: '2.4.0', parentId: TRANSPORT, status: 'unknown', children: [],
  reason: { code: 'registration-too-large', label: 'registration too large', detail: 'x', ...reason },
});
const leftOut = (id: string, code: 'blocked' | 'not-direct' = 'blocked'): CascadeNode => ({
  id, installedVersion: '2.4.0', parentId: TRANSPORT, status: 'left-out', children: [],
  reason: { code, label: code === 'blocked' ? 'updates blocked' : 'not a direct reference', detail: `${id} is held back` },
});
const deadEnd = (id: string, ranges: string[]): CascadeNode => ({
  id, installedVersion: '7.8.0', parentId: TRANSPORT, status: 'dead-end', deadEndRanges: ranges, children: [],
});

function closure(children: CascadeNode[], over: Partial<CascadeResult> = {}): CascadeResult {
  const root: CascadeNode = { id: TRANSPORT, installedVersion: '6.8.1', proposedVersion: '7.2.2', status: 'moves', children };
  const all: CascadeNode[] = [];
  const walk = (n: CascadeNode) => { all.push(n); n.children.forEach(walk); };
  walk(root);
  const m = all.filter((n) => n !== root && n.status === 'moves').length;
  const u = all.filter((n) => n.status === 'unknown').length;
  const l = all.filter((n) => n.status === 'left-out').length;
  return {
    outcome: all.length === 1 ? 'clear' : m === 0 ? 'unknown' : 'proposal',
    mode: 'apply', packageId: TRANSPORT, fromVersion: '6.8.1', toVersion: '7.2.2',
    projectPath: 'D:/src/Example.Shop/Example.Shop.Infrastructure.csproj', framework: 'net10.0',
    root, moves: m, unknowns: u, leftOut: l, ...over,
  };
}

const text = (segments: Segment[]) => segments.map((s) => s.text).join('');
const many = (n: number) => Array.from({ length: n }, (_, i) => moves(`Example.Member${i}`, '1.0.0', '2.0.0'));

describe('which container a closure belongs in (#109)', () => {
  it('has none when nothing has to move', () => {
    expect(containerFor(closure([]), 'apply')).toBe('none');
  });

  it('is a popup up to the threshold of ten rows, whatever asked', () => {
    expect(containerFor(closure(many(CASCADE_POPUP_ROWS)), 'apply')).toBe('popup');
    expect(containerFor(closure(many(CASCADE_POPUP_ROWS)), 'asked')).toBe('popup');
  });

  it('opens a page straight away past the threshold when it was asked for on a row', () => {
    expect(containerFor(closure(many(CASCADE_POPUP_ROWS + 1)), 'asked')).toBe('page');
  });

  it('keeps a popup past the threshold while a write waits, and offers the page from it', () => {
    const big = closure(many(CASCADE_POPUP_ROWS + 1));
    expect(containerFor(big, 'apply')).toBe('popup');
    expect(offersPage(big, 'apply')).toBe(true);
    expect(offersPage(big, 'asked')).toBe(false);
    expect(offersPage(closure(many(3)), 'apply')).toBe(false);
  });

  it('counts the dependents that could not be judged towards the threshold', () => {
    const rows = [...many(CASCADE_POPUP_ROWS - 1), unknown('Example.A'), unknown('Example.B')];
    expect(containerFor(closure(rows), 'asked')).toBe('page');
  });

  it('keeps a dead end a popup however many rows are behind it', () => {
    const dead = closure(many(40), { outcome: 'dead-end', deadEnd: deadEnd('Example.Messaging.Bus', ['[6.0.0, 7.0.0)']) });
    expect(containerFor(dead, 'asked')).toBe('popup');
  });

  it('keeps a closure with nothing to propose a popup: there is no tree for a page to show', () => {
    const rows = Array.from({ length: 15 }, (_, i) => unknown(`Example.U${i}`));
    expect(containerFor(closure(rows), 'asked')).toBe('popup');
  });
});

describe('what the popup says (#109)', () => {
  it('counts the other packages in the lead', () => {
    expect(text(leadFor(closure(many(4)), 'apply'))).toBe('7.2.2 needs 4 other packages to move with it.');
    expect(text(leadFor(closure(many(1)), 'apply'))).toBe('7.2.2 needs 1 other package to move with it.');
  });

  it('states both counts when some dependents could not be judged', () => {
    expect(text(leadFor(closure([...many(2), unknown('Example.A'), unknown('Example.B')]), 'asked'))).toBe(
      '7.2.2 needs 2 other packages to move with it. For 2 more we could not establish whether any version of them admits it.',
    );
  });

  it('says so plainly when every dependent could not be judged', () => {
    const rows = [unknown('Example.A'), unknown('Example.B'), unknown('Example.C')];
    expect(text(leadFor(closure(rows), 'asked'))).toBe(
      '7.2.2 may need other packages to move with it, but for all 3 that depend on it we could not establish whether any version admits it.',
    );
  });

  it('states the count and offers the page past the threshold', () => {
    expect(text(leadFor(closure(many(23)), 'apply'))).toBe(
      '7.2.2 needs 23 other packages to move with it — more than fits in a popup. Review them on a page beside the package list, or take them all.',
    );
  });

  it('names the ceiling a dead end stops at', () => {
    const dead = closure([], { outcome: 'dead-end', deadEnd: deadEnd('Example.Messaging.Bus', ['[6.0.0, 7.0.0)']) });
    expect(text(leadFor(dead, 'apply'))).toBe(
      'No version of Example.Messaging.Bus declares a range wide enough for 7.2.2 — every release stops at [6.0.0, 7.0.0). '
      + 'Taking this version breaks Example.Messaging.Bus at runtime with nothing that would bring it back in line.',
    );
    expect(deadEndAdvice()).toContain('Blocking it keeps it off every batch update');
  });

  it('lists every range when a dead end has more than one', () => {
    const dead = closure([], { outcome: 'dead-end', deadEnd: deadEnd('Example.Bus', ['[5.0.0, 6.0.0)', '[6.0.0, 7.0.0)']) });
    expect(text(leadFor(dead, 'apply'))).toContain('its releases declare [5.0.0, 6.0.0), [6.0.0, 7.0.0).');
  });
});

describe('what the popup offers (#109)', () => {
  const labels = (r: CascadeResult, mode: 'apply' | 'asked') => actionsFor(r, mode).map((b) => b.label);

  it('offers the bump alone between leaving and taking the proposal, whether a write waits or the check was asked on a row', () => {
    expect(labels(closure(many(4)), 'apply')).toEqual(['Cancel', 'Update only this package', 'Take all 4']);
    expect(labels(closure(many(4)), 'asked')).toEqual(['Close', 'Update only this package', 'Take all 4']);
    expect(labels(closure(many(1)), 'apply')).toEqual(['Cancel', 'Update only this package', 'Take both']);
  });

  it('keeps the proposal the primary and the way out a plain secondary', () => {
    expect(actionsFor(closure(many(4)), 'apply').map((b) => [b.action, !!b.primary]))
      .toEqual([['cancel', false], ['update-only', false], ['take-all', true]]);
  });

  it('puts a review beside the way out past the threshold, with a write waiting', () => {
    expect(labels(closure(many(23)), 'apply')).toEqual(['Cancel', 'Review on a page', 'Update only this package', 'Take all 23']);
  });

  it('never offers take-all over a set that is not complete: Update anyway is the primary there, with a write waiting', () => {
    const mixed = closure([...many(2), unknown('Example.A')]);
    expect(labels(mixed, 'apply')).toEqual(['Cancel', 'Update only this package', 'Update anyway']);
    expect(actionsFor(mixed, 'apply').find((b) => b.label === 'Update anyway')?.primary).toBe(true);
  });

  it('gives an incomplete answer asked on a row no primary action: the sentence is the answer', () => {
    const mixed = actionsFor(closure([...many(2), unknown('Example.A')]), 'asked');
    expect(mixed.map((b) => b.label)).toEqual(['Close', 'Update only this package']);
    expect(mixed.some((b) => b.primary)).toBe(false);
  });

  it('has nothing to decline when every dependent is unknown: Update anyway is the one way on', () => {
    const all = closure([unknown('Example.A')]);
    expect(labels(all, 'asked')).toEqual(['Close', 'Update anyway']);
    expect(actionsFor(all, 'asked').find((b) => b.label === 'Update anyway')?.primary).toBe(true);
  });

  it('offers the block on a dead end, and only there', () => {
    const dead = closure([], { outcome: 'dead-end', deadEnd: deadEnd('Example.Bus', ['[1.0.0, 2.0.0)']) });
    expect(labels(dead, 'apply')).toEqual(['Cancel', 'Update anyway', 'Block this update']);
    expect(labels(dead, 'asked')).toEqual(['Close', 'Update anyway', 'Block this update']);
    // Block stays the primary: it is what the popup recommends.
    expect(actionsFor(dead, 'apply').filter((b) => b.primary).map((b) => b.label)).toEqual(['Block this update']);
    for (const r of [closure(many(2)), closure([unknown('Example.A')]), closure([...many(2), unknown('Example.A')])]) {
      expect(labels(r, 'apply')).not.toContain('Block this update');
      expect(labels(r, 'asked')).not.toContain('Block this update');
    }
  });

  it('never offers the block when every dependent is unknown: nothing was checked, so nothing can be said to be unsafe', () => {
    const all = closure([unknown('Example.A'), unknown('Example.B')]);
    expect(all.outcome).toBe('unknown');
    expect(labels(all, 'apply')).toEqual(['Cancel', 'Update anyway']);
  });
});

describe('a member that moves against the root (#109)', () => {
  const down = (id: string) => moves(id, '2.1.0', '1.9.0');

  it('says in the lead how many members go the other way, and the row carries a word', () => {
    const result = closure([...many(2), down('Example.Messaging.Serialization')]);
    expect(text(leadFor(result, 'apply'))).toBe('7.2.2 needs 3 other packages to move with it — 1 of them moves down.');
    expect([...movesAgainstRoot(result).entries()]).toEqual([['example.messaging.serialization', 'downgrade']]);
  });

  it('counts several, and agrees with them', () => {
    const result = closure([down('Example.A'), down('Example.B'), ...many(1)]);
    expect(text(leadFor(result, 'apply'))).toBe('7.2.2 needs 3 other packages to move with it — 2 of them move down.');
  });

  it('reads the other way round in a downgrade: a member going up is the one against the root', () => {
    const upMember = moves('Example.Messaging.Serialization', '1.9.0', '2.1.0');
    const result = closure([down('Example.A'), upMember], { fromVersion: '7.2.2', toVersion: '6.8.1' });
    expect(text(leadFor(result, 'apply'))).toBe('6.8.1 needs 2 other packages to move with it — 1 of them moves up.');
    expect([...movesAgainstRoot(result).values()]).toEqual(['upgrade']);
  });

  it('adds nothing to a closure whose members all go the way the root goes', () => {
    const result = closure(many(3));
    expect(text(leadFor(result, 'apply'))).toBe('7.2.2 needs 3 other packages to move with it.');
    expect(movesAgainstRoot(result).size).toBe(0);
  });

  it('keeps the clause when the lead offers the page past the threshold', () => {
    const result = closure([...many(22), down('Example.A')]);
    expect(text(leadFor(result, 'apply'))).toContain('more than fits in a popup. Review them on a page beside the package list, or take them all. 1 of them moves down.');
  });

  it('leaves rows that could not be judged out of it: they go nowhere', () => {
    expect(movesAgainstRoot(closure([...many(1), unknown('Example.A')])).size).toBe(0);
  });
});

describe('rows left out on purpose (#109)', () => {
  it('says in the lead that part of the set is left out, apart from what could not be judged', () => {
    const onlyLeft = closure([...many(2), leftOut('Example.A')]);
    expect(text(leadFor(onlyLeft, 'apply'))).toBe(
      '7.2.2 needs 2 other packages to move with it. 1 more is left out and not written — each row says why.',
    );
    const both = closure([...many(2), unknown('Example.B'), leftOut('Example.A'), leftOut('Example.C', 'not-direct')]);
    expect(text(leadFor(both, 'apply'))).toBe(
      '7.2.2 needs 2 other packages to move with it. For 1 more we could not establish whether any version of them admits it. '
      + '2 more are left out and not written — each row says why.',
    );
  });

  it('does not make the set incomplete: taking it writes what was judged, knowingly leaving the rest', () => {
    const set = closure([...many(2), leftOut('Example.A')]);
    expect(actionsFor(set, 'apply').map((b) => b.label)).toEqual(['Cancel', 'Update only this package', 'Take all 2']);
  });

  it('counts the rows towards the threshold, since they are drawn', () => {
    expect(containerFor(closure([...many(CASCADE_POPUP_ROWS - 1), leftOut('Example.A'), leftOut('Example.B')]), 'asked')).toBe('page');
  });

  it('names the left-out dependents when that is all there is, and offers the bump with nothing to decline', () => {
    const only = closure([leftOut('Example.A'), leftOut('Example.B', 'not-direct')]);
    expect(only.outcome).toBe('unknown');
    expect(text(leadFor(only, 'apply'))).toBe(
      '7.2.2 is depended on by 2 packages that are left out of the proposal — each row says why.',
    );
    expect(actionsFor(only, 'apply').map((b) => b.label)).toEqual(['Cancel', 'Update anyway']);
  });

  it('groups them by reason beside the unknown ones', () => {
    expect(unknownGroups(closure([leftOut('Example.A'), unknown('Example.B')])).map((g) => g.label))
      .toEqual(['updates blocked', 'registration too large']);
  });

  it('says in the pane that it was judged and left out, not that it could not be established', () => {
    const blocked = leftOut('Example.A');
    expect(text(whyLine(blocked, closure([blocked]).root))).toBe('Example.A is left out — Example.A is held back.');
    expect(LEFT_OUT_NOTE).toBe('Nothing is proposed for it, and taking the proposal leaves it as it is.');
  });

  it('counts them in the makeup of the closure', () => {
    expect(closureMakeup(closure([moves('Example.M', '1.0.0', '2.0.0'), leftOut('Example.A'), unknown('Example.B')])))
      .toMatchObject({ unknown: 1, leftOut: 1 });
  });
});

describe('the unknown rows (#109)', () => {
  it('groups them by reason, one line per reason with the packages it applies to', () => {
    const result = closure([
      unknown('Example.Messaging.Bus', { label: 'credential refused (401)' }),
      unknown('Example.Messaging.Telemetry'),
      unknown('Example.Messaging.Retry', { label: 'credential refused (401)' }),
    ]);
    expect(unknownGroups(result)).toEqual([
      { label: 'credential refused (401)', ids: ['Example.Messaging.Bus', 'Example.Messaging.Retry'] },
      { label: 'registration too large', ids: ['Example.Messaging.Telemetry'] },
    ]);
  });

  it('prints a dash where an unknown row cannot say where it moves to', () => {
    expect(pairOf(unknown('Example.A'))).toEqual({ from: '2.4.0', to: '—', tone: 'flat' });
  });

  it('colours a pair by the direction it moves', () => {
    expect(pairOf(moves('Example.A', '7.8.0', '8.1.1'))).toMatchObject({ to: '8.1.1', tone: 'up' });
    expect(pairOf(moves('Example.A', '8.1.7', '7.8.0'))).toMatchObject({ tone: 'down' });
  });

  it('words the range tooltip with the edge pointing at the package it hangs from', () => {
    expect(rangeTooltip(moves('Example.Messaging.Bus', '7.8.0', '8.1.1'))).toBe(
      'Example.Messaging.Bus 8.1.1 declares Example.Messaging.Transport [7.2.0, )',
    );
  });
});

describe('the preview past the threshold (#109)', () => {
  it('keeps the first rows in the order the walk found them — shallowest first — and counts the rest', () => {
    const deeper = moves('Example.Deeper', '1.0.0', '2.0.0', [], 'Example.Deep');
    const deep = moves('Example.Deep', '1.0.0', '2.0.0', [deeper]);
    const result = closure([deep, ...many(5)]);

    const { root, hidden } = previewOf(result, 3);

    expect(root.children.map((c) => c.id)).toEqual(['Example.Deep', 'Example.Member0', 'Example.Member1']);
    expect(root.children[0].children).toEqual([]);
    expect(hidden).toBe(result.moves - 3);
  });

  it('keeps all of a closure that fits', () => {
    const { hidden, root } = previewOf(closure(many(3)), 10);
    expect(hidden).toBe(0);
    expect(root.children).toHaveLength(3);
  });
});

describe('the page foot (#109)', () => {
  it('counts every change, the bump included, in the project it will be written to', () => {
    expect(consequenceLine(closure(many(23)))).toBe('24 changes in Example.Shop.Infrastructure');
    expect(consequenceLine(closure(many(1)))).toBe('2 changes in Example.Shop.Infrastructure');
  });

  it('says the figures belong to the moment they were computed once the panel has moved on', () => {
    expect(consequenceLine(closure(many(23)), true)).toBe('Computed for the versions above');
  });

  it('carries no count when part of the set could not be judged, since what Update anyway writes is not one it stands behind', () => {
    expect(consequenceLine(closure([...many(2), unknown('Example.Messaging.Telemetry')]))).toBe('');
  });
});

describe('the detail pane of the page (#109)', () => {
  it('says what kind of set the closure is before any row is picked', () => {
    const grandchild = { ...moves('Example.Data.Sql.Migrations', '3.1.0', '4.0.0', [], 'Example.Data.Sql'), sourceName: 'Example.Internal' };
    const sql = { ...moves('Example.Data.Sql', '3.1.0', '4.0.0', [grandchild]), sourceName: 'nuget.org' };
    const inLine = { ...moves('Example.Logging', '2.5.1', '2.6.0'), sourceName: 'nuget.org' };
    const result = closure([sql, inLine, unknown('Example.Cached')]);

    expect(closureMakeup(result)).toEqual({
      total: 3, direct: 2, indirect: 1, crossMajor: 2, sameLine: 1, unknown: 1, leftOut: 0,
      sources: [{ name: 'nuget.org', count: 2 }, { name: 'Example.Internal', count: 1 }],
    });
  });

  it('finds a row and the package it hangs from', () => {
    const child = moves('Example.Child', '1.0.0', '2.0.0', [], 'Example.Parent');
    const result = closure([moves('Example.Parent', '1.0.0', '2.0.0', [child])]);

    expect(findNode(result, 'Example.Child')).toBe(child);
    expect(findNode(result, 'Example.Missing')).toBeUndefined();
    expect(parentOf(result, child)?.id).toBe('Example.Parent');
    expect(parentOf(result, result.root)).toBeUndefined();
  });

  it('says why a row has to move: what its installed version declared, against where the parent goes', () => {
    const redis = { ...moves('Example.Caching.Redis', '2.5.1', '2.6.0', [], 'Example.Extensions.Caching'), installedRange: '[8.0.0, 9.0.0)' };
    const parent = moves('Example.Extensions.Caching', '8.1.0', '9.0.0', [redis]);

    expect(text(whyLine(redis, parent))).toBe(
      '2.5.1 declares Example.Extensions.Caching [8.0.0, 9.0.0), which leaves out 9.0.0, the version Example.Extensions.Caching moves to.',
    );
  });

  it('says a bare minimum from an earlier major line was asked for, and that the version being installed is another major', () => {
    const http = { ...moves('Example.Extensions.Http', '8.1.0', '9.0.0', [], 'Example.Extensions.Abstractions'), installedRange: '[8.1.0, )' };
    const root: CascadeNode = { id: 'Example.Extensions.Abstractions', installedVersion: '8.1.0', proposedVersion: '9.0.0', status: 'moves', children: [http] };

    expect(text(whyLine(http, root))).toBe(
      '8.1.0 asked for Example.Extensions.Abstractions [8.1.0, ) — a minimum from the 8.x line. '
      + '9.0.0, the version being installed, is a different major, so 8.1.0 was built against something else.',
    );
  });

  it('names the package that moves when the minimum was asked of a dependent, not of the one being installed', () => {
    const hosting = moves('Example.Extensions.Hosting', '8.1.0', '9.0.0');
    const telemetry = { ...moves('Example.Telemetry.Hosting', '1.7.0', '1.9.2', [], 'Example.Extensions.Hosting'), installedRange: '[8.1.0, )' };

    expect(text(whyLine(telemetry, hosting))).toBe(
      '1.7.0 asked for Example.Extensions.Hosting [8.1.0, ) — a minimum from the 8.x line. '
      + '9.0.0, the version Example.Extensions.Hosting moves to, is a different major, so 1.7.0 was built against something else.',
    );
  });

  it('gives an unknown row one sentence saying what is not known and why, and a line saying where the rest is', () => {
    const telemetry = unknown('Example.Messaging.Telemetry', {
      detail: 'its registration lists more than 64 pages, so its versions were not read',
    });

    expect(text(whyLine(telemetry, closure([telemetry]).root))).toBe(
      'We do not know whether any version of Example.Messaging.Telemetry admits 7.2.2 — its registration lists more than 64 pages, so its versions were not read.',
    );
    expect(UNKNOWN_NOTE).toBe('Nothing is proposed for it. The package, the source and the step that gave up are in the Log tab.');
  });

  it('marks a range that formally fits but is a minimum from an earlier major line as asked, so it is not mistaken for the one chosen', () => {
    const node: CascadeNode = {
      ...moves('Example.Extensions.Http', '8.1.0', '9.0.0'),
      window: [
        { version: '9.0.0', range: '[9.0.0, )', admits: true },
        { version: '8.1.1', range: '[8.1.0, )', admits: false },
        { version: '8.1.0', range: '[8.1.0, )', admits: false },
        { version: '8.0.0', range: '[8.0.0, 9.0.0)', admits: false },
        { version: '7.0.0' , admits: false },
      ],
    };

    const { rows } = ladderRows(node, '9.0.0');

    expect(rows.map((r) => [r.version, r.range, r.admits])).toEqual([
      ['7.0.0', 'no dependency', false],
      ['8.0.0', '[8.0.0, 9.0.0)', false],
      ['8.1.0', 'asked [8.1.0, )', false],
      ['8.1.1', 'asked [8.1.0, )', false],
      ['9.0.0', '[9.0.0, )', true],
    ]);
  });

  it('writes a range as it is when no version is given to measure it against', () => {
    const node: CascadeNode = { ...moves('Example.Extensions.Http', '8.1.0', '9.0.0'), window: [{ version: '8.1.0', range: '[8.1.0, )', admits: false }] };

    expect(ladderRows(node).rows[0].range).toBe('[8.1.0, )');
  });

  it('draws the ladder oldest first with the installed and proposed versions tagged and the window marked', () => {
    const node: CascadeNode = {
      ...moves('Example.Caching.Redis', '2.5.1', '2.6.0'),
      window: [
        { version: '2.6.1', range: '[9.0.0, 10.0.0)', admits: true },
        { version: '2.6.0', range: '[9.0.0, 10.0.0)', admits: true },
        { version: '2.5.1', range: '[8.0.0, 9.0.0)', admits: false },
        { version: '2.5.0', admits: false },
      ],
      windowOlder: 3, windowNewer: 2,
    };

    const { rows, older, newer } = ladderRows(node);

    expect(rows.map((r) => [r.version, r.admits, r.tag])).toEqual([
      ['2.5.0', false, ''], ['2.5.1', false, 'installed'], ['2.6.0', true, 'proposed'], ['2.6.1', true, ''],
    ]);
    expect(rows[0].range).toBe('no dependency');
    expect([older, newer]).toEqual([3, 2]);
  });
});

describe('a row the new version requires (#109)', () => {
  const BUS = 'Example.Messaging.Bus';
  const SERIALIZATION = 'Example.Messaging.Serialization';
  const forward = (over: Partial<CascadeNode> = {}): CascadeNode => ({
    id: SERIALIZATION, installedVersion: '1.9.0', proposedVersion: '2.1.0', parentId: BUS, direction: 'forward',
    range: '[2.1.0, )', requirements: [{ id: BUS, version: '8.1.1', range: '[2.1.0, )' }],
    status: 'moves', children: [], ...over,
  });
  const parent = moves(BUS, '7.8.0', '8.1.1', [], TRANSPORT);

  it('says required before the range, and the reverse row keeps the range alone', () => {
    expect(rangeLabel(forward())).toBe('required [2.1.0, )');
    expect(rangeLabel(moves('Example.A', '1.0.0', '2.0.0'))).toBe('[7.2.0, )');
  });

  it('reads the tooltip the forward way: the package above requires the row', () => {
    expect(rangeTooltip(forward())).toBe(`${BUS} 8.1.1 requires ${SERIALIZATION} [2.1.0, )`);
    expect(rangeTooltip(moves('Example.A', '1.0.0', '2.0.0'))).toBe('Example.A 2.0.0 declares Example.Messaging.Transport [7.2.0, )');
  });

  it('says in the pane who requires the row, and where the project stands against it', () => {
    expect(text(whyLine(forward(), parent))).toBe(
      `${BUS} 8.1.1 requires ${SERIALIZATION} [2.1.0, ). The project has 1.9.0, which is below it.`,
    );
    const ceiling = forward({ installedVersion: '7.2.2', range: '[6.0.0, 7.0.0)', requirements: [{ id: BUS, version: '8.1.1', range: '[6.0.0, 7.0.0)' }] });
    expect(text(whyLine(ceiling, parent))).toContain('which is above it.');
  });

  it('prints no range on the ladder of a forward row: the requirement is stated once', () => {
    const node = forward({
      window: [
        { version: '2.1.0', admits: true },
        { version: '2.0.0', admits: false },
        { version: '1.9.0', admits: false },
      ],
    });
    const { rows } = ladderRows(node, '8.1.1');
    expect(rows.map((r) => [r.version, r.range, r.admits, r.tag])).toEqual([
      ['1.9.0', '', false, 'installed'], ['2.0.0', '', false, ''], ['2.1.0', '', true, 'proposed'],
    ]);
  });

  it('leaves the movement of a reverse row beside a forward one unchanged', () => {
    const result = closure([moves(BUS, '7.8.0', '8.1.1', [forward()])], { packageId: BUS });
    expect(text(leadFor(result, 'apply'))).toBe('7.2.2 needs 2 other packages to move with it.');
  });
});

describe('a dead end between several constraints (#109)', () => {
  const ADAPTER = 'Example.Messaging.Adapter';
  const BUS = 'Example.Messaging.Bus';
  const between = (constraints: NonNullable<CascadeNode['constraints']>): CascadeResult => closure([], {
    outcome: 'dead-end',
    deadEnd: {
      id: TRANSPORT, installedVersion: '6.8.1', parentId: BUS, direction: 'forward', status: 'dead-end', children: [], constraints,
    },
  });

  it('names the package and says that nothing holds everything at once, then one line per constraint', () => {
    const result = between([
      { id: BUS, version: '8.1.11', kind: 'requires', range: '[7.2.2, )' },
      { id: ADAPTER, version: '2.0.0', kind: 'requires', range: '[6.0.0, 7.0.0)' },
    ]);

    expect(text(leadFor(result, 'apply'))).toBe(`No version of ${TRANSPORT} satisfies everything that has to hold at once:`);
    expect(deadEndLines(result).map(text)).toEqual([
      `${BUS} 8.1.11 requires [7.2.2, )`,
      `${ADAPTER} 2.0.0 requires [6.0.0, 7.0.0)`,
    ]);
  });

  it('has the same shape when the second constraint is the version the person chose', () => {
    const result = between([
      { id: BUS, version: '8.1.1', kind: 'requires', range: '[2.1.0, )' },
      { id: 'Example.Extensions.Abstractions', version: '9.0.0', kind: 'fixed', range: '[10.0.0, )' },
    ]);

    expect(text(leadFor(result, 'apply'))).toBe(
      `No version of ${TRANSPORT} works with Example.Extensions.Abstractions 9.0.0, the version being installed:`,
    );
    expect(deadEndLines(result).map(text)[1]).toBe(
      `Example.Extensions.Abstractions 9.0.0 — every release of ${TRANSPORT} that high declares [10.0.0, )`,
    );
  });

  it('names a project that holds a floor, and says it is one', () => {
    const result = between([
      { id: BUS, version: '8.1.11', kind: 'requires', range: '[7.2.2, )' },
      { id: 'Example.Shop.Core', kind: 'floor', range: '[8.0.0, )' },
    ]);
    expect(deadEndLines(result).map(text)[1]).toBe('Example.Shop.Core, a project this one references, requires [8.0.0, )');
  });

  it('draws a dead end with one reason exactly as before', () => {
    const dead = closure([], { outcome: 'dead-end', deadEnd: deadEnd('Example.Bus', ['[1.0.0, 2.0.0)']) });
    expect(deadEndLines(dead)).toEqual([]);
    expect(text(leadFor(dead, 'apply'))).toContain('every release stops at [1.0.0, 2.0.0)');
  });
});

describe('a central write (#109)', () => {
  const WEB = 'D:/src/Example.Shop/Example.Shop.Web.csproj';
  const WORKER = 'D:/src/Example.Shop/Example.Shop.Worker.csproj';
  const INFRA = 'D:/src/Example.Shop/Example.Shop.Infrastructure.csproj';
  const PROPS = 'D:/src/Example.Shop/Directory.Packages.props';
  const central = (over: Partial<CascadeResult> = {}, projects = [INFRA, WEB, WORKER]): Partial<CascadeResult> => ({
    central: { propsFile: PROPS, projects, frameworks: ['net10.0'] }, ...over,
  });
  const inProjects = (node: CascadeNode, projects: string[]): CascadeNode => ({ ...node, projects });
  const notRestored = (path: string, name: string): CascadeNode => ({
    id: name, installedVersion: '', parentId: TRANSPORT, status: 'unknown', project: true, projects: [path], children: [],
    reason: { code: 'not-restored', label: 'not restored', detail: 'it references the package but has not been restored, so it has no restore graph' },
  });

  it('opens the popup by saying which file the version is set in and how many projects were checked', () => {
    const result = closure(many(2), central());
    expect(text(leadFor(result, 'apply'))).toBe(
      '7.2.2 forces two other packages to move in turn. It is set in Directory.Packages.props; the 3 projects that use it were checked.',
    );
  });

  it('leaves the page with the ordinary lead: its header carries the file and the projects', () => {
    expect(text(leadFor(closure(many(2), central()), 'asked', 'page'))).toBe('7.2.2 needs 2 other packages to move with it.');
  });

  it('is exactly the ordinary lead without a central version', () => {
    expect(text(leadFor(closure(many(2)), 'apply'))).toBe('7.2.2 needs 2 other packages to move with it.');
  });

  it('counts the packages once in the foot and the projects separately', () => {
    expect(consequenceLine(closure(many(4), central()))).toBe('5 changes in Directory.Packages.props, used by 3 projects');
  });

  it('draws the file and every project as the page header, cut to a few with the rest counted', () => {
    const header = centralBadges(closure(many(1), central({}, [INFRA, WEB, WORKER, 'D:/a/Example.A.csproj', 'D:/a/Example.B.csproj'])));
    expect(header).toMatchObject({ file: 'Directory.Packages.props', shown: ['Example.Shop.Infrastructure', 'Example.Shop.Web', 'Example.Shop.Worker'], more: 2 });
    expect(centralBadges(closure(many(1)))).toBeUndefined();
  });

  it('says where each row comes from: the project, or how many', () => {
    const result = closure([], central());
    expect(inLabel(inProjects(moves('Example.A', '1.0.0', '2.0.0'), [INFRA, WEB, WORKER]), result)).toBe('3 projects');
    expect(inLabel(inProjects(moves('Example.B', '1.0.0', '2.0.0'), [WORKER]), result)).toBe('Example.Shop.Worker');
    expect(inLabel(inProjects(moves('Example.C', '1.0.0', '2.0.0'), [WORKER]), closure([]))).toBeUndefined();
  });

  it('names the project in the pane sentence, so nothing depends on a rule about which rows carry a mark', () => {
    const telemetry = { ...inProjects(moves('Example.Messaging.Telemetry', '2.4.0', '3.0.0'), [WORKER]), installedRange: '[6.0.0, 7.0.0)' };
    expect(text(whyLine(telemetry, closure([telemetry]).root))).toBe(
      `In Example.Shop.Worker, 2.4.0 declares ${TRANSPORT} [6.0.0, 7.0.0), which leaves out 7.2.2, the version ${TRANSPORT} moves to.`,
    );
  });

  describe('a project that could not be judged', () => {
    it('is a row of its own, dimmed, and the lead says what could not be established', () => {
      const result = closure([...many(2), notRestored(WORKER, 'Example.Shop.Worker')], central());
      expect(text(leadFor(result, 'apply'))).toBe(
        '7.2.2 needs 2 other packages to move with it. For 1 project we could not establish what has to move.',
      );
    });

    it('offers the incomplete set: the bump alone, or the bump with what was established', () => {
      const result = closure([...many(2), notRestored(WORKER, 'Example.Shop.Worker')], central());
      expect(actionsFor(result, 'apply').map((b) => b.label)).toEqual(['Cancel', 'Update only this package', 'Update anyway']);
    });

    it('has no count in the foot: the set is incomplete', () => {
      expect(consequenceLine(closure([...many(2), notRestored(WORKER, 'Example.Shop.Worker')], central()))).toBe('');
    });

    it('says in the pane what is not known about the project, and that the rest stands', () => {
      const project = notRestored(WORKER, 'Example.Shop.Worker');
      expect(text(whyLine(project, closure([project]).root))).toBe(
        `We do not know what Example.Shop.Worker needs of ${TRANSPORT}: it references the package but has not been restored, so it has no restore graph.`,
      );
      expect(PROJECT_NOTE).toBe('Nothing is proposed for it. The rest of the answer stands.');
    });

    it('says only that when every project but the asked one is unjudged', () => {
      const result = closure([notRestored(WORKER, 'Example.Shop.Worker'), notRestored(WEB, 'Example.Shop.Web')], central());
      expect(result.outcome).toBe('unknown');
      expect(text(leadFor(result, 'apply'))).toBe(
        '7.2.2 may need other packages to move with it, but for 2 projects we could not establish what has to move.',
      );
    });
  });

  describe('a dead end between projects', () => {
    const BUS = 'Example.Messaging.Bus';
    const between = (): CascadeResult => closure([], {
      ...central(),
      outcome: 'dead-end',
      deadEnd: {
        id: BUS, installedVersion: '7.8.0', parentId: TRANSPORT, direction: 'forward', status: 'dead-end', children: [],
        constraints: [
          { id: 'Example.Messaging.Adapter', version: '2.0.0', kind: 'requires', range: '[7.0.0, 8.0.0)', projects: [WORKER] },
          { id: TRANSPORT, version: '7.2.2', kind: 'admits', projects: [INFRA] },
        ],
      },
    });

    it('names the projects that disagree, one line each with the project in front', () => {
      const result = between();
      expect(text(leadFor(result, 'apply'))).toBe(`No version of ${BUS} suits all 3 projects at once. Two of them disagree:`);
      expect(deadEndLines(result).map(text)).toEqual([
        `Example.Shop.Worker — Example.Messaging.Adapter 2.0.0 requires ${BUS} [7.0.0, 8.0.0)`,
        `Example.Shop.Infrastructure — admitting ${TRANSPORT} 7.2.2 needs ${BUS} to declare a range that admits it`,
      ]);
    });

    it('names the way out that no button performs', () => {
      expect(text(overrideNote(between()))).toBe(`A project can take its own version of ${BUS} with VersionOverride.`);
    });

    it('says nothing about an override when a single project is the problem', () => {
      const one = between();
      one.deadEnd!.constraints = one.deadEnd!.constraints!.map((c) => ({ ...c, projects: [WORKER] }));
      expect(overrideNote(one)).toEqual([]);
    });
  });
});
