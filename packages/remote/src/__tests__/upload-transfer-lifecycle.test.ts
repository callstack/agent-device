// The transport lifecycle of one upload attempt while the peer misbehaves (#4441 review).
//
// A response can arrive before the outgoing body has finished: an early 413, a redirect or an offset
// resume from a peer that then stops reading. The accepted answer is a real outcome, so it must be
// read to its end; the owned file and request still pushing at the dead hop must be destroyed and
// JOINED before the attempt resolves or the next hop is dialed — no old bytes may overlap a new
// attempt. The budget story has to say what the socket says: the connect ceiling ends when the
// transport is actually carried (TCP `connect`, TLS `secureConnect`, or a pooled socket that is
// already connected), and buffered bytes never count as transport progress.
//
// Every case uses the attempt seam, a controlled clock, and real loopback sockets: the overlap being
// refused is only observable on a real socket, and the budgets are minutes long.

import http from 'node:http';
import { afterEach, assert, test, vi } from 'vitest';
import { isRetryableUploadStreamError } from '../upload-stream.ts';
import {
  isTransferPhaseTimeoutError,
  TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  TRANSFER_CONNECT_TIMEOUT_MS,
  TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
} from '../transfer-phase-budget.ts';
import {
  LEGACY_UPLOAD_REQUEST,
  type ParkedUploadDaemon,
  assertDetailedError,
  createArtifactFile,
  pumpRealWork,
  settleAttemptAfterBudget,
  spendAttemptBudget,
  startAnswerUploadDaemon,
  startConnectedStalledHttpOrigin,
  startConnectedStalledTlsOrigin,
  startHalfAnsweredOrigin,
  startParkedUploadDaemon,
  startSlowReadingUploadDaemon,
  startUnfinishedHandshakeTlsOrigin,
  startUploadAttempt,
  startUploadLegsDaemon,
  trustSelfSignedLocalhostCertificate,
  useTransferClock,
} from './support/upload-transfer-fixtures.ts';

const MEBIBYTE = 1024 * 1024;

afterEach(() => {
  vi.useRealTimers();
});

test('an early 413 from a peer that stops reading is consumed and its owned work is ended', async () => {
  useTransferClock();
  const daemon = await startAnswerUploadDaemon({
    respond: () => ({ status: 413, body: 'payload too large' }),
  });
  const artifactBytes = 4 * MEBIBYTE;
  // Well past what loopback buffers absorb: megabytes of owned file remain queued behind the
  // peer's pause when the answer lands, which is the owned work this test expects to be ended.
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(artifactBytes),
  });
  try {
    const settled = await settleAttemptAfterBudget(attempt);
    assert.equal(settled.settled, true, 'the attempt ended on the early response, not on a budget');
    // The join in the attempt's own teardown is what this bound proves: a pipeline still blocked on
    // the parked peer would leave the attempt unresolved for its whole phase budget.
    assert.ok(settled.rounds < 20, `settled in ${settled.rounds} real-loop rounds`);
    const result = await attempt;

    // The accepted early response is a real outcome, not a pipeline abortion.
    assert.equal(result.error, undefined, `got ${String(result.error)}`);
    assert.equal(result.value?.statusCode, 413);
    assert.equal(result.value?.body, 'payload too large');
    // The owned file and request were ended, not left writing: the peer took a fraction of the
    // artifact and the rest never arrived.
    assert.equal(daemon.legs.length, 1);
    assert.ok(
      (daemon.legs[0]?.bytes ?? 0) < artifactBytes,
      `the peer took ${daemon.legs[0]?.bytes} of ${artifactBytes} bytes`,
    );
  } finally {
    await daemon.close();
  }
});

