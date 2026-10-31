import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ref } from './selector-read-utils.ts';
import {
  buttonSnapshot,
  createSettleDevice,
  welcomeSnapshot,
} from './__tests__/settle-device-fixtures.ts';

// #3470: the broad-transition confirmation owns the WAIT, not just the verdict, and it used to
// switch itself off whenever the caller asked for a window under the default. On the interaction
// commands' shared settle path that meant a `settleQuietMs: 150` caller (tester-army/e2e) got no
// guard at all while the default got a 1.5 s one. The same dismissed surface now settles at both
// requested windows: the response still reports the window the caller asked for, and the confirmed
// replacement sets the wait. `stable-capture.test.ts` pins that floor at the loop; this pins it on
// the observation the caller reads.
//
// Budgets are injected (fake clock) — no real waiting.

function pressThatDismissesTheWholeTree() {
  const before = buttonSnapshot();
  let captures = 0;
  const device = createSettleDevice({
    stored: before,
    captureSnapshot: () => {
      captures += 1;
      // A ref press resolves against the tree the session already holds and captures nothing before
      // the action, so every call here is the settle loop's own sample: capture 1 still shows the
      // pre-action tree, captures 2+ the tree the dismissal reveals.
      return { snapshot: captures === 1 ? before : welcomeSnapshot() };
    },
  });
  return device;
}

for (const requestedQuietMs of [500, 150]) {
  test(`a broad replacement on the interaction route holds the floor at ${requestedQuietMs}ms requested`, async () => {
    const result = await pressThatDismissesTheWholeTree().interactions.press(ref('@e1'), {
      session: 'default',
      settle: { quietMs: requestedQuietMs, timeoutMs: 5_000 },
    });

    const settle = result.settle;
    assert.ok(settle);
    assert.equal(settle.settled, true);
    // The window the caller asked for is what the response reports…
    assert.equal(settle.quietMs, requestedQuietMs);
    // …while the confirmed replacement sets the wait's floor (#3470).
    assert.ok(
      settle.waitedMs >= 1_500,
      `confirmation did not extend the settle: waitedMs=${settle.waitedMs}`,
    );
    assert.ok(settle.diff);
  });
}
