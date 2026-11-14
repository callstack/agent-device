// The phase budget of one artifact-transfer attempt (#4441), on a controlled clock. Each ceiling ends a
// stalled attempt on its own, and none of them touches the aggregate the attempt was admitted under.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ClientRequest } from 'node:http';
import { afterEach, beforeEach, onTestFinished, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  createTransferPhaseWatchdog,
  isTransferPhaseTimeoutError,
  observeClientRequestPhases,
  observeCompletedRequestWrites,
  TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  TRANSFER_CONNECT_TIMEOUT_MS,
  TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  type TransferPhaseWatchdog,
} from './transport.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A watchdog disposed when its test finishes. */
function watchPhases(callerSignal?: AbortSignal): TransferPhaseWatchdog {
  const watchdog = createTransferPhaseWatchdog(callerSignal);
  onTestFinished(() => watchdog.dispose());
  return watchdog;
}

test('the three transfer ceilings are the adopted policy values', () => {
  assert.equal(TRANSFER_CONNECT_TIMEOUT_MS, 30_000);
  assert.equal(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS, 30_000);
  assert.equal(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS, 120_000);
});

test('a body phase restarts its ceiling on every byte that moves', async () => {
  const watchdog = watchPhases();
  watchdog.arm('response-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
  // Three full ceilings' worth of wall clock, each broken by real progress: 300 seconds of a slow
  // artifact is admitted work, and nothing here may end it.
  for (const _ of [0, 1, 2]) {
    await vi.advanceTimersByTimeAsync(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS - 20_000);
    watchdog.touchBody();
  }
  assert.equal(watchdog.signal.aborted, false);
  await vi.advanceTimersByTimeAsync(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 1);
  assert.equal(watchdog.signal.aborted, true);
  assertPhaseDetails(watchdog.signal.reason, 'response-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
});

test('a phase that carries no bytes is not extended by progress reported in another phase', async () => {
  const watchdog = watchPhases();
  watchdog.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS - 10_000);
  // Bytes moving elsewhere — an unrelated header, a keepalive, a timer callback — are not the
  // response-header wait making progress.
  watchdog.touchBody();
  await vi.advanceTimersByTimeAsync(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
  assertPhaseDetails(
    watchdog.signal.reason,
    'response-headers',
    TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  );
});

test('arming the next phase stops counting the previous one', async () => {
  const watchdog = watchPhases();
  watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS - 1_000);
  watchdog.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
  // 58 seconds of total attempt time: past the connect ceiling, which the completed hop may spend,
  // and inside the header ceiling the attempt is actually waiting on.
  await vi.advanceTimersByTimeAsync(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS - 1_000);
  assert.equal(watchdog.signal.aborted, false);
  await vi.advanceTimersByTimeAsync(1_000);
  assertPhaseDetails(
    watchdog.signal.reason,
    'response-headers',
    TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  );
});

test('an enclosing deadline wins and is never extended by a phase timer', async () => {
  const caller = new AbortController();
  const reason = new Error('preparation aggregate expired');
  setTimeout(() => caller.abort(reason), 5_000);
  const watchdog = watchPhases(caller.signal);
  watchdog.arm('response-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(5_001);
  // The caller's reason is the answer, not a phase's own evidence, so a consumer can still tell
  // "the work this upload served is gone" from "this transfer stalled".
  assert.equal(watchdog.signal.aborted, true);
  assert.equal(watchdog.signal.reason, reason);
  assert.equal(isTransferPhaseTimeoutError(watchdog.signal.reason), false);
});

test('a phase expiry is its own typed evidence and never caller cancellation', async () => {
  const caller = new AbortController();
  const watchdog = watchPhases(caller.signal);
  watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
  await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS + 1);
  assertPhaseDetails(watchdog.signal.reason, 'connect', TRANSFER_CONNECT_TIMEOUT_MS);
  // Distinctness the retry policy depends on: nobody canceled, so the caller's own signal stays
  // live and an enclosing aggregate is free to reach a different outcome.
  assert.equal(caller.signal.aborted, false);
});

test('a disposed watchdog stops watching', async () => {
  const watchdog = watchPhases();
  watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
  watchdog.dispose();
  await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS * 3);
  assert.equal(watchdog.signal.aborted, false);
});

test('a phase is never armed after the attempt is already over', async () => {
  const watchdog = watchPhases();
  watchdog.signal.throwIfAborted();
  const caller = new AbortController();
  caller.abort(new Error('gone'));
  const late = watchPhases(caller.signal);
  late.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
  assert.equal(vi.getTimerCount(), 0);
  await vi.advanceTimersByTimeAsync(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS * 2);
  assert.equal(late.signal.reason.message, 'gone');
});

type FakeSocket = EventEmitter & { connecting: boolean; encrypted?: boolean };

