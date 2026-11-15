import { afterEach, assert, test, vi } from 'vitest';
import { isTransferPhaseTimeoutError } from '@agent-device/host-kit/transport';
import { isRetryableUploadStreamError } from '../upload-stream.ts';
import {
  LEGACY_UPLOAD_REQUEST,
  TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  TRANSFER_CONNECT_TIMEOUT_MS,
  TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  type ParkedUploadDaemon,
  assertDetailedError,
  awaitBodyProgress,
  createArtifactFile,
  holdArtifactSourceOpen,
  recordOutgoingWrites,
  settleAfterBudget,
  spendBudget,
  spendSinceLastWrite,
  startAnswerUploadDaemon,
  startSilentTcpOrigin,
  startConnectedStalledTlsOrigin,
  startHalfAnsweredOrigin,
  startParkedUploadDaemon,
  startSlowReadingUploadDaemon,
  startUploadAttempt,
  startUploadLegsDaemon,
  trustSelfSignedLocalhostCertificate,
  untilIo,
  useTransferClock,
} from './support/upload-transfer-fixtures.ts';

const MEBIBYTE = 1024 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('an early 413 from a peer that stops reading is consumed and its owned work is ended', async () => {
  useTransferClock();
  const daemon = await startAnswerUploadDaemon({
    respond: () => ({ status: 413, body: 'payload too large' }),
  });
  const writes = recordOutgoingWrites();
  const { source } = holdArtifactSourceOpen(MEBIBYTE);
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(4 * MEBIBYTE),
  });
  const atSettle = attempt.then(() => ({ destroyed: source.destroyed, finished: writes.finished }));
  await settleAfterBudget(attempt);
  assert.deepEqual(await atSettle, { destroyed: true, finished: false });
  const result = await attempt;
  assert.equal(result.error, undefined, `got ${String(result.error)}`);
  assert.equal(result.value?.statusCode, 413);
  assert.equal(result.value?.body, 'payload too large');
  assert.deepEqual(daemon.requests, [LEGACY_UPLOAD_REQUEST]);
});

test('a resume response ends the stalled hop before the next attempt is dialed', async () => {
  useTransferClock();
  const resumeOffset = MEBIBYTE;
  const daemon = await startAnswerUploadDaemon({
    respond: () => ({
      status: 308,
      headers: { 'x-upload-offset': String(resumeOffset) },
      body: '',
    }),
  });
  const held = holdArtifactSourceOpen(MEBIBYTE);
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(4 * MEBIBYTE),
  });
  await settleAfterBudget(attempt);
  const result = await attempt;
  assertDetailedError(result.error, { offset: resumeOffset, previousOffset: resumeOffset });
  assert.equal(daemon.requests.filter((entry) => entry === LEGACY_UPLOAD_REQUEST).length, 2);
  assert.equal(held.destroyedAtNextOpen, true, 'hop one was ended before hop two opened');
});

test('a resumed hop that makes real progress past the first hop ceiling keeps its own retryable reset', async () => {
  useTransferClock();
  const progressWindowMs = 30_000;
  assert.ok(progressWindowMs < TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
  const artifactBytes = 32 * MEBIBYTE;
  const writes = recordOutgoingWrites();
  const daemon = await startParkedUploadDaemon({
    answerFirstLeg: { status: 308, headers: { 'x-upload-offset': String(MEBIBYTE) } },
  });
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(artifactBytes),
    method: 'POST',
    retryable: true,
  });
  await untilIo(() => hopTwoTookBytes(daemon) || attempt.settled);
  assert.ok(hopTwoTookBytes(daemon), 'the resumed hop was dialed and took bytes');
  for (let window = 0; window < 6; window += 1) {
    const before = { bytes: daemon.receivedBytes, completed: writes.completed };
    const progressed = await awaitBodyProgress(daemon, writes, before, attempt);
    assert.equal(progressed, true, `window ${window}`);
    await vi.advanceTimersByTimeAsync(progressWindowMs);
    assert.equal(attempt.settled, false);
    assert.equal(daemon.bodyEnded, false);
  }
  assert.ok(6 * progressWindowMs > TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
  daemon.resetParkedLeg();
  await settleAfterBudget(attempt);
  const result = await attempt;
  assert.equal(result.value, undefined);
  assert.equal(isTransferPhaseTimeoutError(result.error), false, JSON.stringify(result.error));
  assert.equal(isRetryableUploadStreamError(result.error), true);
  assert.equal(daemon.requests.filter((entry) => entry === LEGACY_UPLOAD_REQUEST).length, 2);
});

function hopTwoTookBytes(daemon: ParkedUploadDaemon): boolean {
  return (
    daemon.requests.filter((entry) => entry === LEGACY_UPLOAD_REQUEST).length === 2 &&
    daemon.receivedBytes > 0
  );
}