test('a resume response ends the stalled hop before the next attempt is dialed', async () => {
  useTransferClock();
  const resumeOffset = MEBIBYTE;
  const artifactBytes = 4 * MEBIBYTE;
  const daemon = await startAnswerUploadDaemon({
    respond: () => ({
      status: 308,
      headers: { 'x-upload-offset': String(resumeOffset) },
      body: '',
    }),
  });
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(artifactBytes),
  });
  try {
    // Leg one is answered 308 while its body is still queued; leg two answers the same offset
    // again, which is a typed terminal failure rather than a third hop.
    const settled = await settleAttemptAfterBudget(attempt);
    assert.equal(settled.settled, true);
    const result = await attempt;

    assertDetailedError(result.error, { offset: resumeOffset, previousOffset: resumeOffset });
    const uploadLegs = daemon.requests.filter((entry) => entry === 'POST /upload');
    assert.equal(uploadLegs.length, 2);
    // Bytes really were still queued when the resume was answered: the peer had taken only part of
    // the artifact when the next leg was dialed.
    const firstLeg = daemon.legs[0];
    assert.ok(firstLeg);
    assert.ok(
      (firstLeg.bytesAtNextLeg ?? artifactBytes) < artifactBytes,
      `the first leg still had queued bytes at the handoff, at ${firstLeg.bytesAtNextLeg}`,
    );
    // And that leg never received its queued remainder: the owned file and request were ended and
    // joined before the next attempt started, so no old byte overlapped it.
    assert.ok(
      firstLeg.bytes < artifactBytes,
      `the stalled leg kept receiving after the handoff: ${firstLeg.bytes} of ${artifactBytes}`,
    );
  } finally {
    await daemon.close();
  }
});

test('a resumed hop that makes real progress past the first hop ceiling keeps its own retryable reset', async () => {
  useTransferClock();
  const artifactBytes = 32 * MEBIBYTE;
  let outgoingLegs = 0;
  let resumedDrains = 0;
  const request = http.request;
  const requestSpy = vi.spyOn(http, 'request').mockImplementation((...args) => {
    const req = Reflect.apply(request, http, args) as http.ClientRequest;
    outgoingLegs += 1;
    if (outgoingLegs === 2)
      req.on('drain', () => {
        resumedDrains += 1;
      });
    return req;
  });
  const daemon = await startParkedUploadDaemon({
    answerFirstLeg: { status: 308, headers: { 'x-upload-offset': String(MEBIBYTE) } },
  });
  // Hop one is answered while its body is still queued, so its response-body budget starts at fake
  // time zero; hop two then moves bytes the peer really takes, for longer than that budget lasts.
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(artifactBytes),
    method: 'POST',
    retryable: true,
  });
  try {
    // Gate on real bytes only: no fake time is charged until hop two has really taken some.
    for (let round = 0; round < 400 && !hopTwoTookBytes(daemon); round += 1) {
      await pumpRealWork(15);
    }
    assert.ok(hopTwoTookBytes(daemon), 'the resumed hop was dialed and took bytes');

    for (let window = 0; window < 6; window += 1) {
      const drainsBefore = resumedDrains;
      const bytesBefore = daemon.receivedBytes;
      for (let round = 0; round < 400; round += 1) {
        daemon.releaseAllParked();
        await pumpRealWork(15);
        if (resumedDrains > drainsBefore && daemon.receivedBytes > bytesBefore) break;
      }
      assert.ok(daemon.receivedBytes > bytesBefore, 'the peer took more resumed bytes');
      assert.ok(resumedDrains > drainsBefore, 'the resumed write queue drained');
      await vi.advanceTimersByTimeAsync(TRANSFER_CONNECT_TIMEOUT_MS);
      assert.equal(attempt.settled, false);
      assert.equal(daemon.bodyEnded, false);
    }
    assert.ok(6 * TRANSFER_CONNECT_TIMEOUT_MS > TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);

    daemon.resetParkedLeg();
    const settled = await settleAttemptAfterBudget(attempt);
    assert.equal(settled.settled, true);
    const result = await attempt;

    // The peer's reset is an ordinary transport failure of hop two. Hop one's retired budget must
    // not relabel it as a phase expiry, and the retry marker must survive for the client's retry.
    assert.equal(result.value, undefined);
    assert.equal(isTransferPhaseTimeoutError(result.error), false);
    assert.equal(isRetryableUploadStreamError(result.error), true);
    assert.equal(daemon.requests.filter((entry) => entry === LEGACY_UPLOAD_REQUEST).length, 2);
  } finally {
    requestSpy.mockRestore();
    await daemon.close();
  }
});