/** A request whose writes the test completes by hand, as Node does once a chunk reaches the kernel. */
class FakeRequest extends EventEmitter {
  destroyed = false;
  readonly callbacks: unknown[] = [];
  write(...args: unknown[]): boolean {
    this.callbacks.push(args.find((arg) => typeof arg === 'function'));
    return true;
  }
  complete(index: number): void {
    const callback = this.callbacks[index];
    assert.ok(typeof callback === 'function', `write ${index} has no callback`);
    callback(null);
  }
}

/** One request observed as the upload attempt observes it: the phase owner beside the write owner. */
function createObservedRequest() {
  const fake = new FakeRequest();
  const watchdog = watchPhases();
  watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
  const req = fake as unknown as ClientRequest;
  const phases = observeClientRequestPhases(req, watchdog);
  const stopObservingWrites = observeCompletedRequestWrites(req, watchdog.signal, () =>
    watchdog.touchBody(),
  );
  const emit = (event: string, ...args: unknown[]) => fake.emit(event, ...args);
  const socket = (state: { connecting: boolean; encrypted?: boolean }): FakeSocket =>
    Object.assign(new EventEmitter(), state);
  return { fake, req, watchdog, phases, stopObservingWrites, emit, socket };
}

test('a fresh socket keeps the connect ceiling until it connects, even after the body flushed', async () => {
  const { watchdog, emit, socket } = createObservedRequest();
  const fresh = socket({ connecting: true });
  emit('socket', fresh);
  emit('finish');
  await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS + 1);
  assertPhaseDetails(watchdog.signal.reason, 'connect', TRANSFER_CONNECT_TIMEOUT_MS);
});

test('the header wait starts only after both the flush and the connection', async () => {
  const { watchdog, emit, socket } = createObservedRequest();
  const fresh = socket({ connecting: true });
  emit('socket', fresh);
  emit('finish');
  await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS - 1_000);
  fresh.emit('connect');
  await vi.advanceTimersByTimeAsync(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS - 1);
  assert.equal(watchdog.signal.aborted, false);
  await vi.advanceTimersByTimeAsync(1);
  assertPhaseDetails(
    watchdog.signal.reason,
    'response-headers',
    TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  );
});

test('a TLS socket is established by secureConnect, not connect', async () => {
  const { watchdog, emit, socket } = createObservedRequest();
  const tls = socket({ connecting: true, encrypted: true });
  emit('socket', tls);
  tls.emit('connect');
  await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS + 1);
  assertPhaseDetails(watchdog.signal.reason, 'connect', TRANSFER_CONNECT_TIMEOUT_MS);
});

test('a pooled socket is already connected and times the body write as inactivity', async () => {
  const { fake, req, watchdog, emit, socket } = createObservedRequest();
  emit('socket', socket({ connecting: false }));
  req.write(Buffer.from('body'));
  await vi.advanceTimersByTimeAsync(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS - 1_000);
  fake.complete(0);
  await vi.advanceTimersByTimeAsync(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS - 1);
  assert.equal(watchdog.signal.aborted, false);
  await vi.advanceTimersByTimeAsync(1);
  assertPhaseDetails(watchdog.signal.reason, 'request-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
});

test('once the response started, later request events do not overwrite its phase', async () => {
  const { fake, req, watchdog, phases, emit, socket } = createObservedRequest();
  const fresh = socket({ connecting: true });
  emit('socket', fresh);
  req.write(Buffer.from('body'));
  emit('response');
  assert.equal(phases.responseStarted, true);
  fresh.emit('connect');
  emit('finish');
  await vi.advanceTimersByTimeAsync(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS - 1_000);
  // A request write that completes now says nothing about the response body.
  fake.complete(0);
  await vi.advanceTimersByTimeAsync(1_001);
  assertPhaseDetails(watchdog.signal.reason, 'response-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
});

test('disposing the phase observer removes only its own listeners', () => {
  const { fake, phases, stopObservingWrites, emit, socket } = createObservedRequest();
  const fresh = socket({ connecting: true });
  emit('socket', fresh);
  phases.dispose();
  assert.equal(fake.listenerCount('socket'), 0);
  assert.equal(fake.listenerCount('finish'), 0);
  assert.equal(fresh.listenerCount('connect'), 0);
  assert.equal(fake.listenerCount('response'), 1, "the write owner's listener is its own");
  stopObservingWrites();
  assert.equal(fake.listenerCount('response'), 0);
});

function assertPhaseDetails(reason: unknown, phase: string, timeoutMs: number): void {
  assert.ok(reason instanceof AppError, `phase expiry must be an AppError, got ${String(reason)}`);
  assert.equal(isTransferPhaseTimeoutError(reason), true);
  assert.deepEqual(reason.details, {
    reason: 'transfer_phase_timeout',
    transferPhase: phase,
    timeoutMs,
  });
}
