import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  addRunnerStartWaiter,
  cancelRunnerStartWaiter,
  fenceRunnerStartAdmissionsForTeardown,
  finishRunnerStartAdmission,
  openRunnerStartAdmission,
  openRunnerStartLoopAdmission,
  readmitRunnerStartAdmission,
  runnerStartAdmitsPreparation,
  runnerStartRetiredError,
  runnerStartTeardownPending,
} from '../runner-xctestrun.ts';

// The start-admission decisions #3220 puts in one place: whether one start may still prepare, and
// which cancellation is the last one. These are the primitives the spawn seam, the publish point,
// and the caller race read; the spawn and publish paths themselves are exercised at their own
// seams (runner-artifact-start-admission, runner-session-close-prep-fence).

beforeEach(() => {
  appleRunnerTestHost.update({ emitDiagnostic: vi.fn() });
});

function retiredReason(error: unknown): unknown {
  assert.ok(error instanceof Error);
  return (error as { details?: { runnerStartRetirementReason?: unknown } }).details
    ?.runnerStartRetirementReason;
}

/**
 * A start cannot prepare once a teardown has closed its admission, and the refusal says which
 * reason closed it: a caller switching on the reason must never read a message to learn whether
 * the device went down or its waiters left.
 */
test('a closed start admits no preparation and says why', () => {
  const admission = openRunnerStartAdmission('admission-retire-sim');
  const settle = fenceRunnerStartAdmissionsForTeardown('admission-retire-sim');

  assert.equal(admission.admitted, false);
  assert.equal(runnerStartAdmitsPreparation('admission-retire-sim', admission), false);
  assert.equal(runnerStartAdmitsPreparation('admission-retire-sim'), false);
  const error = runnerStartRetiredError(admission.retired ?? 'last_waiter_canceled');
  assert.ok(isRequestCanceledError(error), 'a retirement is a cancellation of the work');
  assert.equal(retiredReason(error), 'device_teardown');
  settle();
  finishRunnerStartAdmission(admission);
});

/**
 * A device under a teardown admits no preparation at all — the fence answers by device, so it
 * reaches preparation carrying no start's token, a cache prewarm's build — and the answer lifts
 * the moment the teardown settles (#3220). A start that opened mid-close was never that close's
 * victim: its own verdict is untouched, so it runs once the fence lifts instead of failing for a
 * close it took no part in.
 */
test('a device under a teardown admits no preparation and frees once it settles', () => {
  const settle = fenceRunnerStartAdmissionsForTeardown('admission-fence-sim');
  assert.equal(runnerStartTeardownPending('admission-fence-sim'), true);

  const midClose = openRunnerStartAdmission('admission-fence-sim');
  assert.equal(
    runnerStartAdmitsPreparation('admission-fence-sim', midClose),
    false,
    'a start that opens mid-close is refused',
  );

  settle();
  assert.equal(runnerStartTeardownPending('admission-fence-sim'), false);
  assert.equal(
    runnerStartAdmitsPreparation('admission-fence-sim', midClose),
    true,
    'the queued start is not the close: it runs once the fence lifts',
  );
  assert.equal(midClose.admitted, true);
  finishRunnerStartAdmission(midClose);
});

/**
 * A start that was in flight when the close began keeps its closed verdict after the fence lifts:
 * its retry is the replacement build the fence exists for, so it can never resume into the fresh
 * start a later open makes (#3220).
 */
test('a start the close found in flight keeps its verdict after the fence lifts', () => {
  const device = 'admission-verdict-sim';
  const inFlight = openRunnerStartAdmission(device);
  const settle = fenceRunnerStartAdmissionsForTeardown(device);
  settle();

  assert.equal(inFlight.admitted, false, 'the close closed it while it was in flight');
  assert.equal(inFlight.retired, 'device_teardown');
  assert.equal(runnerStartAdmitsPreparation(device, inFlight), false);
  assert.equal(
    runnerStartAdmitsPreparation(device),
    true,
    'and the device itself is free for the next open',
  );
  finishRunnerStartAdmission(inFlight);
});

/**
 * A settle is idempotent: a teardown that settles inside the lock it took and again in a
 * `finally` must not lift another teardown's fence with the second call.
 */
test('one teardown settling twice lifts only its own fence', () => {
  const device = 'admission-double-settle-sim';
  const first = fenceRunnerStartAdmissionsForTeardown(device);
  const second = fenceRunnerStartAdmissionsForTeardown(device);

  first();
  first();
  assert.equal(runnerStartTeardownPending(device), true, 'the second teardown still fences');
  second();
  assert.equal(runnerStartTeardownPending(device), false);
});

/**
 * Waiters are counted: canceling one preserves the work another still expects, and only the
 * final cancellation is allowed to stop it. Without the count, one client disconnecting would
 * SIGTERM a build a live request is waiting on.
 */
test('only the final interested waiter closes admission and owns the stop', () => {
  const admission = openRunnerStartAdmission('admission-waiters-sim');
  const first = new AbortController();
  const second = new AbortController();
  addRunnerStartWaiter(admission, first.signal);
  addRunnerStartWaiter(admission, second.signal);

  assert.equal(cancelRunnerStartWaiter(admission, first.signal), false);
  assert.equal(admission.admitted, true, 'a waiter still interested keeps the work admitted');

  assert.equal(cancelRunnerStartWaiter(admission, second.signal), true);
  assert.equal(admission.admitted, false);
  assert.equal(admission.retired, 'last_waiter_canceled');
  finishRunnerStartAdmission(admission);
});

