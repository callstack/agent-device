import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { PresentedSurface } from './snapshot.ts';
import { readPresentedSurfaceFact } from './record.ts';

// The presented-surface fact (#3565) arrives from two producers — the Apple runner's capture payload
// and a serialized snapshot response — and both seams read it here. What the reader must never do is
// turn a value it cannot name into silence: a consumer that arms the #1831 dismissal confirmation on
// `undefined` is back to guessing from a tree shape, which is the thing this fact retires.
//
// It takes the payload rather than the value it holds, so the lookup itself is owned here: every
// caller reading a wire fact is doing a property lookup on data the producer controls.

// One-argument form publishes the key with that value, `undefined` included, so a test can name the
// difference between a producer that never wrote the key and one that wrote it with nothing in it.
const carrying = (presentedSurface: unknown): Record<string, unknown> => ({
  nodeCount: 2,
  presentedSurface,
});

test('a capture that published no fact stays silent, and only that payload is silent', () => {
  assert.equal(readPresentedSurfaceFact({ nodeCount: 2 }), undefined);
});

// A key that is present with no value is not the same event as no key: the producer declared the fact
// and failed to state it, which is what `unknown` exists to say. Collapsing the two would let a
// producer that dropped the value read exactly like a backend that has never had the fact at all.
test('a published key holding no value reads unknown, not the silence of no key', () => {
  assert.equal(readPresentedSurfaceFact(carrying(undefined)), 'unknown');
});

// A missing key and an inherited one are not the same event, and only one of them is silence: a plain
// lookup walks to `Object.prototype`, where any module sharing the process could park a value, and
// `absent` is precisely the state that tells #1831 no dismissal is owed.
test('a payload with no own fact key is silent rather than inherited', () => {
  Object.defineProperty(Object.prototype, 'presentedSurface', {
    value: 'absent',
    configurable: true,
    writable: true,
  });
  try {
    assert.equal(readPresentedSurfaceFact({ nodeCount: 2 }), undefined);
    assert.equal(
      readPresentedSurfaceFact(JSON.parse('{"presentedSurface":"presented"}')),
      'presented',
    );
  } finally {
    delete (Object.prototype as unknown as Record<string, unknown>).presentedSurface;
  }
});

test('each declared state reads back as itself', () => {
  const states: PresentedSurface[] = ['presented', 'absent', 'unknown'];
  for (const state of states) {
    assert.equal(readPresentedSurfaceFact(carrying(state)), state);
  }
});

// The vocabulary is a closed set, so a producer that renames or invents a state must not reach a
// consumer as a state it cannot name. `absent` is the dangerous direction: reading a typo of it as
// `absent` would disarm a confirmation that is waiting for a dismissal.
test('a state this vocabulary never declared reads as unknown, never as absent', () => {
  for (const payload of ['none', 'Presented', 'no-sheet', '', 'null', 0, 1, true, [], {}, null]) {
    assert.equal(
      readPresentedSurfaceFact(carrying(payload)),
      'unknown',
      `payload ${JSON.stringify(payload)}`,
    );
  }
});

// The reader trusts only its own table's own properties, so a published value that happens to name an
// inherited `Object.prototype` member is not a state.
test('a published value naming an inherited object member is not a state', () => {
  for (const payload of ['constructor', 'toString', '__proto__']) {
    assert.equal(readPresentedSurfaceFact(carrying(payload)), 'unknown', payload);
  }
});
