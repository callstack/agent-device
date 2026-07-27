// Name → target lookup for the parser fuzz lane (#1414).
//
// Resolves the real parser targets plus the broken-on-purpose self-check targets, which is the
// only place the two lists meet. The worker resolves targets by name (a target cannot cross a
// worker boundary as a value), so this lookup is what lets self-check cases run in the same
// worker/watchdog path as real ones.

import { SELF_CHECK_TARGETS } from './self-check-targets.ts';
import type { FuzzTarget } from './target-types.ts';
import { FUZZ_TARGETS } from './targets.ts';

export function getFuzzTarget(name: string): FuzzTarget {
  const target = [...FUZZ_TARGETS, ...SELF_CHECK_TARGETS].find(
    (candidate) => candidate.name === name,
  );
  if (!target) {
    const known = FUZZ_TARGETS.map((candidate) => candidate.name).join(', ');
    throw new Error(`Unknown fuzz target "${name}". Known targets: ${known}`);
  }
  return target;
}
