import { createConcurrencyGate, runWithConcurrency } from '../../concurrency';

describe('createConcurrencyGate', () => {
  it('never runs more than the limit at once', async () => {
    const gate = createConcurrencyGate(() => 2);
    let inFlight = 0;
    let maxInFlight = 0;

    const tasks = Array.from({ length: 6 }, () =>
      gate.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
      }),
    );

    await Promise.all(tasks);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('releases the slot when the task throws', async () => {
    const gate = createConcurrencyGate(() => 1);
    await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('runWithConcurrency', () => {
  it('preserves result order', async () => {
    const results = await runWithConcurrency(
      [
        async () => { await new Promise((r) => setTimeout(r, 20)); return 'a'; },
        async () => 'b',
        async () => 'c',
      ],
      2,
    );
    expect(results).toEqual(['a', 'b', 'c']);
  });
});
