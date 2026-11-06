import { batchMessageFor, planFor } from '../../webview/utils/cascadePlan';

const base = {
  mode: 'apply' as const,
  packageId: 'Example.Messaging.Transport',
  projectPath: 'D:/src/Example.Shop.csproj',
};
const bump = { packageId: 'Example.Messaging.Transport', fromVersion: '6.8.1', toVersion: '7.2.2' };
const bus = { packageId: 'Example.Messaging.Bus', fromVersion: '7.8.0', toVersion: '8.1.1' };

describe('the batch a decision sends (#109)', () => {
  it('asks for the items to be written together, since a restore between a bump and its dependents refuses the first', () => {
    const items = [{ packageId: 'Example.Messaging.Transport', fromVersion: '7.2.2', toVersion: '6.8.1', projects: ['/p/App.csproj'] }];

    expect(batchMessageFor(items, true)).toEqual({
      type: 'UPDATE_PACKAGES_BATCH', kind: 'other', includePrerelease: true, items, together: true,
    });
  });
});

describe('what a decision on the dependents proposal does (#109)', () => {
  it('takes the bump and the dependents together as one batch for the project', () => {
    expect(planFor({ ...base, action: 'take-all', moves: [bump, bus] })).toEqual({
      kind: 'batch',
      items: [
        { ...bump, projects: [base.projectPath], framework: undefined },
        { ...bus, projects: [base.projectPath], framework: undefined },
      ],
    });
  });

  it('writes each package through the project that references it, under a central version', () => {
    const worker = 'D:/src/Example.Shop/Example.Shop.Worker.csproj';
    expect(planFor({ ...base, action: 'take-all', moves: [bump, { ...bus, writeIn: worker }] })).toEqual({
      kind: 'batch',
      items: [
        { ...bump, projects: [base.projectPath], framework: undefined },
        { ...bus, projects: [worker], framework: undefined },
      ],
    });
  });

  it('keeps a framework confinement on the bump and on nothing else', () => {
    const plan = planFor({ ...base, action: 'take-all', moves: [bump, bus], confineFramework: 'net8.0' });
    expect(plan.kind === 'batch' && plan.items.map((i) => i.framework)).toEqual(['net8.0', undefined]);
  });

  it('lets a waiting write go ahead as asked when only the bump itself is left', () => {
    expect(planFor({ ...base, action: 'update-anyway', moves: [bump] })).toEqual({ kind: 'proceed' });
    expect(planFor({ ...base, action: 'update-anyway', moves: [] })).toEqual({ kind: 'proceed' });
  });

  it('writes the established dependents with an Update anyway, and none that could not be judged', () => {
    const plan = planFor({ ...base, action: 'update-anyway', moves: [bump, bus] });
    expect(plan.kind === 'batch' && plan.items.map((i) => i.packageId)).toEqual([bump.packageId, bus.packageId]);
  });

  it('writes the waiting update alone, as it was asked, when the proposal is declined', () => {
    expect(planFor({ ...base, action: 'update-only', moves: [bump, bus] })).toEqual({ kind: 'proceed' });
  });

  it('writes the bump alone as a batch of one when the check was asked on a row, keeping a framework confinement', () => {
    expect(planFor({ ...base, mode: 'asked', action: 'update-only', moves: [bump, bus], confineFramework: 'net8.0' })).toEqual({
      kind: 'batch',
      items: [{ ...bump, projects: [base.projectPath], framework: 'net8.0' }],
    });
  });

  it('writes the bump alone on Update anyway when nothing was established, asked on a row or not', () => {
    expect(planFor({ ...base, action: 'update-anyway', moves: [bump] })).toEqual({ kind: 'proceed' });
    expect(planFor({ ...base, mode: 'asked', action: 'update-anyway', moves: [bump] })).toEqual({
      kind: 'batch', items: [{ ...bump, projects: [base.projectPath], framework: undefined }],
    });
  });

  it('writes what was established on Update anyway asked on a row, as it does with a write waiting', () => {
    const plan = planFor({ ...base, mode: 'asked', action: 'update-anyway', moves: [bump, bus] });
    expect(plan.kind === 'batch' && plan.items.map((i) => i.packageId)).toEqual([bump.packageId, bus.packageId]);
  });

  it('lets the waiting update go ahead as asked when the offer is switched off from inside the popup', () => {
    expect(planFor({ ...base, action: 'never-offer', moves: [bump, bus] })).toEqual({ kind: 'proceed' });
  });

  it('has nothing to switch off when asked on a row: nothing was offered', () => {
    expect(planFor({ ...base, mode: 'asked', action: 'never-offer', moves: [bump, bus] })).toEqual({ kind: 'drop' });
  });

  it('has no bump to write when the answer does not carry one', () => {
    expect(planFor({ ...base, mode: 'asked', action: 'update-only', moves: [] })).toEqual({ kind: 'drop' });
  });

  it('writes a closure asked for on a row as a batch even when it is only the bump: nothing is waiting to proceed', () => {
    expect(planFor({ ...base, mode: 'asked', action: 'take-all', moves: [bump] })).toMatchObject({ kind: 'batch' });
    expect(planFor({ ...base, mode: 'asked', action: 'take-all', moves: [] })).toEqual({ kind: 'drop' });
  });

  it('blocks the package the bump is about, and writes nothing', () => {
    expect(planFor({ ...base, action: 'block', moves: [bump] })).toEqual({ kind: 'block', packageId: base.packageId });
  });

  it.each(['cancel', 'close'] as const)('drops a held write on %s', (action) => {
    expect(planFor({ ...base, action, moves: [bump, bus] })).toEqual({ kind: 'drop' });
  });
});
