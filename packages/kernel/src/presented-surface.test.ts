import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PRESENTED_SURFACE_STATES } from './snapshot.ts';
import { readPresentedSurfaceFact } from './record.ts';

// The presented-surface fact (#3565) arrives from two producers — the Apple runner's capture payload
// and a serialized snapshot response — and both seams read it here. What the reader must never do is
// turn a value it cannot name into silence: a consumer that arms the #1831 dismissal confirmation on
// `undefined` is back to guessing from a tree shape, which is the thing this fact retires.

test('a capture that published no fact stays silent, and only that payload is silent', () => {
  assert.equal(readPresentedSurfaceFact(undefined), undefined);
});

test('each declared state reads back as itself', () => {
  for (const state of PRESENTED_SURFACE_STATES) {
    assert.equal(readPresentedSurfaceFact(state), state);
  }
});

// The vocabulary is a closed set, so a producer that renames or invents a state must not reach a
// consumer as a state it cannot name. `absent` is the dangerous direction: reading a typo of it as
// `absent` would disarm a confirmation that is waiting for a dismissal.
test('a state this vocabulary never declared reads as unknown, never as absent', () => {
  for (const payload of ['none', 'Presented', 'no-sheet', '', 'null', 0, 1, true, [], {}, null]) {
    assert.equal(
      readPresentedSurfaceFact(payload),
      'unknown',
      `payload ${JSON.stringify(payload)}`,
    );
  }
});
