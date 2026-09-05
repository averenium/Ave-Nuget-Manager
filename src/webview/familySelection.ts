import type { FamilyGroup } from '../batchUpdates';

// A family can legitimately be split into several groups at once when its
// packages sit at different resolved versions across projects (the bucket
// key in collectFamilyGroups is `family\0resolvedVersion`) — so identity
// cannot be "the family", only "this exact set of package+project members".
// After an update changes that set's resolvedVersion, the old (family,
// fromVersion) bucket is gone; this key lets the selection follow its
// members into whichever new bucket now contains them, instead of either
// going blank or falling back to an unrelated sibling bucket of the family.
export function memberKeysOf(g: FamilyGroup): string[] {
  return g.members.flatMap((m) => m.projects.map((p) => `${m.packageId.toLowerCase()}|${p}`));
}

// Among a family's current buckets, pick the one sharing the most members
// with a previously-selected bucket's member set — used to re-find the
// selected group after its members' resolvedVersion changed (see
// memberKeysOf above). Returns undefined if none of the members survived
// (e.g. the packages were removed), which correctly falls back to blank.
export function bestOverlapCandidate(candidates: FamilyGroup[], memberKeys: string[]): FamilyGroup | undefined {
  const wanted = new Set(memberKeys);
  let best: FamilyGroup | undefined;
  let bestScore = 0;
  for (const g of candidates) {
    const score = memberKeysOf(g).filter((k) => wanted.has(k)).length;
    if (score > bestScore) {
      best = g;
      bestScore = score;
    }
  }
  return best;
}