/**
 * A start closed by a cancellation is never reopened: a caller whose start was canceled for lack
 * of interest has no claim on re-admission, and a device that has since gone quiet again must not
 * hand its work back to it.
 */
test('a cancellation-closed start is never readmitted', () => {
  const device = 'admission-cancel-closed-sim';
  const admission = openRunnerStartAdmission(device);
  const waiter = new AbortController();
  addRunnerStartWaiter(admission, waiter.signal);
  assert.equal(cancelRunnerStartWaiter(admission, waiter.signal), true);

  assert.equal(readmitRunnerStartAdmission(admission), false);
  assert.equal(admission.admitted, false);
  finishRunnerStartAdmission(admission);
});

/**
 * A start that only QUEUED behind a teardown is not that teardown's retry: once the fence has
 * settled, the woken start is readmitted and runs, instead of failing forever for a close it never
 * took part in (#3220 review). While the fence still stands, nothing re-admits — that is the
 * mid-close retry the fence exists for.
 */
test('a start queued behind a settled teardown is readmitted; one under the fence is not', () => {
  const device = 'admission-readmit-sim';
  const admission = openRunnerStartAdmission(device);
  const settle = fenceRunnerStartAdmissionsForTeardown(device);

  // Mid-close: the fence still stands, so the queued start stays refused.
  assert.equal(readmitRunnerStartAdmission(admission), false);
  assert.equal(admission.admitted, false);

  settle();
  assert.equal(readmitRunnerStartAdmission(admission), true);
  assert.equal(admission.admitted, true);
  assert.equal(runnerStartAdmitsPreparation(device, admission), true);
  finishRunnerStartAdmission(admission);
});

/**
 * A readmit never steps into a newer teardown: a second close that fences the device again leaves
 * the woken start refused rather than handing it a verdict it already lost.
 */
test('a queued start is not readmitted under a newer fence', () => {
  const device = 'admission-readmit-fenced-sim';
  const admission = openRunnerStartAdmission(device);
  const first = fenceRunnerStartAdmissionsForTeardown(device);
  first();
  const second = fenceRunnerStartAdmissionsForTeardown(device);

  assert.equal(readmitRunnerStartAdmission(admission), false);
  second();
  finishRunnerStartAdmission(admission);
});

/**
 * Two starts on one device are independent: a teardown closes both while it runs, and the one
 * that merely queued is readmitted once it settles while the other keeps its verdict until it
 * finishes its own work.
 */
test('independent starts on one device carry independent verdicts', () => {
  const device = 'admission-two-starts-sim';
  const queued = openRunnerStartAdmission(device);
  const settle = fenceRunnerStartAdmissionsForTeardown(device);
  const later = openRunnerStartAdmission(device);

  assert.equal(queued.admitted, false, 'the start in flight when close began is closed');
  assert.equal(
    runnerStartAdmitsPreparation(device, later),
    false,
    'the later open is refused while the fence stands',
  );

  settle();
  assert.equal(readmitRunnerStartAdmission(queued), true);
  assert.equal(
    readmitRunnerStartAdmission(later),
    false,
    'a token still open needs no readmit — its verdict was never closed',
  );
  assert.equal(later.admitted, true);
  finishRunnerStartAdmission(queued);
  finishRunnerStartAdmission(later);
});

/**
 * A start that settled leaves the device's in-flight set, so a later teardown does not close a
 * verdict nobody is waiting on any more; the state leaves the registry with its last member.
 */
test('a settled start leaves the device state, and an empty device leaves the registry', () => {
  const device = 'admission-finish-sim';
  const admission = openRunnerStartAdmission(device);
  finishRunnerStartAdmission(admission);

  const settle = fenceRunnerStartAdmissionsForTeardown(device);
  assert.equal(admission.admitted, true, 'the finished start answers to no fence');
  settle();
  assert.equal(runnerStartTeardownPending(device), false);
});

/**
 * The prepare loop owns its token across retries, and its health retry is exactly the
 * replacement build the fence exists for (#3220 review): a fence that closes the loop
 * retires the whole loop, and the settle of that fence must not hand the loop's next
 * attempt back a verdict it lost. A loop token is only ever released by the loop.
 */
test('a loop-supplied token is never reopened by a settled fence', () => {
  const device = 'admission-loop-sim';
  const loop = openRunnerStartLoopAdmission(device);
  const settle = fenceRunnerStartAdmissionsForTeardown(device);
  settle();

  assert.equal(loop.admitted, false, 'the close closed the loop in flight');
  assert.equal(
    readmitRunnerStartAdmission(loop),
    false,
    'the settled fence never reopens a loop token',
  );
  assert.equal(runnerStartAdmitsPreparation(device, loop), false);
  finishRunnerStartAdmission(loop);
});

/**
 * Both halves of the loop rule at once: the retiring loop keeps its refusal after the
 * fence lifts, while an independent open that merely queued behind that same fence is
 * readmitted and builds on its own.
 */
test('a settled fence refuses the retiring loop and readmits the queued open', () => {
  const device = 'admission-loop-and-open-sim';
  const loop = openRunnerStartLoopAdmission(device);
  const queued = openRunnerStartAdmission(device);
  const settle = fenceRunnerStartAdmissionsForTeardown(device);
  settle();

  assert.equal(readmitRunnerStartAdmission(loop), false);
  assert.equal(loop.admitted, false, 'the loop stays retired: its retry was the replacement');
  assert.equal(readmitRunnerStartAdmission(queued), true);
  assert.equal(queued.admitted, true, 'the queued open is a fresh start');
  finishRunnerStartAdmission(loop);
  finishRunnerStartAdmission(queued);
});
