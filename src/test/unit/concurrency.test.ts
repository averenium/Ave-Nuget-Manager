import { createConcurrencyGate, createKeyedConcurrencyGates, runWithConcurrency } from '../../concurrency';

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

describe('createKeyedConcurrencyGates (#116)', () => {
  it('caps each key independently — one origin busy does not queue another', async () => {
    const gates = createKeyedConcurrencyGates(() => 1);
    let aInFlight = 0;
    let aMax = 0;
    const started: string[] = [];

    const a1 = gates.gateFor('a').run(async () => {
      aInFlight++; aMax = Math.max(aMax, aInFlight); started.push('a1');
      await new Promise((r) => setTimeout(r, 30));
      aInFlight--;
    });
    const a2 = gates.gateFor('a').run(async () => {
      aInFlight++; aMax = Math.max(aMax, aInFlight); started.push('a2');
      await new Promise((r) => setTimeout(r, 30));
      aInFlight--;
    });
    // Same key as gates.gateFor('a') above — a second call for the same
    // origin must reuse the same gate, or the cap it enforces means nothing.
    const b = gates.gateFor('b').run(async () => { started.push('b'); });

    await b;
    // 'b' on its own key runs immediately, ahead of 'a2' which is still
    // queued behind 'a1' on the shared 'a' gate.
    expect(started).toEqual(['a1', 'b']);
    await Promise.all([a1, a2]);
    expect(aMax).toBe(1);
    expect(started).toEqual(['a1', 'b', 'a2']);
  });

  it('returns the same gate for the same key', async () => {
    const gates = createKeyedConcurrencyGates(() => 5);
    expect(gates.gateFor('x')).toBe(gates.gateFor('x'));
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
