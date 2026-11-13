// Phase budgets applied to a real artifact upload over loopback (#4441).
//
// The budgets in `transfer-phase-budget.ts` are minutes long, so every case here drives a controlled
// clock and parks the request body chunk by chunk. That combination is the point: a transfer that
// keeps moving must survive budget after budget, and one that stops moving must be ended by the ONE
// budget that ran out. A mocked transport could show neither, because the backpressure that makes
// "still progressing" mean something belongs to the real socket.

import { afterEach, assert, test, vi } from 'vitest';
import {
  TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  TRANSFER_CONNECT_TIMEOUT_MS,
  TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
} from '../transfer-phase-budget.ts';
import {
  LEGACY_UPLOAD_REQUEST,
  PREFLIGHT_REQUEST,
  assertDetailedError,
  createArtifactFile,
  settleAfterBudget,
  spendBudget,
  spendProgressWindows,
  startParkedUploadDaemon,
  startUpload,
  useTransferClock,
} from './support/upload-transfer-fixtures.ts';

const MEBIBYTE = 1024 * 1024;

afterEach(() => {
  vi.useRealTimers();
});

test('a body that keeps moving outlives the body-inactivity ceiling', async () => {
  useTransferClock();
  const daemon = await startParkedUploadDaemon();
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    // Sixteen megabytes is far past what loopback buffers absorb, so the windows below are paid for
    // by bytes the peer really takes rather than by a socket that swallowed the whole file.
    artifactPath: createArtifactFile(16 * MEBIBYTE),
  });
  try {
    const progress = await spendProgressWindows(daemon, upload, {
      windows: 400,
      windowMs: 1_000,
    });

    assert.equal(progress.progressedInEveryWindow, true);
    assert.ok(
      progress.budgetMs > TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
      `the transfer stayed alive past the body-inactivity ceiling, at ${progress.budgetMs}ms of budget`,
    );
    assert.deepEqual(daemon.requests, [PREFLIGHT_REQUEST, LEGACY_UPLOAD_REQUEST]);
  } finally {
    await daemon.close();
  }
});

test('a body the peer stops taking expires the request-body phase on its own budget', async () => {
  useTransferClock();
  const daemon = await startParkedUploadDaemon();
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    artifactPath: createArtifactFile(2 * MEBIBYTE),
  });
  try {
    // Bytes are in flight and then the peer stops reading them, without answering or disconnecting.
    // Nothing but the inactivity budget may end this.
    await spendBudget(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 5_000, upload);
    await settleAfterBudget(upload);
    const result = await upload;

    assert.equal(result.value, undefined);
    assertDetailedError(result.error, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'request-body',
      timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
    });
    assert.deepEqual(daemon.requests, [PREFLIGHT_REQUEST, LEGACY_UPLOAD_REQUEST]);
    assert.ok(daemon.receivedBytes > 0, 'the attempt had a body in flight to stall');
  } finally {
    await daemon.close();
  }
});

test('a body admitted past four connect ceilings still waits only its own header budget', async () => {
  useTransferClock();
  const daemon = await startParkedUploadDaemon();
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    artifactPath: createArtifactFile(8 * 1024),
  });
  try {
    // The first byte is written before any budget is spent, so the connect ceiling has already given
    // way to the body phase: the body can cost more than four connect ceilings, and the wait that
    // then expires is the header wait the withheld answer deserves.
    const progress = await spendProgressWindows(daemon, upload, {
      windows: 5,
      windowMs: TRANSFER_CONNECT_TIMEOUT_MS,
    });
    await spendBudget(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS + 5_000, upload);
    await settleAfterBudget(upload);
    const result = await upload;

    assert.equal(progress.progressedInEveryWindow, true);
    assert.equal(result.value, undefined);
    assertDetailedError(result.error, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'response-headers',
      timeoutMs: TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
    });
  } finally {
    await daemon.close();
  }
});

test('the caller ending the upload is reported as cancellation, not as an expired phase', async () => {
  useTransferClock();
  const daemon = await startParkedUploadDaemon();
  const control = new AbortController();
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    artifactPath: createArtifactFile(8 * MEBIBYTE),
    signal: control.signal,
  });
  try {
    // Well inside every phase budget: only the caller can be the reason this stops.
    await spendBudget(30_000, upload);
    control.abort();
    const result = await upload;

    assert.equal(result.value, undefined);
    assert.ok(result.error instanceof DOMException, `got ${String(result.error)}`);
    assert.equal((result.error as DOMException).name, 'AbortError');
  } finally {
    await daemon.close();
  }
});
