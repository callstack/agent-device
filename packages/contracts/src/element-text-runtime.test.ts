import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  bindElementTextRuntime,
  elementTextRead,
  type ElementTextReadOutcome,
  type ElementTextUnreadableReason,
} from './element-text-runtime.ts';
import type { Interactor } from './interactor-types.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * The reasons this suite exercises. Kept local on purpose: exhaustiveness is enforced at the
 * CONSUMER by `classifiedFallbackReason`'s `never` arm (a new reason is a compile error there),
 * so a second exported runtime list would be an unconsumed parallel source of truth that could
 * silently drift. The annotation is what ties this list back to the union.
 */
const UNREADABLE_REASONS: readonly ElementTextUnreadableReason[] = ['no-text-at-point'];

/**
 * ADR 0019 §2 contract coverage for the preferred element-text read.
 *
 * A preferred operation may fall its consumer back to the required path only through a TYPED
 * reason. These tests pin that the reason set is closed and exhaustively enumerated, so a new
 * reason cannot be added without a consumer having to classify it — which is what keeps the
 * retired generic `catch` from creeping back as "some other failure, just fall back".
 */

test('the outcome union is closed: every value is a read or a classified unreadable', () => {
  const outcomes: readonly ElementTextReadOutcome[] = [
    elementTextRead('live value'),
    ...UNREADABLE_REASONS.map((reason) => ({ status: 'unreadable', reason }) as const),
  ];
  for (const outcome of outcomes) {
    if (outcome.status === 'read') {
      assert.equal(typeof outcome.text, 'string');
      continue;
    }
    assert.ok(
      (UNREADABLE_REASONS as readonly string[]).includes(outcome.reason),
      `unreadable outcome carries an unclassified reason: ${outcome.reason}`,
    );
  }
});

test('a non-blank owner answer is a read that preserves the exact text', () => {
  const outcome = elementTextRead('  padded value  ');
  assert.deepEqual(outcome, { status: 'read', text: '  padded value  ' });
});

// Blank is a classification, not a read: an owner answering with whitespace has said there is
// nothing at this point, and saying so by reason keeps consumers off "empty or failed?" guesswork.
for (const [label, value] of [
  ['empty string', ''],
  ['whitespace', '   \n\t '],
  ['undefined', undefined],
  ['null', null],
] as const) {
  test(`a ${label} owner answer classifies as no-text-at-point`, () => {
    assert.deepEqual(elementTextRead(value), {
      status: 'unreadable',
      reason: 'no-text-at-point',
    });
  });
}

test('read outcomes are frozen so a consumer cannot mutate a classification', () => {
  assert.ok(Object.isFrozen(elementTextRead('value')));
  assert.ok(Object.isFrozen(elementTextRead('')));
});

/**
 * A runtime owner whose facts advertised `readTextAtPoint` but whose interactor cannot perform
 * it is a CONTRACT BUG, not a refusal. Classifying it as an unreadable reason would place it
 * inside the closed set that licenses falling back to already-captured text — so the command
 * would answer from a stale tree precisely because the runtime lied about itself.
 *
 * Reverting the guard to `{ status: 'unreadable', reason: … }` makes this test fail: the call
 * resolves instead of rejecting, which is the exact silent degradation it exists to forbid.
 */
test('an advertised read with no interactor implementation fails as a contract bug', async () => {
  const runtime = bindElementTextRuntime({
    device: { platform: 'ios' } as unknown as DeviceInfo,
    signal: new AbortController().signal,
    // An interactor with NO readTextAtPoint — the mismatch the facts promised away.
    resolveInteractor: async () => ({}) as unknown as Interactor,
  });

  await assert.rejects(
    () => runtime.readTextAtPoint({ point: { x: 1, y: 2 } }),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'runtime-contract-invalid' &&
      /advertised readTextAtPoint/.test(error.message),
  );
});
