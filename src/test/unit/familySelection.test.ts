import type { FamilyGroup, FamilyMember } from '../../batchUpdates';
import { bestOverlapCandidate, memberKeysOf } from '../../webview/familySelection';

function member(packageId: string, projects: string[], fromVersion = '1.0.0'): FamilyMember {
  return { packageId, fromVersion, projects };
}

function group(family: string, fromVersion: string, members: FamilyMember[]): FamilyGroup {
  return { family, fromVersion, packageCount: members.length, updateCount: 0, members };
}

describe('memberKeysOf', () => {
  it('keys by lowercased packageId + project path, one per project a member touches', () => {
    const g = group('Microsoft.Extensions', '8.0.0', [
      member('Microsoft.Extensions.Logging', ['/p/A.csproj', '/p/B.csproj']),
    ]);
    expect(memberKeysOf(g)).toEqual([
      'microsoft.extensions.logging|/p/A.csproj',
      'microsoft.extensions.logging|/p/B.csproj',
    ]);
  });
});

describe('bestOverlapCandidate', () => {
  it('re-finds the same group at its new fromVersion after an update (single-bucket family)', () => {
    const before = group('Microsoft.Extensions', '8.0.0', [
      member('Microsoft.Extensions.Logging', ['/p/App.csproj']),
    ]);
    const after = group('Microsoft.Extensions', '9.0.0', [
      member('Microsoft.Extensions.Logging', ['/p/App.csproj']),
    ]);
    expect(bestOverlapCandidate([after], memberKeysOf(before))).toBe(after);
  });

  it('follows the selected group to its new bucket without jumping to a sibling bucket at a diverged version', () => {
    // Same family pinned to two different versions across two projects: two
    // buckets exist for "Microsoft.Extensions" at once (8.0.0 in App, 10.0.0
    // in Worker) — this is the case the naive "match by family name only"
    // fix would get wrong.
    const selectedBucket = group('Microsoft.Extensions', '8.0.0', [
      member('Microsoft.Extensions.Http', ['/p/App.csproj']),
    ]);
    const untouchedSiblingBucket = group('Microsoft.Extensions', '10.0.0', [
      member('Microsoft.Extensions.Http', ['/p/Worker.csproj']),
    ]);
    // After updating only App's copy to 9.0.0, App's members land in a brand
    // new bucket; Worker's bucket is unrelated and must not be picked.
    const updatedBucket = group('Microsoft.Extensions', '9.0.0', [
      member('Microsoft.Extensions.Http', ['/p/App.csproj']),
    ]);
    const candidates = [untouchedSiblingBucket, updatedBucket];

    const result = bestOverlapCandidate(candidates, memberKeysOf(selectedBucket));

    expect(result).toBe(updatedBucket);
  });

  it('returns undefined when none of the previously selected members survive', () => {
    const selectedBucket = group('Microsoft.Extensions', '8.0.0', [
      member('Microsoft.Extensions.Http', ['/p/App.csproj']),
    ]);
    const unrelatedBucket = group('Microsoft.Extensions', '9.0.0', [
      member('Microsoft.Extensions.Http', ['/p/OtherProject.csproj']),
    ]);

    expect(bestOverlapCandidate([unrelatedBucket], memberKeysOf(selectedBucket))).toBeUndefined();
  });

  it('picks the candidate with the larger surviving overlap on a partial update', () => {
    const selectedBucket = group('Microsoft.Extensions', '8.0.0', [
      member('Microsoft.Extensions.Http', ['/p/App.csproj', '/p/Worker.csproj', '/p/Api.csproj']),
    ]);
    // Two of three projects succeeded and moved to 9.0.0; one failed and
    // stayed behind at 8.0.0.
    const succeeded = group('Microsoft.Extensions', '9.0.0', [
      member('Microsoft.Extensions.Http', ['/p/App.csproj', '/p/Worker.csproj']),
    ]);
    const stillFailing = group('Microsoft.Extensions', '8.0.0', [
      member('Microsoft.Extensions.Http', ['/p/Api.csproj']),
    ]);

    const result = bestOverlapCandidate([stillFailing, succeeded], memberKeysOf(selectedBucket));

    expect(result).toBe(succeeded);
  });
});
