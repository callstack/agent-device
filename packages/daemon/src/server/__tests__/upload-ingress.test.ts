import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '@agent-device/kernel/errors';
import { beginUploadTransferIngress, resolveIngressFailure } from '../upload-ingress.ts';

const AGGREGATE_MS = 600_000;
const INACTIVITY_MS = 120_000;

function fakeReq(): PassThrough & IncomingMessage {
  return Object.assign(new PassThrough(), { headers: {} }) as PassThrough & IncomingMessage;
}

function fakeRes(): ServerResponse {
  const res = new EventEmitter() as ServerResponse & {
    writableFinished: boolean;
    destroyed: boolean;
  };
  res.writableFinished = false;
  res.destroyed = false;
  const headers = new Map<string, string>();
  Object.assign(res, {
    headersSent: false,
    statusCode: 200,
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
    removeHeader: (name: string) => headers.delete(name.toLowerCase()),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
    end: (body?: string) => {
      Object.assign(res, { headersSent: true, writableFinished: true, body });
      res.emit('finish');
    },
  });
  return res;
}

/** Resolves with the typed reason the ingress aborts its signal with on expiry. */
function abortReason(signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(signal.reason), { once: true }),
  );
}

test('a stalled upload body expires at the 120-second inactivity ceiling with a typed reason', async () => {
  vi.useFakeTimers();
  try {
    const req = fakeReq();
    const ingress = beginUploadTransferIngress({ req, res: fakeRes() });
    const failure = abortReason(ingress.signal);
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS);
    const error = (await failure) as AppError;
    assert.equal(ingress.signal.aborted, true);
    assert.equal(ingress.signal.aborted, true);
    assert.equal(error instanceof AppError, true);
    assert.equal(error.details?.reason, 'transfer_phase_timeout');
    assert.equal(error.details?.transferPhase, 'request-body');
    assert.equal(error.details?.timeoutMs, INACTIVITY_MS);
    ingress.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test('body progress renews inactivity but never the 600-second aggregate', async () => {
  vi.useFakeTimers();
  try {
    const req = fakeReq();
    const ingress = beginUploadTransferIngress({ req, res: fakeRes() });
    const failure = abortReason(ingress.signal);
    // Five progress windows of 119s stay under the inactivity ceiling and pass 595s
    // of the aggregate without renewing it.
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(INACTIVITY_MS - 1_000);
      ingress.onAcceptedBodyBytes(1);
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(ingress.signal.aborted, false);
    }
    await vi.advanceTimersByTimeAsync(AGGREGATE_MS - 5 * (INACTIVITY_MS - 1_000) + 1);
    const error = (await failure) as AppError;
    assert.equal(ingress.signal.aborted, true);
    assert.equal(error.details?.reason, 'transfer_ingress_deadline_exceeded');
    assert.equal(error.details?.timeoutMs, AGGREGATE_MS);
    ingress.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test('bodyComplete stops only the inactivity ceiling; post-body work observes the aggregate', async () => {
  vi.useFakeTimers();
  try {
    const req = fakeReq();
    const ingress = beginUploadTransferIngress({ req, res: fakeRes() });
    const failure = abortReason(ingress.signal);
    // The body completed: the inactivity ceiling must not fire for post-body work…
    ingress.bodyComplete();
    ingress.bodyComplete();
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS * 4);
    assert.equal(ingress.signal.aborted, false);
    assert.equal(ingress.signal.aborted, false);
    // …but the 600-second aggregate still bounds it.
    await vi.advanceTimersByTimeAsync(AGGREGATE_MS - INACTIVITY_MS * 4 + 1);
    const error = (await failure) as AppError;
    assert.equal(ingress.signal.aborted, true);
    assert.equal(error.details?.reason, 'transfer_ingress_deadline_exceeded');
    assert.equal(error.details?.timeoutMs, AGGREGATE_MS);
    ingress.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test('body bytes received after bodyComplete re-arm only the inactivity ceiling', async () => {
  vi.useFakeTimers();
  try {
    const req = fakeReq();
    const ingress = beginUploadTransferIngress({ req, res: fakeRes() });
    const failure = abortReason(ingress.signal);
    ingress.bodyComplete();
    await vi.advanceTimersByTimeAsync(AGGREGATE_MS - 1_000);
    // A late body byte renews inactivity only; the aggregate still fires on schedule.
    ingress.onAcceptedBodyBytes(1);
    await vi.advanceTimersByTimeAsync(1_001);
    const error = (await failure) as AppError;
    assert.equal(error.details?.reason, 'transfer_ingress_deadline_exceeded');
    ingress.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test('dispose stops both timers without aborting', async () => {
  vi.useFakeTimers();
  try {
    const req = fakeReq();
    const ingress = beginUploadTransferIngress({ req, res: fakeRes() });
    ingress.dispose();
    await vi.advanceTimersByTimeAsync(AGGREGATE_MS + INACTIVITY_MS);
    assert.equal(ingress.signal.aborted, false);
    assert.equal(ingress.signal.aborted, false);
  } finally {
    vi.useRealTimers();
  }
});

test('late progress after an overdue inactivity ceiling expires instead of renewing it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const realNow = performance.now.bind(performance);
  let skewMs = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skewMs);
  try {
    const req = fakeReq();
    const ingress = beginUploadTransferIngress({ req, res: fakeRes() });
    req.on('error', () => {});
    // The inactivity deadline has passed, but its timer callback has not run yet.
    skewMs = INACTIVITY_MS + 1;
    ingress.onAcceptedBodyBytes(1);
    assert.equal(ingress.signal.aborted, true, 'late progress does not renew an overdue ceiling');
    const reason = ingress.signal.reason as AppError;
    assert.equal(reason.details?.reason, 'transfer_phase_timeout');
    ingress.dispose();
  } finally {
    clock.mockRestore();
    vi.useRealTimers();
  }
});

test('body completion after an overdue inactivity ceiling expires instead of clearing it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const realNow = performance.now.bind(performance);
  let skewMs = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skewMs);
  try {
    const req = fakeReq();
    const ingress = beginUploadTransferIngress({ req, res: fakeRes() });
    req.on('error', () => {});
    // The body terminator arrives after the inactivity deadline, before its timer runs.
    skewMs = INACTIVITY_MS + 1;
    assert.throws(
      () => ingress.bodyComplete(),
      (error: unknown) => (error as AppError).details?.reason === 'transfer_phase_timeout',
    );
    assert.equal(ingress.signal.aborted, true, 'the overdue ceiling is not cleared');
    ingress.dispose();
  } finally {
    clock.mockRestore();
    vi.useRealTimers();
  }
});

test('a release after an overdue aggregate expires the request instead of clearing it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const realNow = performance.now.bind(performance);
  let skewMs = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skewMs);
  try {
    const res = fakeRes();
    const ingress = beginUploadTransferIngress({ req: fakeReq(), res });
    // The aggregate deadline passed, but its timer callback has not run yet.
    skewMs = AGGREGATE_MS + 1;
    ingress.dispose();
    assert.equal(ingress.signal.aborted, true, 'dispose does not clear an overdue deadline');
    assert.equal(
      (ingress.signal.reason as AppError).details?.reason,
      'transfer_ingress_deadline_exceeded',
    );
    assert.equal(res.statusCode, 500, 'the expiry answers with its typed error');
  } finally {
    clock.mockRestore();
    vi.useRealTimers();
  }
});

test('an answer before body completion carries Connection: close and bodyComplete clears it', () => {
  const res = fakeRes();
  const ingress = beginUploadTransferIngress({ req: fakeReq(), res });
  assert.equal(res.getHeader('connection'), 'close');
  ingress.bodyComplete();
  assert.equal(res.getHeader('connection'), undefined);
  ingress.dispose();
});

test('a client disconnect on an unfinished response aborts the transfer signal', async () => {
  const req = fakeReq();
  const res = fakeRes();
  const ingress = beginUploadTransferIngress({ req, res });
  res.emit('close');
  assert.equal(ingress.signal.aborted, true);
  ingress.dispose();
});

test('resolveIngressFailure lets the aborted signal own every unclassified failure, whatever its name', () => {
  const typed = new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
    reason: 'transfer_ingress_deadline_exceeded',
    transferPhase: 'request-body',
    timeoutMs: 600_000,
  });
  const controller = new AbortController();
  controller.abort(typed);
  const aborted = controller.signal;

  // The signal state decides, not the error's name or code: a Node AbortError, a
  // premature close, and an error with no abort marker all report the owner's reason.
  const genericAbort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
  assert.equal(resolveIngressFailure(aborted, genericAbort), typed);
  const prematureClose = Object.assign(new Error('Premature close'), {
    code: 'ERR_STREAM_PREMATURE_CLOSE',
  });
  assert.equal(resolveIngressFailure(aborted, prematureClose), typed);
  assert.equal(resolveIngressFailure(aborted, new Error('no abort marker')), typed);
  assert.equal(resolveIngressFailure(aborted, typed), typed);

  // An earlier classified failure is preserved even when the signal aborted afterwards.
  const classified = new AppError('COMMAND_FAILED', 'Upload expired while receiving data', {
    reason: 'RESOURCE_EXPIRED',
  });
  assert.equal(resolveIngressFailure(aborted, classified), classified);

  // Without an abort, the pipeline error passes through unchanged, even an AbortError.
  const plain = new AbortController().signal;
  assert.equal(resolveIngressFailure(plain, genericAbort), genericAbort);
  assert.equal(resolveIngressFailure(undefined, genericAbort), genericAbort);
});
