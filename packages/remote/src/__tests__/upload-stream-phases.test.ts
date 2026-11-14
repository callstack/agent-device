// Phase budgets applied to a real artifact upload over loopback (#4441).
//
// The 30–120-second phase budgets use a controlled clock here. Each case parks the request
// body a quota at a time. That combination is the point: a transfer that
// keeps moving must survive budget after budget, and one that stops moving must be ended by the ONE
// budget that ran out. A mocked transport could show neither, because the backpressure that makes
// "still progressing" mean something belongs to the real socket.

import fs from 'node:fs';
import { PassThrough } from 'node:stream';
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
  pumpRealWork,
  recordOutgoingWrites,
  settleAfterBudget,
  settleAttemptAfterBudget,
  spendBudget,
  spendProgressWindows,
  startParkedUploadDaemon,
  startUpload,
  startUploadAttempt,
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
    // Sixteen megabytes is far past what a handful of windows can drain, so every window below is
    // paid for by bytes the peer really takes rather than by a socket that swallowed the file.
    artifactPath: createArtifactFile(16 * MEBIBYTE),
  });
  try {
    // Eight ceilings' worth of budget, one release-and-wait per window. Each window is paid for only
    // after the peer really took bytes, so this stays cheap in real time while still spending twice
    // the inactivity ceiling the transfer has to outlive.
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
  const writes = recordOutgoingWrites();
  const daemon = await startParkedUploadDaemon();
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    // Sixteen megabytes outlasts five release windows: the body is still in flight past four ceilings.
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
    for (let round = 0; round < 400 && !(writes.finished && daemon.bodyEnded); round += 1) {
      await pumpRealWork(15);
    }
    assert.equal(writes.finished && daemon.bodyEnded, true, 'the whole body reached the peer');
    await vi.advanceTimersByTimeAsync(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS - 1);
    await pumpRealWork();
    assert.equal(upload.settled, false, 'the header wait counts from the flush');
    await vi.advanceTimersByTimeAsync(1);
    await settleAfterBudget(upload);
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
  // A slow producer hands the request 1 KiB at a time. Each write fits under the socket's high-water
  // mark, so it returns true and no `drain` ever fires: the write's completion is the only report
  // that its bytes reached the local kernel.
  const source = new PassThrough();
  vi.spyOn(fs, 'createReadStream').mockReturnValueOnce(source as unknown as fs.ReadStream);
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
      assert.equal(await awaitBodyProgress(daemon, writes, before), true, `window ${window}`);
      await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS);
      assert.equal(attempt.settled, false, `window ${window}`);
    }
    assert.ok(6 * TRANSFER_CONNECT_TIMEOUT_MS > TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
    assert.equal(writes.drains, 0);
    assert.equal(writes.falseReturns, 0);

    // The producer stops. The last completed write was one window ago, so the body budget expires
    // exactly one inactivity ceiling after it.
    await vi.advanceTimersByTimeAsync(
      TRANSFER_BODY_INACTIVITY_TIMEOUT_MS - TRANSFER_CONNECT_TIMEOUT_MS - 1,
    );
    await pumpRealWork();
    assert.equal(attempt.settled, false);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal((await settleAttemptAfterBudget(attempt)).settled, true);
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
