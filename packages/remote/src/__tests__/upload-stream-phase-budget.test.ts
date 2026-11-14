// The phase budget one artifact-transfer attempt runs under (#4441).
//
// Three ceilings govern one attempt — connecting, moving body bytes, waiting for headers — and each
// has to end a stalled attempt on its own while none of them touches the aggregate budget the
// attempt was admitted under. Those are behaviour claims about a clock, so the clock here is
// controlled rather than waited out. The loopback proofs in `upload-stream-phases.test.ts` put the
// same watchdog in front of real sockets.

import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  createTransferPhaseWatchdog,
  isTransferPhaseTimeoutError,
  TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  TRANSFER_CONNECT_TIMEOUT_MS,
  TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
} from '../upload-stream.ts';

afterEach(() => {
  vi.useRealTimers();
});

test('the three transfer ceilings are the adopted policy values', () => {
  assert.equal(TRANSFER_CONNECT_TIMEOUT_MS, 30_000);
  assert.equal(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS, 30_000);
  assert.equal(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS, 120_000);
});

test('a body phase restarts its ceiling on every byte that moves', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const watchdog = createTransferPhaseWatchdog();
  try {
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
    assertPhaseDetails(
      watchdog.signal.reason,
      'response-body',
      TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
    );
  } finally {
    watchdog.dispose();
  }
});

test('a phase that carries no bytes is not extended by progress reported in another phase', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const watchdog = createTransferPhaseWatchdog();
  try {
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
  } finally {
    watchdog.dispose();
  }
});

test('arming the next phase stops counting the previous one', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const watchdog = createTransferPhaseWatchdog();
  try {
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
  } finally {
    watchdog.dispose();
  }
});

test('an enclosing deadline wins and is never extended by a phase timer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const caller = new AbortController();
  const reason = new Error('preparation aggregate expired');
  setTimeout(() => caller.abort(reason), 5_000);
  const watchdog = createTransferPhaseWatchdog(caller.signal);
  try {
    watchdog.arm('response-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(5_001);
    // The caller's reason is the answer, not a phase's own evidence, so a consumer can still tell
    // "the work this upload served is gone" from "this transfer stalled".
    assert.equal(watchdog.signal.aborted, true);
    assert.equal(watchdog.signal.reason, reason);
    assert.equal(isTransferPhaseTimeoutError(watchdog.signal.reason), false);
  } finally {
    watchdog.dispose();
  }
});

test('a phase expiry is its own typed evidence and never caller cancellation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const caller = new AbortController();
  const watchdog = createTransferPhaseWatchdog(caller.signal);
  try {
    watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS + 1);
    assertPhaseDetails(watchdog.signal.reason, 'connect', TRANSFER_CONNECT_TIMEOUT_MS);
    // Distinctness the retry policy depends on: nobody canceled, so the caller's own signal stays
    // live and an enclosing aggregate is free to reach a different outcome.
    assert.equal(caller.signal.aborted, false);
  } finally {
    watchdog.dispose();
  }
});

test('a disposed watchdog stops watching', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const watchdog = createTransferPhaseWatchdog();
  watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
  watchdog.dispose();
  await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS * 3);
  assert.equal(watchdog.signal.aborted, false);
});

test('a phase is never armed after the attempt is already over', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const watchdog = createTransferPhaseWatchdog();
  try {
    watchdog.signal.throwIfAborted();
    const caller = new AbortController();
    caller.abort(new Error('gone'));
    const late = createTransferPhaseWatchdog(caller.signal);
    try {
      late.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS * 2);
      assert.equal(late.signal.reason.message, 'gone');
    } finally {
      late.dispose();
    }
  } finally {
    watchdog.dispose();
  }
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
