import assert from 'node:assert/strict';
import { test } from 'vitest';
import { readSnapshotKeyboardBandFact } from './record.ts';

// Every seam that receives a producer-declared keyboard band reads it through this one function
// (#2660): the Apple runner's wire reader and the Node client's snapshot reader. These cases own the
// shape budget for that reader, so a payload cannot be read one way on one seam and another way on
// the next. `undefined` is reserved for the one input that means "this producer never looked".

const FRAME = { x: 0, y: 583, width: 402, height: 291 };

test('a fact that was never published reads as silence, and only that fact', () => {
  assert.equal(readSnapshotKeyboardBandFact(undefined), undefined);
});

test('a measured band, a proven absence, and a stated failure read back as themselves', () => {
  assert.deepEqual(readSnapshotKeyboardBandFact({ kind: 'visible', frame: FRAME }), {
    kind: 'visible',
    frame: FRAME,
  });
  assert.deepEqual(readSnapshotKeyboardBandFact({ kind: 'absent' }), { kind: 'absent' });
  assert.deepEqual(
    readSnapshotKeyboardBandFact({
      kind: 'unmeasurable',
      reason: 'keyboard-frame-query-timeout',
    }),
    { kind: 'unmeasurable', reason: 'keyboard-frame-query-timeout' },
  );
});

// The order is load-bearing: a payload that is not even an object cannot also have an unrecognized
// kind, and an `unmeasurable` is checked for its reason before a `visible` is checked for its frame.
test('a payload that cannot be placed names one reason, resolved from shape to kind to fields', () => {
  const cases: ReadonlyArray<readonly [unknown, string]> = [
    ['visible', 'malformed-fact'],
    [42, 'malformed-fact'],
    [null, 'malformed-fact'],
    [[FRAME], 'malformed-fact'],
    [{ kind: 'measured', frame: FRAME }, 'unrecognized-kind'],
    [{ frame: FRAME }, 'unrecognized-kind'],
    [{ kind: 'unmeasurable' }, 'unreported-reason'],
    [{ kind: 'unmeasurable', reason: '   ' }, 'unreported-reason'],
    [{ kind: 'unmeasurable', reason: 7 }, 'unreported-reason'],
    [{ kind: 'visible' }, 'invalid-visible-frame'],
    [{ kind: 'visible', frame: '0,583' }, 'invalid-visible-frame'],
    [{ kind: 'visible', frame: { ...FRAME, height: undefined } }, 'invalid-visible-frame'],
    [{ kind: 'visible', frame: { ...FRAME, width: 0 } }, 'invalid-visible-frame'],
    [{ kind: 'visible', frame: { ...FRAME, height: -291 } }, 'invalid-visible-frame'],
    [{ kind: 'visible', frame: { ...FRAME, y: Number.NaN } }, 'invalid-visible-frame'],
  ];

  for (const [payload, reason] of cases) {
    assert.deepEqual(
      readSnapshotKeyboardBandFact(payload),
      { kind: 'unmeasurable', reason },
      `payload ${JSON.stringify(payload)}`,
    );
  }
});

test('a band is a plane, so a zero-size frame never reads as visible', () => {
  // The runner refuses the same frames on its side: `runnerKeyboardFrameIsUsable` requires a positive
  // size. A payload whose width or height is not positive describes no area, so nothing may be
  // measured against it.
  for (const frame of [
    { ...FRAME, width: 0 },
    { ...FRAME, height: 0 },
    { ...FRAME, width: -402 },
    { ...FRAME, height: Number.POSITIVE_INFINITY },
  ]) {
    assert.deepEqual(readSnapshotKeyboardBandFact({ kind: 'visible', frame }), {
      kind: 'unmeasurable',
      reason: 'invalid-visible-frame',
    });
  }
});

test('keyboard provenance validation rejects malformed derived bands and visibility probes', () => {
  for (const [fact, reason] of [
    [{ kind: 'derived', frame: FRAME }, 'unrecognized-derivation'],
    [
      { kind: 'derived', derivation: 'docked-tree', frame: { ...FRAME, width: 0 } },
      'invalid-derived-frame',
    ],
    [{ kind: 'visibility-only', visible: 'false' }, 'invalid-visibility-probe'],
    [{ kind: 'tree-rejected' }, 'unrecognized-derivation'],
    [
      { kind: 'tree-rejected', derivation: 'docked-tree', visible: 'true' },
      'invalid-visibility-probe',
    ],
  ] as const) {
    assert.deepEqual(readSnapshotKeyboardBandFact(fact), { kind: 'unmeasurable', reason });
  }
});

test('typed tree rejection preserves optional visibility without trusting a reason string', () => {
  for (const visible of [undefined, true, false]) {
    const fact = {
      kind: 'tree-rejected',
      derivation: 'docked-tree',
      ...(visible === undefined ? {} : { visible }),
    };
    assert.deepEqual(readSnapshotKeyboardBandFact(fact), fact);
  }
  assert.deepEqual(
    readSnapshotKeyboardBandFact({
      kind: 'unmeasurable',
      reason: 'keyboard-tree-geometry-unusable',
    }),
    { kind: 'unmeasurable', reason: 'keyboard-tree-geometry-unusable' },
  );
});
