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
});

test('an unfinished source with no new bytes expires the request-body phase on its own budget', async () => {
  useTransferClock();
  const writes = recordOutgoingWrites();
  const daemon = await startParkedUploadDaemon();
  holdArtifactSourceOpen(1024);
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    artifactPath: createArtifactFile(8 * 1024),
  });
  await spendSinceLastWrite(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 5_000, writes, upload);
  assert.equal(writes.finished, false, 'the source still holds the body open');
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
});

test('a body admitted past four connect ceilings still waits only its own header budget', async () => {
  useTransferClock();
  const writes = recordOutgoingWrites();
  const daemon = await startParkedUploadDaemon();
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    artifactPath: createArtifactFile(16 * MEBIBYTE),
  });
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
  daemon.readToEnd();
  const snapshot = () => ({
    writes,
    bodyEnded: daemon.bodyEnded,
    receivedBytes: daemon.receivedBytes,
    requests: daemon.requests,
    settled: upload.settled,
  });
  await untilIo(
    () => (writes.finished && daemon.bodyEnded) || upload.settled,
    'header proof flush',
    snapshot,
  );
  assert.equal(writes.finished && daemon.bodyEnded, true, 'the whole body reached the peer');
  await vi.advanceTimersByTimeAsync(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS - 1);
  await pumpRealWork();
  assert.equal(upload.settled, false, 'the header wait counts from the flush');
  await vi.advanceTimersByTimeAsync(1);
  await settleAfterBudget(upload, snapshot);
  const result = await upload;
  assert.equal(result.value, undefined);
  assertDetailedError(result.error, {
    reason: 'transfer_phase_timeout',
    transferPhase: 'response-headers',
    timeoutMs: TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  });
});

test('writes below the high-water mark keep the body budget on each completed write', async () => {
  useTransferClock();
  const { source } = holdArtifactSourceOpen();
  const writes = recordOutgoingWrites();
  const daemon = await startParkedUploadDaemon();
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(64 * 1024),
  });
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
  await vi.advanceTimersByTimeAsync(
    TRANSFER_BODY_INACTIVITY_TIMEOUT_MS - TRANSFER_CONNECT_TIMEOUT_MS - 1,
  );
  await pumpRealWork();
  assert.equal(attempt.settled, false);
  await vi.advanceTimersByTimeAsync(1);
  await settleAfterBudget(attempt);
  assertDetailedError((await attempt).error, {
    reason: 'transfer_phase_timeout',
    transferPhase: 'request-body',
    timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  });
});

test('the caller ending the upload is reported as cancellation, not as an expired phase', async () => {
  useTransferClock();
  const writes = recordOutgoingWrites();
  const daemon = await startParkedUploadDaemon();
  const control = new AbortController();
  const upload = startUpload({
    baseUrl: daemon.baseUrl,
    artifactPath: createArtifactFile(8 * MEBIBYTE),
    signal: control.signal,
  });
  await untilIo(() => upload.settled || (writes.completed > 0 && daemon.receivedBytes > 0));
  assert.equal(upload.settled, false);
  assert.ok(writes.completed > 0 && daemon.receivedBytes > 0);
  await spendBudget(5_000, upload);
  control.abort();
  const result = await upload;
  assert.equal(result.value, undefined);
  assert.ok(result.error instanceof DOMException, `got ${String(result.error)}`);
  assert.equal((result.error as DOMException).name, 'AbortError');
});
