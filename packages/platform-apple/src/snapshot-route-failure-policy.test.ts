import { describe, expect, test } from 'vitest';
import { bridgeFailureDisposition } from './snapshot-route-failure-policy.ts';

// Each expectation below is written out, never read back from the production table: a test that
// derived the scope from the same table could not detect the table entry moving.

describe('capture-scoped screen refusals', () => {
  // Positives paired with the closest negative: a screen refusal keeps the generation on the bridge
  // path, and the entry beside it in the code space does not (#3874, #3895).
  test.for([
    ['window-coordinate-space-unresolved', 'coordinate-space-unresolved'],
    ['app-window-not-full-screen', 'window-not-full-screen'],
    ['foreground-owner-unverified', 'foreground-ownership'],
    ['foreground-owner-changed', 'foreground-ownership'],
  ] as const)(
    'a %s refusal classifies as capture-scoped with its consequence',
    ([code, consequence]) => {
      expect(bridgeFailureDisposition({ kind: 'unsupported', code })).toEqual({
        scope: 'capture',
        code,
        consequence,
      });
    },
  );

  test('a bridge still being prepared classifies as capture-scoped preparation', () => {
    // The kind carries this one, not a code: the preparation owner reports a pending attempt, not
    // a screen (#2491).
    expect(
      bridgeFailureDisposition({ kind: 'preparing', code: 'bridge-preparation-pending' }),
    ).toEqual({
      scope: 'capture',
      code: 'bridge-preparation-pending',
      consequence: 'bridge-preparation',
    });
  });
});

describe('generation-wide failures', () => {
  test('a transport failure classifies as generation-wide without a consequence', () => {
    expect(
      bridgeFailureDisposition({ kind: 'transport-failure', code: 'bridge-disconnected' }),
    ).toEqual({ scope: 'generation', code: 'bridge-disconnected' });
  });

  test('a stale target classifies as generation-wide', () => {
    expect(
      bridgeFailureDisposition({ kind: 'stale-target', code: 'target-generation-changed' }),
    ).toEqual({ scope: 'generation', code: 'target-generation-changed' });
  });

  test('a presentation failure classifies as generation-wide', () => {
    expect(
      bridgeFailureDisposition({ kind: 'malformed-tree', code: 'presentation-invariant' }),
    ).toEqual({ scope: 'generation', code: 'presentation-invariant' });
  });

  test('a code this policy does not know keeps the conservative generation default', () => {
    // The guest's `code` is an open string. A refusal unknown here must not quietly keep a
    // generation on a path that just refused it; a new capture-scoped refusal is classified
    // explicitly, never by widening this default.
    expect(
      bridgeFailureDisposition({ kind: 'unsupported', code: 'future-runtime-refusal' }),
    ).toEqual({ scope: 'generation', code: 'future-runtime-refusal' });
  });
});