function hopTwoTookBytes(daemon: ParkedUploadDaemon): boolean {
  return (
    daemon.requests.filter((entry) => entry === LEGACY_UPLOAD_REQUEST).length === 2 &&
    daemon.receivedBytes > 0
  );
}

test('a redirect response ends the stalled hop before the next hop is dialed', async () => {
  useTransferClock();
  const artifactBytes = 4 * MEBIBYTE;
  const daemon = await startAnswerUploadDaemon({
    respond: (req) =>
      req.url === '/moved'
        ? { status: 413, body: 'moved and refused' }
        : { status: 307, headers: { location: '/moved' }, body: '' },
  });
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(artifactBytes),
  });
  try {
    const settled = await settleAttemptAfterBudget(attempt);
    assert.equal(settled.settled, true);
    const result = await attempt;

    assert.equal(result.error, undefined, `got ${String(result.error)}`);
    assert.equal(result.value?.statusCode, 413);
    assert.equal(result.value?.body, 'moved and refused');
    const firstLeg = daemon.legs[0];
    const redirectHop = daemon.requests.indexOf('POST /moved');
    assert.ok(firstLeg && redirectHop > 0, 'the redirect hop was dialed');
    assert.ok(
      (firstLeg.bytesAtNextLeg ?? artifactBytes) < artifactBytes,
      `bytes were still queued when the redirect hop started, at ${firstLeg.bytesAtNextLeg}`,
    );
    assert.ok(
      firstLeg.bytes < artifactBytes,
      `the redirected-from leg kept receiving after the hop: ${firstLeg.bytes} of ${artifactBytes}`,
    );
  } finally {
    await daemon.close();
  }
});

test('a response body that stops mid-answer expires the response-body phase after what was read', async () => {
  useTransferClock();
  const origin = await startHalfAnsweredOrigin({ firstChunk: 'first chunk' });
  const attempt = startUploadAttempt({
    url: `${origin.baseUrl}/upload`,
    artifactPath: createArtifactFile(64),
  });
  try {
    await pumpRealWork();
    await spendAttemptBudget(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 5_000, attempt);
    const settled = await settleAttemptAfterBudget(attempt);
    assert.equal(settled.settled, true);
    const result = await attempt;

    assert.equal(result.value, undefined);
    // The stall is mid-response-body, and the budget that says so is the body one; the consumed
    // first chunk made the attempt's own outgoing work already settle, not linger.
    assertDetailedError(result.error, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'response-body',
      timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
    });
  } finally {
    await origin.close();
  }
});

test('a connected peer that never takes a body byte expires body inactivity, not connect', async () => {
  useTransferClock();
  const origin = await startConnectedStalledHttpOrigin();
  const attempt = startUploadAttempt({
    url: `http://127.0.0.1:${origin.port}/upload`,
    artifactPath: createArtifactFile(4 * MEBIBYTE),
  });
  try {
    await spendAttemptBudget(TRANSFER_CONNECT_TIMEOUT_MS + 1_000, attempt);
    // The connection was carried, so the connect ceiling is over: a carried connection is never
    // ended by the budget that governs dialing it.
    assert.equal(attempt.settled, false);
    await spendAttemptBudget(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 5_000, attempt);
    const settled = await settleAttemptAfterBudget(attempt);
    assert.equal(settled.settled, true);
    const result = await attempt;

    assert.equal(result.value, undefined);
    assertDetailedError(result.error, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'request-body',
      timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
    });
  } finally {
    await origin.close();
  }
});

