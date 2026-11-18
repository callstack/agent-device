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
  return res;
}

function reqError(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => req.once('error', resolve));
}

test('a stalled upload body expires at the 120-second inactivity ceiling with a typed reason', async () => {
  vi.useFakeTimers();
  try {
    const req = fakeReq();
    const ingress = beginUploadTransferIngress({ req, res: fakeRes() });
    const failure = reqError(req);
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS);
    const error = (await failure) as AppError;
    assert.equal(req.destroyed, true);
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
    const failure = reqError(req);
    // Five progress windows of 119s stay under the inactivity ceiling and pass 595s
    // of the aggregate without renewing it.
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(INACTIVITY_MS - 1_000);
      ingress.onAcceptedBodyBytes(1);
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(req.destroyed, false);
    }
    await vi.advanceTimersByTimeAsync(AGGREGATE_MS - 5 * (INACTIVITY_MS - 1_000) + 1);
    const error = (await failure) as AppError;
    assert.equal(req.destroyed, true);
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
    const failure = reqError(req);
    // The body completed: the inactivity ceiling must not fire for post-body work…
    ingress.bodyComplete();
    ingress.bodyComplete();
    await vi.advanceTimersByTimeAsync(INACTIVITY_MS * 4);
    assert.equal(req.destroyed, false);
    assert.equal(ingress.signal.aborted, false);
    // …but the 600-second aggregate still bounds it.
    await vi.advanceTimersByTimeAsync(AGGREGATE_MS - INACTIVITY_MS * 4 + 1);
    const error = (await failure) as AppError;
    assert.equal(req.destroyed, true);
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
    const failure = reqError(req);
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
    assert.equal(req.destroyed, false);
    assert.equal(ingress.signal.aborted, false);
  } finally {
    vi.useRealTimers();
  }
});

test('a client disconnect on an unfinished response aborts the transfer signal', async () => {
  const req = fakeReq();
  const res = fakeRes();
  const ingress = beginUploadTransferIngress({ req, res });
  res.emit('close');
  assert.equal(ingress.signal.aborted, true);
  ingress.dispose();
});

test('resolveIngressFailure maps an abort-owned generic failure to the typed reason only', () => {
  const typed = new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
    reason: 'transfer_ingress_deadline_exceeded',
    transferPhase: 'request-body',
    timeoutMs: 600_000,
  });
  const controller = new AbortController();
  controller.abort(typed);
  const aborted = controller.signal;

  // Node's pipeline rejects an aborted signal with a generic AbortError; the owner's
  // typed reason is restored.
  const genericAbort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
  assert.equal(resolveIngressFailure(aborted, genericAbort), typed);
  const codedAbort = Object.assign(new Error('Different diagnostic'), { code: 'ABORT_ERR' });
  assert.equal(resolveIngressFailure(aborted, codedAbort), typed);
  const unrelated = new Error(genericAbort.message);
  assert.equal(resolveIngressFailure(aborted, unrelated), unrelated);
  assert.equal(resolveIngressFailure(aborted, typed), typed);

  // An earlier classified failure is preserved even when the signal aborted afterwards.
  const classified = new AppError('COMMAND_FAILED', 'Upload expired while receiving data', {
    reason: 'RESOURCE_EXPIRED',
  });
  assert.equal(resolveIngressFailure(aborted, classified), classified);

  // Without an abort, the pipeline error passes through unchanged.
  const plain = new AbortController().signal;
  assert.equal(resolveIngressFailure(plain, classified), classified);
  assert.equal(resolveIngressFailure(undefined, genericAbort), genericAbort);
});