test('a redirect response ends the stalled hop before the next hop is dialed', async () => {
  useTransferClock();
  const daemon = await startAnswerUploadDaemon({
    respond: (req) =>
      req.url === '/moved'
        ? { status: 413, body: 'moved and refused' }
        : { status: 307, headers: { location: '/moved' }, body: '' },
  });
  const held = holdArtifactSourceOpen(MEBIBYTE);
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(4 * MEBIBYTE),
  });
  await settleAfterBudget(attempt);
  const result = await attempt;
  assert.equal(result.error, undefined, `got ${String(result.error)}`);
  assert.equal(result.value?.statusCode, 413);
  assert.equal(result.value?.body, 'moved and refused');
  assert.deepEqual(daemon.requests, ['POST /upload', 'POST /moved']);
  assert.equal(held.destroyedAtNextOpen, true, 'the redirected-from hop ended before the next');
});

test('a response body that stops mid-answer expires the response-body phase after what was read', async () => {
  useTransferClock();
  const writes = recordOutgoingWrites();
  const origin = await startHalfAnsweredOrigin({ firstChunk: 'first chunk' });
  const attempt = startUploadAttempt({
    url: `${origin.baseUrl}/upload`,
    artifactPath: createArtifactFile(64),
  });
  await untilIo(() => attempt.settled || writes.responseChunkRead);
  assert.equal(writes.responseChunkRead, true);
  await spendBudget(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 5_000, attempt);
  await settleAfterBudget(attempt);
  const result = await attempt;
  assert.equal(result.value, undefined);
  assertDetailedError(result.error, {
    reason: 'transfer_phase_timeout',
    transferPhase: 'response-body',
    timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  });
});

test('a connected HTTP upload with an unfinished source expires body inactivity, not connect', async () => {
  useTransferClock();
  const writes = recordOutgoingWrites();
  const origin = await startSilentTcpOrigin();
  holdArtifactSourceOpen(1024);
  const attempt = startUploadAttempt({
    url: `http://127.0.0.1:${origin.port}/upload`,
    artifactPath: createArtifactFile(8 * 1024),
  });
  await spendSinceLastWrite(TRANSFER_CONNECT_TIMEOUT_MS + 1_000, writes, attempt);
  assert.equal(attempt.settled, false);
  await spendSinceLastWrite(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 5_000, writes, attempt);
  assert.equal(writes.finished, false, 'the source still holds the body open');
  await settleAfterBudget(attempt);
  const result = await attempt;
  assert.equal(result.value, undefined);
  assertDetailedError(result.error, {
    reason: 'transfer_phase_timeout',
    transferPhase: 'request-body',
    timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  });
});

test('a TLS handshake that never completes expires connect even with the whole body buffered', async () => {
  useTransferClock();
  const origin = await startSilentTcpOrigin();
  const attempt = startUploadAttempt({
    url: `https://127.0.0.1:${origin.port}/upload`,
    artifactPath: createArtifactFile(4 * MEBIBYTE),
  });
  await spendBudget(TRANSFER_CONNECT_TIMEOUT_MS + 5_000, attempt);
  await settleAfterBudget(attempt);
  const result = await attempt;
  assert.equal(result.value, undefined);
  assertDetailedError(result.error, {
    reason: 'transfer_phase_timeout',
    transferPhase: 'connect',
    timeoutMs: TRANSFER_CONNECT_TIMEOUT_MS,
  });
});

test('a completed TLS handshake with an unfinished source expires body inactivity, not connect', async () => {
  useTransferClock();
  trustSelfSignedLocalhostCertificate();
  const origin = await startConnectedStalledTlsOrigin();
  const writes = recordOutgoingWrites();
  holdArtifactSourceOpen(1024);
  const attempt = startUploadAttempt({
    url: `https://127.0.0.1:${origin.port}/upload`,
    artifactPath: createArtifactFile(8 * 1024),
  });
  await spendSinceLastWrite(TRANSFER_CONNECT_TIMEOUT_MS + 1_000, writes, attempt);
  assert.equal(attempt.settled, false, 'secureConnect ended the connect phase');
  await spendSinceLastWrite(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 5_000, writes, attempt);
  assert.equal(writes.finished, false, 'the source still holds the body open');
  await settleAfterBudget(attempt);
  const result = await attempt;
  assert.equal(result.value, undefined);
  assertDetailedError(result.error, {
    reason: 'transfer_phase_timeout',
    transferPhase: 'request-body',
    timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  });
});

test('a zero-length artifact on a peer that never answers waits on its header budget', async () => {
  useTransferClock();
  const writes = recordOutgoingWrites();
  const origin = await startSilentTcpOrigin();
  const attempt = startUploadAttempt({
    url: `http://127.0.0.1:${origin.port}/upload`,
    artifactPath: createArtifactFile(0),
  });
  const snapshot = () => ({ writes, settled: attempt.settled });
  await untilIo(() => attempt.settled || writes.finished, 'empty artifact flush', snapshot);
  assert.equal(writes.finished, true);
  await spendBudget(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS - 5_000, attempt);
  assert.equal(attempt.settled, false);
  await spendBudget(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS + 5_000, attempt);
  await settleAfterBudget(attempt, snapshot);
  const result = await attempt;
  assert.equal(result.value, undefined);
  assertDetailedError(result.error, {
    reason: 'transfer_phase_timeout',
    transferPhase: 'response-headers',
    timeoutMs: TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  });
  assert.equal(writes.completed, 0);
});

