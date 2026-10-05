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
import { raceRunnerStartAgainstCaller } from '../runner-start-budget.ts';
import { registerRunnerPrepProcess } from '../runner-artifact.ts';
import { runnerPrepProcessChildren } from '../runner-xctestrun.ts';

const mockSignalPidsBestEffort = vi.fn();
const mockSignalProcessGroupBestEffort = vi.fn();
const mockRunAppleToolCommand = vi.fn();
const mockGetRequestSignal = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  mockRunAppleToolCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mockGetRequestSignal.mockReturnValue(undefined);
  appleRunnerTestHost.update({
    signalPidsBestEffort: mockSignalPidsBestEffort,
    signalProcessGroupBestEffort: mockSignalProcessGroupBestEffort,
    runAppleToolCommand: mockRunAppleToolCommand,
    getRequestSignal: mockGetRequestSignal,
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
 * The waiter's cancel owns the build it waited on (#3177). A request canceled while queued behind
 * a detached cold build must stop that build: its spawn carried only the STARTING request's
 * cancellation signal, so without the waiter's device-scoped prep kill the build would keep
 * compiling under the daemon on the shared runner derived-data root, and a retried `open` would
 * race it. The kill is the same tree-kill escalation a session stop uses. Here the build's owner
 * has no live request signal (its start is detached), so the waiter is allowed to stop it.
 */
test('a request canceled while waiting on the detached start stops that device build', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-waiter-cancel-sim' };
  const build = makePrepChild(4848);
  registerRunnerPrepProcess(device.id, build, 'owner-request-gone');
  mockGetRequestSignal.mockImplementation((requestId?: string) =>
    requestId === 'owner-request-gone' ? AbortSignal.abort() : undefined,
  );

  const controller = new AbortController();
  controller.abort(createRequestCanceledError());
  await assert.rejects(
    raceRunnerStartAgainstCaller(hangingStart(), controller.signal, device.id),
    canceled,
  );
  await settleAsyncWork();

  assert.ok(
    signaledPids().includes(4848),
    'the waiter cancel reached the build through the prep tree-kill path',
  );
  assert.equal(
    runnerPrepProcessChildren(device.id).length,
    0,
    'the killed build left the prep ledger',
  );
});

/**
 * A canceled waiter must not reach a build still owned by an in-flight request (#3177 review).
 * The owner cancels its own build through its live request signal at the exec layer; a waiter
 * tearing it down would SIGTERM another active request's work out from under it. Here the build's
 * owner still has a registered, un-aborted signal, so the canceled waiter leaves it running.
 */
test('a canceled waiter leaves a build owned by a still-active request', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-waiter-owner-active-sim' };
  const build = makePrepChild(4850);
  registerRunnerPrepProcess(device.id, build, 'owner-request-live');
  mockGetRequestSignal.mockImplementation((requestId?: string) =>
    requestId === 'owner-request-live' ? new AbortController().signal : undefined,
  );

  const controller = new AbortController();
  controller.abort(createRequestCanceledError());
  await assert.rejects(
    raceRunnerStartAgainstCaller(hangingStart(), controller.signal, device.id),
    canceled,
  );
  await settleAsyncWork();

  assert.equal(
    mockSignalProcessGroupBestEffort.mock.calls.length,
    0,
    'a canceled waiter never signals a build another active request owns',
  );
  assert.deepEqual(
    runnerPrepProcessChildren(device.id).map((child) => child.pid),
    [4850],
    'the owned build stayed registered',
  );
});

/**
 * #2894 still holds on this seam: the caller's own deadline (a bounded poll) is NOT a
 * cancellation. The start it interrupts is the one the retry joins, so a deadline must leave the
 * device's build running and un-signaled.
 */
test('a caller deadline on the same waiter leaves the build running', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-waiter-deadline-sim' };
  const build = makePrepChild(4949);
  registerRunnerPrepProcess(device.id, build);

  const controller = new AbortController();
  const waiting = raceRunnerStartAgainstCaller(hangingStart(), controller.signal, device.id);
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
});

/**
 * The kill is scoped to the waiting device. A canceled waiter for device A must not signal the
 * build device B is still paying for — the same request-scoping rule this PR applies to the
 * daemon-side timeout recovery.
 */
test('a canceled waiter signals only its own device build', async () => {
  const device = { ...IOS_SIMULATOR, id: 'runner-waiter-scope-sim' };
  const ownBuild = makePrepChild(5050);
  const siblingBuild = makePrepChild(5151);
  registerRunnerPrepProcess(device.id, ownBuild);
  registerRunnerPrepProcess('other-device', siblingBuild);

  const controller = new AbortController();
  controller.abort(createRequestCanceledError());
  await assert.rejects(
    raceRunnerStartAgainstCaller(hangingStart(), controller.signal, device.id),
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
