import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AcceptedDepthHints } from './depth-hints.ts';

test('hints are bounded per target and a probe that recovers relearns fresh uses', () => {
  const hints = new AcceptedDepthHints(2);
  const target = { targetId: 'app', generation: 'g1' };
  const recovered = { requests: 2, rejected: 1, continuations: 1, acceptedLevels: 32 };
  assert.equal(hints.learn(target, 65, false, recovered), 'learned');
  assert.equal(hints.consume(target, 65, false).reason, 'hinted');
  assert.equal(hints.consume(target, 65, false).reason, 'hinted');
  assert.equal(hints.consume(target, 65, false).reason, 'probe-back');
  assert.equal(hints.learn(target, 65, false, recovered), 'learned');
  assert.equal(hints.consume(target, 65, false).reason, 'hinted');

  // A hint never applies at or above the requested levels, and unidentified targets get none.
  assert.equal(hints.consume(target, 32, false).reason, 'no-hint');
  assert.equal(hints.consume({ generation: 'g1' }, 65, false).reason, 'unidentified-target');
  assert.equal(hints.learn({ generation: 'g1' }, 65, false, recovered), 'ignored');

  // Only the latest 32 targets are tracked; the oldest entry is evicted first.
  for (let index = 0; index < 32; index += 1) {
    hints.learn({ targetId: `other-${index}`, generation: 'g1' }, 65, false, recovered);
  }
  assert.equal(hints.consume(target, 65, false).reason, 'no-hint');
  assert.equal(
    hints.consume({ targetId: 'other-31', generation: 'g1' }, 65, false).reason,
    'hinted',
  );
});
