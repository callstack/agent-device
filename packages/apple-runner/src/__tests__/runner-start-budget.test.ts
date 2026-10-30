import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, test, vi } from 'vitest';
import type { ExecBackgroundResult } from '@agent-device/host-kit/command';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  raceRunnerStartAgainstCaller,
  reserveRunnerStartOwnerInterest,
} from '../runner-start-budget.ts';
import { registerRunnerPrepProcess } from '../runner-artifact.ts';
import {
  addRunnerStartWaiter,
  fenceRunnerStartAdmissionsForTeardown,
  openRunnerStartAdmission,
  runnerPrepProcessChildren,
} from '../runner-xctestrun.ts';

const mockSignalPidsBestEffort = vi.fn();
const mockSignalProcessGroupBestEffort = vi.fn();
const mockRunAppleToolCommand = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  mockRunAppleToolCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  appleRunnerTestHost.update({
    signalPidsBestEffort: mockSignalPidsBestEffort,
    signalProcessGroupBestEffort: mockSignalProcessGroupBestEffort,
    runAppleToolCommand: mockRunAppleToolCommand,
  });
});

function callerDeadline(): DOMException {
  return new DOMException('Wait deadline exceeded', 'TimeoutError');
}

/** A detached start nobody has finished — the shape of a cold build still under the lock. */
function hangingStart(): Promise<never> {
  return new Promise<never>(() => {});
}

function makePrepChild(pid: number): ExecBackgroundResult['child'] {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
  }) as ExecBackgroundResult['child'];
}

function signaledPids(): number[] {
  return mockSignalProcessGroupBestEffort.mock.calls.map(([pid]) => pid as number);
}

function canceled(error: unknown): boolean {
  return isRequestCanceledError(error) && error instanceof AppError;
}

async function settleAsyncWork(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The last interested waiter owns the build it waited on (#3177, #3220). A request canceled
 * while queued behind a detached cold build must stop that build: its spawn carried only the
 * STARTING request's cancellation signal, so without the waiter's device-scoped prep kill the
 * build would keep compiling under the daemon on the shared runner derived-data root, where a
 * retried `open` would race it. The kill is the same tree-kill escalation a session stop uses.
 */
test('the last waiter canceled while waiting on the start stops that device build', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-waiter-cancel-sim' };
  const admission = openRunnerStartAdmission(device.id);
  const build = makePrepChild(4848);
  registerRunnerPrepProcess(device.id, build, admission);

  const controller = new AbortController();
  controller.abort(createRequestCanceledError());
  await assert.rejects(
    raceRunnerStartAgainstCaller(hangingStart(), admission, controller.signal),
    canceled,
  );
  await settleAsyncWork();

  assert.ok(
    signaledPids().includes(4848),
    'the last waiter cancel reached the build through the prep tree-kill path',
  );
  assert.equal(runnerPrepProcessChildren(device.id).length, 0, 'the killed build left the ledger');
  assert.equal(admission.admitted, false, 'and admission closed so nothing rebuilds (#3220)');
});

/**
 * A canceled waiter must not reach a build another waiter still expects (#3177 review, #3220).
 * The build belongs to work somebody is waiting on, and one request tearing it down would
 * SIGTERM that waiter's work out from under it. Here a second caller still holds interest, so
 * the canceled waiter leaves the build running and admitted.
 */
test('a canceled waiter leaves the build while another waiter is still interested', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-waiter-peer-sim' };
  const admission = openRunnerStartAdmission(device.id);
  const build = makePrepChild(4850);
  registerRunnerPrepProcess(device.id, build, admission);
  addRunnerStartWaiter(admission, new AbortController().signal);

  const controller = new AbortController();
  controller.abort(createRequestCanceledError());
  await assert.rejects(
    raceRunnerStartAgainstCaller(hangingStart(), admission, controller.signal),
    canceled,
  );
  await settleAsyncWork();

  assert.equal(
    mockSignalProcessGroupBestEffort.mock.calls.length,
    0,
    'a canceled waiter never signals a build another waiter still needs',
  );
  assert.deepEqual(
    runnerPrepProcessChildren(device.id).map((child) => child.pid),
    [4850],
    'the needed build stayed registered',
  );
  assert.equal(admission.admitted, true, 'a live waiter keeps preparation admitted');
});