test('a TLS handshake that never completes expires connect even with the whole body buffered', async () => {
  useTransferClock();
  // The transport accepts the socket and never completes the handshake, so `write()` accepts the
  // artifact into the queue while nothing the peer answers arrives. A read-ahead progress signal
  // would swap the connect ceiling for a body budget here; buffered bytes are not transport
  // progress, so the connect ceiling must still expire.
  const origin = await startUnfinishedHandshakeTlsOrigin();
  const attempt = startUploadAttempt({
    url: `https://127.0.0.1:${origin.port}/upload`,
    artifactPath: createArtifactFile(4 * MEBIBYTE),
  });
  try {
    await spendAttemptBudget(TRANSFER_CONNECT_TIMEOUT_MS + 5_000, attempt);
    const settled = await settleAttemptAfterBudget(attempt);
    assert.equal(settled.settled, true);
    const result = await attempt;

    assert.equal(result.value, undefined);
    assertDetailedError(result.error, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'connect',
      timeoutMs: TRANSFER_CONNECT_TIMEOUT_MS,
    });
  } finally {
    await origin.close();
  }
});

test('a completed TLS handshake with a stalled body expires body inactivity, not connect', async () => {
  useTransferClock();
  // `secureConnect` is the establishment event for TLS: once it fires, the connect phase is over
  // and the stalled artifact is body inactivity, charged with the body budget. The origin's socket
  // handler below answers the handshake and then stops reading, so a trusted peer connection has to
  // be established for this to say anything.
  const trusted = trustSelfSignedLocalhostCertificate();
  const origin = await startConnectedStalledTlsOrigin();
  try {
    // The control leg first: the same trust decision, a peer that reads nothing but completes the
    // handshake, and the outcome is a body-phase expiry rather than a handshake failure.
    const attempt = startUploadAttempt({
      url: `https://127.0.0.1:${origin.port}/upload`,
      artifactPath: createArtifactFile(4 * MEBIBYTE),
    });
    await spendAttemptBudget(TRANSFER_CONNECT_TIMEOUT_MS + 1_000, attempt);
    assert.equal(attempt.settled, false, 'secureConnect ended the connect phase');
    await spendAttemptBudget(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 5_000, attempt);
    const settled = await settleAttemptAfterBudget(attempt);
    assert.equal(settled.settled, true);
    const result = await attempt;

    assert.equal(result.value, undefined);
    assertDetailedError(result.error, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'request-body',
      timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
    });
  } finally {
    trusted.restore();
    await origin.close();
  }
});

test('a zero-length artifact on a peer that never answers waits on its header budget', async () => {
  useTransferClock();
  const origin = await startConnectedStalledHttpOrigin();
  const attempt = startUploadAttempt({
    url: `http://127.0.0.1:${origin.port}/upload`,
    artifactPath: createArtifactFile(0),
  });
  try {
    // The body is nothing, so the flush arrives with the connection and the wait that expires is the
    // one for the answer the peer owes. That ceiling (30s) is the shorter of the two, so an expiry
    // recorded against it — and not against the 120s body budget — is the header wait on its own.
    await spendAttemptBudget(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS - 5_000, attempt);
    assert.equal(attempt.settled, false);
    await spendAttemptBudget(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS + 5_000, attempt);
    const settled = await settleAttemptAfterBudget(attempt);
    assert.equal(settled.settled, true);
    const result = await attempt;

    assert.equal(result.value, undefined);
    assertDetailedError(result.error, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'response-headers',
      timeoutMs: TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
    });
    assert.equal(origin.bytesTaken, 0);
  } finally {
    await origin.close();
  }
});

