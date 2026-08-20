export interface ConcurrencyGate {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Shared slot limiter for overlapping work (install + enrich + search, …).
 * `getLimit` is read on each acquire / release so settings changes apply.
 */
export function createConcurrencyGate(getLimit: () => number): ConcurrencyGate {
  let active = 0;
  const waiters: Array<() => void> = [];

  const cap = (): number => Math.max(1, getLimit() || 1);

  const acquire = (): Promise<void> => {
    if (active < cap()) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        active++;
        resolve();
      });
    });
  };

  const release = (): void => {
    active--;
    while (waiters.length > 0 && active < cap()) {
      waiters.shift()?.();
    }
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/**
 * Minimal async concurrency limiter.
 * Runs `tasks` with at most `concurrency` active at once,
 * maintaining insertion order of results.
 */
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    let completed = 0;

    const next = () => {
      while (active < concurrency && index < tasks.length) {
        const i = index++;
        active++;

        tasks[i]()
          .then((result) => {
            results[i] = result;
            active--;
            completed++;
            if (completed === tasks.length) {
              if (!settled) { settled = true; resolve(results); }
            } else {
              next();
            }
          })
          .catch((err) => {
            if (!settled) { settled = true; reject(err); }
          });
      }
    };

    if (tasks.length === 0) {
      resolve(results);
      return;
    }

    next();
  });
}