test('an upload the peer keeps taking finishes while every phase ceiling is unexpired', async () => {
  useTransferClock();
  const writes = recordOutgoingWrites();
  const daemon = await startSlowReadingUploadDaemon({
    status: 200,
    body: JSON.stringify({ ok: true, uploadId: 'joined-upload' }),
  });
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(MEBIBYTE),
  });
  let spent = 0;
  while (
    !attempt.settled &&
    spent < TRANSFER_CONNECT_TIMEOUT_MS + TRANSFER_RESPONSE_HEADER_TIMEOUT_MS
  ) {
    const bytesBefore = daemon.receivedBytes;
    daemon.releaseAllParked();
    if (!writes.finished) {
      await vi.advanceTimersByTimeAsync(1_000);
      spent += 1_000;
    }
    await untilIo(
      () => attempt.settled || daemon.receivedBytes > bytesBefore,
      'slow upload next chunk',
      () => ({ writes, receivedBytes: daemon.receivedBytes, settled: attempt.settled }),
    );
  }
  const result = await attempt;
  assert.equal(result.error, undefined, `upload failed: ${String(result.error)}`);
  assert.equal(result.value?.statusCode, 200);
  assert.ok(
    spent < TRANSFER_CONNECT_TIMEOUT_MS + TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
    `finished in ${spent}ms of budget, inside both ceilings a progressing upload must not exceed`,
  );
  assert.equal(daemon.bodyEnded, true);
  assert.equal(daemon.receivedBytes, MEBIBYTE);
}, 30_000);

test('a caller cancel during a stalled connect stays caller cancellation, distinct from the connect expiry', async () => {
  useTransferClock();
  const control = new AbortController();
  const origin = await startSilentTcpOrigin();
  const canceled = startUploadAttempt({
    url: `https://127.0.0.1:${origin.port}/upload`,
    artifactPath: createArtifactFile(64 * 1024),
    signal: control.signal,
  });
  await spendBudget(5_000, canceled);
  control.abort();
  const result = await canceled;
  assert.equal(result.value, undefined);
  assert.ok(result.error instanceof DOMException, `got ${String(result.error)}`);
  assert.equal((result.error as DOMException).name, 'AbortError');
  assert.equal(control.signal.aborted, true);
});

test('an enclosing aggregate deadline ends a redirect hop with its own reason, not a phase timeout', async () => {
  useTransferClock();
  const aggregate = new AbortController();
  const daemon = await startUploadLegsDaemon([
    {
      readAllBody: false,
      respond: () => ({ status: 307, headers: { location: '/moved' }, body: '' }),
    },
    { readAllBody: true },
  ]);
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(64 * 1024),
    signal: aggregate.signal,
  });
  await untilIo(() => attempt.settled || daemon.requests.includes('POST /moved'));
  assert.deepEqual(daemon.requests, ['POST /upload', 'POST /moved']);
  assert.equal(attempt.settled, false);
  const reason = new Error('preparation aggregate expired');
  aggregate.abort(reason);
  await settleAfterBudget(attempt);
  const result = await attempt;
  assert.equal(result.value, undefined);
  assert.equal(result.error, reason);
  assert.equal(isTransferPhaseTimeoutError(result.error), false);
});

test('an attempt on a reused connection is already past its connect phase', async () => {
  useTransferClock();
  const writes = recordOutgoingWrites();
  const daemon = await startUploadLegsDaemon([
    {
      readAllBody: true,
      respond: () => ({ status: 200, body: JSON.stringify({ ok: true, uploadId: 'pooled' }) }),
    },
    { readAllBody: true },
  ]);
  const first = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(64 * 1024),
  });
  const firstResult = await first;
  assert.equal(firstResult.error, undefined, `leg one failed: ${String(firstResult.error)}`);
  const second = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(64 * 1024),
  });
  const snapshot = () => ({ writes, requests: daemon.requests, settled: second.settled });
  await untilIo(
    () => (daemon.requests.length === 2 && writes.finished) || second.settled,
    'reused request flush',
    snapshot,
  );
  await spendBudget(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS + 5_000, second);
  await settleAfterBudget(second, snapshot);
  const result = await second;
  assert.equal(result.value, undefined);
  assertDetailedError(result.error, {
    reason: 'transfer_phase_timeout',
    transferPhase: 'response-headers',
    timeoutMs: TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
  });
  assert.equal(daemon.connections, 1, 'the second attempt reused the pooled socket');
});
