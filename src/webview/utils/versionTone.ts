import { compareSemVer } from './search';

export type VersionTone = 'up' | 'down' | 'same' | 'add';

/** Direction from the currently installed version (`from`) to the picked one (`to`). */
export function versionTone(from: string | undefined, to: string | undefined): VersionTone | undefined {
  if (from && to) {
    const cmp = compareSemVer(to, from);
    if (cmp > 0) return 'up';
    if (cmp < 0) return 'down';
    return 'same';
  }
  if (!from && to) return 'add';
  return undefined;
}

export function versionLabel(from: string | undefined, to: string | undefined): string | undefined {
  if (from && to && from !== to) return `${from} → ${to}`;
  if (from && to) return from;
  if (from) return from;
  if (to) return `+ ${to}`;
  return undefined;
}
