import type { RawProfileChange, RawReactProfile } from './react-profile-renders.ts';

export const FUNCTION = 5;
export const MEMO = 8;

export type Render = [
  id: number,
  selfMs: number,
  change?: RawProfileChange | 'parent',
  actualMs?: number,
];

/** Builds a raw profile: `elements` by id, then commits as `[timestamp, duration, updaterIds, renders]`. */
export function rawProfile(
  elements: Record<number, [name: string, type?: number, owner?: number, parent?: number]>,
  commits: Array<[timestamp: number, duration: number, updaters: number[], renders: Render[]]>,
  keys: string[] = [],
): RawReactProfile {
  return {
    startedAt: 0,
    stoppedAt: 5_000,
    naming: 'operations',
    keys,
    elements: Object.fromEntries(
      Object.entries(elements).map(([id, [name, type = FUNCTION, owner = 0, parent = 0]]) => [
        id,
        [name, type, owner, parent],
      ]),
    ),
    commits: commits.map(([timestamp, duration, updaters, renders]) => ({
      timestamp,
      duration,
      updaters,
      fibers: renders.flatMap(([id, self, , actual]) => [id, actual ?? self, self]),
      changes: Object.fromEntries(
        renders
          .filter(([, , change]) => change !== undefined && change !== 'parent')
          .map(([id, , change]) => [String(id), change as RawProfileChange]),
      ),
    })),
  };
}

export function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}