/**
 * #2894 still holds on this seam: the caller's own deadline (a bounded poll) is NOT a
 * cancellation. The start it interrupts is the one the retry joins, so a deadline must leave the
 * device's build running and un-signaled.
 */
test('a caller deadline on the same waiter leaves the build running', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-waiter-deadline-sim' };
  const admission = openRunnerStartAdmission(device.id);
  const build = makePrepChild(4949);
  registerRunnerPrepProcess(device.id, build, admission);

  const controller = new AbortController();
  const waiting = raceRunnerStartAgainstCaller(hangingStart(), admission, controller.signal);
  controller.abort(callerDeadline());
  await assert.rejects(waiting, canceled);
  await settleAsyncWork();

  assert.equal(
    mockSignalProcessGroupBestEffort.mock.calls.length,
    0,
    'a deadline never signals the build a retry needs (#2894)',
  );
  assert.deepEqual(
    runnerPrepProcessChildren(device.id).map((child) => child.pid),
    [4949],
    'the deadline left the build registered',
  );
  assert.equal(admission.admitted, true, 'a deadline never closes admission');
});

/**
 * A build its caller left on a deadline is still owned work: the start it belongs to keeps
 * running for that caller's retry (#2894), so a DIFFERENT caller's cancellation must not reach
 * it. This is the case #3193's owner sniff protected by reading the owning request's liveness;
 * the start's own token carries the fact now (#3220).
 */
test("a canceled caller leaves the build another caller's deadline detached", async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-waiter-deadline-owner-sim' };
  const detachedStart = openRunnerStartAdmission(device.id);
  const build = makePrepChild(4960);
  registerRunnerPrepProcess(device.id, build, detachedStart);

  // Caller one leaves its start running on its own deadline.
  const deadlineController = new AbortController();
  const detachedWait = raceRunnerStartAgainstCaller(
    hangingStart(),
    detachedStart,
    deadlineController.signal,
  ).catch((error: unknown) => error);
  deadlineController.abort(callerDeadline());
  await detachedWait;

  // A second caller, on its own start, then cancels.
  const otherAdmission = openRunnerStartAdmission(device.id);
  const cancelController = new AbortController();
  cancelController.abort(createRequestCanceledError());
  await assert.rejects(
    raceRunnerStartAgainstCaller(hangingStart(), otherAdmission, cancelController.signal),
    canceled,
  );
  await settleAsyncWork();

  assert.equal(
    mockSignalProcessGroupBestEffort.mock.calls.length,
    0,
    'a cancel reaches only builds no live caller owns',
  );
  assert.deepEqual(
    runnerPrepProcessChildren(device.id).map((child) => child.pid),
    [4960],
    'the deadline-detached build the retry will join is still running',
  );
});

/**
 * A cancellation that arrives after a teardown already fenced the device stops nothing new: the
 * teardown killed the device's builds under the same fence, and a late cancel must not claim a
 * build a later open on that device has already started paying for. The later start's child is
 * registered here so the assertion says the new build is still running, not merely that no
 * signal was attempted.
 */
test('a canceled waiter after a teardown stops nothing a later start needs', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-waiter-after-teardown-sim' };
  const fenced = openRunnerStartAdmission(device.id);
  // The teardown's own sweep is over; the fence lifts, and the next open pays for its own build.
  fenceRunnerStartAdmissionsForTeardown(device.id)();
  const freshAdmission = openRunnerStartAdmission(device.id);
  const neededBuild = makePrepChild(4951);
  registerRunnerPrepProcess(device.id, neededBuild, freshAdmission);

  const controller = new AbortController();
  controller.abort(createRequestCanceledError());
  await assert.rejects(
    raceRunnerStartAgainstCaller(hangingStart(), fenced, controller.signal),
    canceled,
  );
  await settleAsyncWork();

  assert.equal(
    mockSignalProcessGroupBestEffort.mock.calls.length,
    0,
    'the teardown already did the stopping',
  );
  assert.deepEqual(
    runnerPrepProcessChildren(device.id).map((child) => child.pid),
    [4951],
    "the later start's build is still running and still registered",
  );
});