test('an upload the peer keeps taking finishes while every phase ceiling is unexpired', async () => {
  useTransferClock();
  const daemon = await startSlowReadingUploadDaemon({
    status: 200,
    body: JSON.stringify({ ok: true, uploadId: 'joined-upload' }),
  });
  const attempt = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(MEBIBYTE),
  });
  try {
    // Real backpressure the whole way: the peer admits roughly one chunk between releases, so the
    // upload can only finish by earning window after window of body progress. Every window is
    // charged, and the attempt must be over before the two ceilings a progressing upload may never
    // exceed (connect, then the header wait its flush starts) have run out.
    let spent = 0;
    while (
      !attempt.settled &&
      spent < TRANSFER_CONNECT_TIMEOUT_MS + TRANSFER_RESPONSE_HEADER_TIMEOUT_MS
    ) {
      daemon.releaseAllParked();
      await vi.advanceTimersByTimeAsync(1_000);
      spent += 1_000;
      await pumpRealWork();
    }
    const result = await attempt;

    assert.equal(result.error, undefined, `upload failed: ${String(result.error)}`);
    assert.equal(result.value?.statusCode, 200);
    assert.ok(
      spent < TRANSFER_CONNECT_TIMEOUT_MS + TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
      `finished in ${spent}ms of budget, inside both ceilings a progressing upload must not exceed`,
    );
    // A completed upload was never destroyed mid-leg: the server saw the body arrive to its end and
    // answered on the same leg the client wrote.
    assert.equal(daemon.bodyEnded, true);
    assert.equal(daemon.receivedBytes, MEBIBYTE);
  } finally {
    await daemon.close();
  }
}, 30_000);

test('a caller cancel during a stalled connect stays caller cancellation, distinct from the connect expiry', async () => {
  useTransferClock();
  const control = new AbortController();
  const origin = await startUnfinishedHandshakeTlsOrigin();
  const canceled = startUploadAttempt({
    url: `https://127.0.0.1:${origin.port}/upload`,
    artifactPath: createArtifactFile(64 * 1024),
    signal: control.signal,
  });
  try {
    // Well inside the connect ceiling: only the caller can be the reason this stops.
    await spendAttemptBudget(5_000, canceled);
    control.abort();
    const result = await canceled;

    assert.equal(result.value, undefined);
    assert.ok(result.error instanceof DOMException, `got ${String(result.error)}`);
    assert.equal((result.error as DOMException).name, 'AbortError');
    assert.equal(control.signal.aborted, true);
  } finally {
    await origin.close();
  }
});

test('an enclosing aggregate deadline ends a redirect hop with its own reason, not a phase timeout', async () => {
  useTransferClock();
  const aggregate = new AbortController();
  // Leg one redirects while it stops reading; leg two is the hop that never answers, so the attempt
  // is parked in a phase when the deadline it was admitted under runs out.
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
  try {
    await pumpRealWork();
    // No phase budget is charged here, so nothing but the caller's deadline can end this.
    const reason = new Error('preparation aggregate expired');
    aggregate.abort(reason);
    const settled = await settleAttemptAfterBudget(attempt);
    assert.equal(settled.settled, true);
    const result = await attempt;

    assert.equal(result.value, undefined);
    assert.equal(result.error, reason);
    assert.equal(isTransferPhaseTimeoutError(result.error), false);
  } finally {
    await daemon.close();
  }
});

test('an attempt on a reused connection is already past its connect phase', async () => {
  useTransferClock();
  // Leg one completes and its socket goes back to the pool; leg two runs on that socket, which is
  // already connected, and is never answered. A pooled socket never emits `connect`, so an attempt
  // that only ever transitioned on that event would still be timing the connection here. The phase
  // that expires is the header wait the unanswered flush deserves, on one connection.
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
  const firstSettled = await settleAttemptAfterBudget(first);
  assert.equal(firstSettled.settled, true);
  const firstResult = await first;
  assert.equal(firstResult.error, undefined, `leg one failed: ${String(firstResult.error)}`);

  const second = startUploadAttempt({
    url: `${daemon.baseUrl}/upload`,
    artifactPath: createArtifactFile(64 * 1024),
  });
  try {
    await spendAttemptBudget(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS + 5_000, second);
    const settled = await settleAttemptAfterBudget(second);
    assert.equal(settled.settled, true);
    const result = await second;

    assert.equal(result.value, undefined);
    assertDetailedError(result.error, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'response-headers',
      timeoutMs: TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
    });
    assert.equal(daemon.connections, 1, 'the second attempt reused the pooled socket');
  } finally {
    await daemon.close();
  }
});
