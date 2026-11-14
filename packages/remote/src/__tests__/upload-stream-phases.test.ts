// Phase budgets on a real loopback upload (#4441): a transfer that keeps moving survives budget after
// budget, and one that stops is ended by the one budget that ran out.

import { afterEach, assert, test, vi } from 'vitest';
import {
  LEGACY_UPLOAD_REQUEST,
  TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  TRANSFER_CONNECT_TIMEOUT_MS,
  TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  PREFLIGHT_REQUEST,
  assertDetailedError,
  awaitBodyProgress,
  createArtifactFile,
  holdArtifactSourceOpen,
  pumpRealWork,
  recordOutgoingWrites,
  settleAfterBudget,
  spendBudget,
  spendProgressWindows,
  spendSinceLastWrite,
  startParkedUploadDaemon,
  startUpload,
  startUploadAttempt,
  untilIo,
  useTransferClock,
} from './support/upload-transfer-fixtures.ts';

const MEBIBYTE = 1024 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('a body that keeps moving outlives the body-inactivity ceiling', async () => {
  useTransferClock();
  const writes = recordOutgoingWrites();
  const daemon = await startParkedUploadDaemon();
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    artifactPath: createArtifactFile(16 * MEBIBYTE),
  });
  try {
    const progress = await spendProgressWindows(daemon, upload, {
      windows: 8,
      windowMs: TRANSFER_CONNECT_TIMEOUT_MS,
      writes,
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
  const writes = recordOutgoingWrites();
  const daemon = await startParkedUploadDaemon();
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    artifactPath: createArtifactFile(2 * MEBIBYTE),
  });
  try {
    // The peer stops reading without answering or disconnecting.
    await spendSinceLastWrite(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 5_000, writes, upload);
    assert.equal(writes.finished, false, 'the stalled body was still queued at the client');
    assert.equal(await settleAfterBudget(upload), true);
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
  const writes = recordOutgoingWrites();
  const daemon = await startParkedUploadDaemon();
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    artifactPath: createArtifactFile(16 * MEBIBYTE),
  });
  try {
    const progress = await spendProgressWindows(daemon, upload, {
      windows: 5,
      windowMs: TRANSFER_CONNECT_TIMEOUT_MS,
      writes,
    });
    assert.equal(progress.progressedInEveryWindow, true);
    assert.ok(progress.budgetMs > 4 * TRANSFER_CONNECT_TIMEOUT_MS, `${progress.budgetMs}ms`);
    assert.equal(writes.finished, false, 'the body was still being written');
    assert.equal(daemon.bodyEnded, false);
    assert.equal(upload.settled, false);

    // The peer takes the rest with no fake time passing; `finish` starts the only wait that expires.
    daemon.readToEnd();
    await untilIo(() => (writes.finished && daemon.bodyEnded) || upload.settled);
    assert.equal(writes.finished && daemon.bodyEnded, true, 'the whole body reached the peer');
    await vi.advanceTimersByTimeAsync(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS - 1);
    await pumpRealWork();
    assert.equal(upload.settled, false, 'the header wait counts from the flush');
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(await settleAfterBudget(upload), true);
    const result = await upload;

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

test('writes below the high-water mark keep the body budget on each completed write', async () => {
  useTransferClock();
  // 1 KiB writes return true and never `drain`: only their completion reports kernel progress.
  const { source } = holdArtifactSourceOpen();
  const writes = recordOutgoingWrites();
  const daemon = await startParkedUploadDaemon();
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(64 * 1024),
  });
  try {
    for (let window = 0; window < 6; window += 1) {
      const before = { bytes: daemon.receivedBytes, completed: writes.completed };
      source.write(Buffer.alloc(1024, 'x'));
      const progressed = await awaitBodyProgress(daemon, writes, before, attempt);
      assert.equal(progressed, true, `window ${window}`);
      await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS);
      assert.equal(attempt.settled, false, `window ${window}`);
    }
    assert.ok(6 * TRANSFER_CONNECT_TIMEOUT_MS > TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
    assert.equal(writes.drains, 0);
    assert.equal(writes.falseReturns, 0);

    // The producer stops; the budget expires one ceiling after the last completed write.
    await vi.advanceTimersByTimeAsync(
      TRANSFER_BODY_INACTIVITY_TIMEOUT_MS - TRANSFER_CONNECT_TIMEOUT_MS - 1,
    );
    await pumpRealWork();
    assert.equal(attempt.settled, false);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(await settleAfterBudget(attempt), true);
    assertDetailedError((await attempt).error, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'request-body',
      timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
    });
  } finally {
    source.destroy();
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