/**
 * The kill is scoped to the waiting device. A canceled waiter for device A must not signal the
 * build device B is still paying for — the same request-scoping rule #3177 applies to the
 * daemon-side timeout recovery.
 */
test('a canceled waiter signals only its own device build', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-waiter-scope-sim' };
  const admission = openRunnerStartAdmission(device.id);
  const ownBuild = makePrepChild(5050);
  const siblingBuild = makePrepChild(5151);
  registerRunnerPrepProcess(device.id, ownBuild, admission);
  registerRunnerPrepProcess('other-device', siblingBuild);

  const controller = new AbortController();
  controller.abort(createRequestCanceledError());
  await assert.rejects(
    raceRunnerStartAgainstCaller(hangingStart(), admission, controller.signal),
    canceled,
  );
  await settleAsyncWork();

  assert.ok(signaledPids().includes(5050), 'the waiting device build was signaled');
  assert.ok(
    !signaledPids().includes(5151),
    'a build for another device was left running (#3177 sibling protection)',
  );
});

/** A prep child that exits on its own leaves the ledger through its close event. */
test('a closed build leaves the prep ledger on its own', () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-prep-close-sim' };
  const build = new EventEmitter();
  registerRunnerPrepProcess(
    device.id,
    Object.assign(build, { pid: 5252 }) as ExecBackgroundResult['child'],
  );
  assert.equal(runnerPrepProcessChildren(device.id).length, 1);
  build.emit('close');
  assert.equal(runnerPrepProcessChildren(device.id).length, 0);
});

/**
 * The starting request counts as interested even where the caller passes no `signal` (#3220
 * review): a joiner's cancellation must not outvote the live owner and SIGTERM its build out
 * from under it — the protection the removed #3193 owner sniff carried, now by mechanism.
 */
test('owner interest keeps a joiner cancel from stopping the starting request build', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-owner-interest-sim' };
  const requestId = 'owner-request-live-' + device.id;
  const owner = new AbortController();
  appleRunnerTestHost.update({
    getRequestSignal: (id?: string) => (id === requestId ? owner.signal : undefined),
  });
  const admission = openRunnerStartAdmission(device.id);
  const build = makePrepChild(5353);
  registerRunnerPrepProcess(device.id, build, admission);
  const releaseOwner = reserveRunnerStartOwnerInterest(admission, { requestId });

  const joiner = new AbortController();
  joiner.abort(createRequestCanceledError());
  await assert.rejects(
    raceRunnerStartAgainstCaller(hangingStart(), admission, joiner.signal),
    canceled,
  );
  await settleAsyncWork();

  assert.equal(mockSignalProcessGroupBestEffort.mock.calls.length, 0);
  assert.deepEqual(
    runnerPrepProcessChildren(device.id).map((child) => child.pid),
    [5353],
    'the owner still counts: the joiner cancel stopped nothing',
  );
  assert.equal(admission.admitted, true);

  // The owner's own disconnect is the last interest leaving: it closes and stops.
  owner.abort(createRequestCanceledError());
  await settleAsyncWork();
  assert.ok(signaledPids().includes(5353), 'the owner cancel reaches its own build');
  assert.equal(admission.admitted, false, 'and admission closed so nothing rebuilds');
  releaseOwner();
});

/** A start that settles releases its owner interest; the next cancel owns the stop. */
test('a settled start releases owner interest', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-owner-released-sim' };
  const requestId = 'owner-request-settled-' + device.id;
  const owner = new AbortController();
  appleRunnerTestHost.update({
    getRequestSignal: (id?: string) => (id === requestId ? owner.signal : undefined),
  });
  const admission = openRunnerStartAdmission(device.id);
  const build = makePrepChild(5454);
  registerRunnerPrepProcess(device.id, build, admission);
  reserveRunnerStartOwnerInterest(admission, { requestId })();

  const joiner = new AbortController();
  joiner.abort(createRequestCanceledError());
  await assert.rejects(
    raceRunnerStartAgainstCaller(hangingStart(), admission, joiner.signal),
    canceled,
  );
  await settleAsyncWork();

  assert.ok(signaledPids().includes(5454), 'with the owner counted out, the joiner is last');
  assert.equal(admission.admitted, false);
});
