// Broken-on-purpose targets that prove the harness can still fail (#1414).
//
// A fuzz lane whose classifier or watchdog regresses goes green forever, which is worse than
// no lane at all. These targets each violate the invariant one way, so `--self-check` (and the
// unit test in harness.test.ts) can assert the harness reports every failure kind. They are
// deliberately kept out of FUZZ_TARGETS: only the registry resolves them by name, so a normal
// run never sees them and no production module gains a test-only seam.

import { AppError } from '@agent-device/kernel/errors';
import type { FuzzTarget, SelfCheckTargetName } from './target-types.ts';

const SEEDS = ['self-check'];

export const SELF_CHECK_TARGETS: readonly FuzzTarget[] = [
  {
    name: 'self-check-untyped-throw',
    description: 'always throws a bare Error (expects an untyped-throw failure)',
    run: () => {
      throw new Error('self-check untyped throw');
    },
    seeds: SEEDS,
  },
  {
    name: 'self-check-empty-hint',
    description: 'always throws an AppError without a hint (expects an empty-hint failure)',
    run: () => {
      throw new AppError('INVALID_ARGS', 'self-check missing hint', { hint: '   ' });
    },
    seeds: SEEDS,
  },
  {
    name: 'self-check-hang',
    description: 'never returns (expects a hang failure)',
    run: () => {
      for (;;) {
        // Spin forever: only the out-of-thread watchdog can end this case.
      }
    },
    seeds: SEEDS,
  },
];

/** The failure kind each self-check target must produce, keyed by target name. */
export const SELF_CHECK_EXPECTATIONS = {
  'self-check-untyped-throw': 'untyped-throw',
  'self-check-empty-hint': 'empty-hint',
  'self-check-hang': 'hang',
} as const satisfies Record<SelfCheckTargetName, string>;
