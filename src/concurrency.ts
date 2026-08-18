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
