import { afterEach, describe, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import { AppError } from '@agent-device/kernel/errors';
import { closeLoopbackServer, listenOnLoopback } from '../../__tests__/test-utils/loopback.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import {
  buildLeaseHeartbeatRequest,
  buildUploadLeaseHeartbeat,
  createLeaseRenewalBeat,
  leaseScopeForHeartbeat,
  runProtectedLeaseWork,
} from '../daemon-client.ts';
import type { DaemonRequest } from '../../daemon/daemon-request.ts';

function lostLeaseError(reason: string): AppError {
  return new AppError('UNAUTHORIZED', 'Lease is not active', { reason });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

function renewedLeaseResponse(windowMs: number): {
  ok: true;
  data: { lease: { heartbeatAt: number; expiresAt: number } };
} {
  return { ok: true, data: { lease: { heartbeatAt: 1_000_000, expiresAt: 1_000_000 + windowMs } } };
}

describe('runProtectedLeaseWork', () => {
  test('runs the task untouched when there is no lease to protect', async () => {
    const heartbeat = vi.fn();
    const phase = await runProtectedLeaseWork({ heartbeat: undefined, task: async () => 'ok' });
    assert.equal(phase, 'ok');
    assert.equal(heartbeat.mock.calls.length, 0);
  });

  test('a fast upload that lands before the first beat reports success', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => renewedLeaseResponse(30_000));
    const running = runProtectedLeaseWork({
      task: async (signal) => {
        assert.ok(!signal.aborted, 'a lease still held does not cancel the upload');
        return 'installed';
      },
      heartbeat,
    });

    assert.equal(await running, 'installed', 'the beat is armed but the upload is faster');
  });

  test('the first beat fires immediately, not one interval into the upload', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => renewedLeaseResponse(30_000));
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      task: () => upload.promise,
      heartbeat,
    });

    // A lease admitted with a short window used to be able to lapse before the first beat: the
    // upload paid for the device with a lease nobody renewed yet.
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(heartbeat.mock.calls.length, 1, 'a beat is out before any interval elapses');

    upload.resolve('installed');
    assert.equal(await running, 'installed');
  });

  test('beats follow the window the lease reports, not the assumed floor', async () => {
    vi.useFakeTimers();
    // The daemon says it just extended the lease by 15s; the next beat must land a third of that
    // after the answer, whatever the loop assumed beforehand.
    const heartbeat = vi.fn(async () => renewedLeaseResponse(15_000));
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      task: () => upload.promise,
      heartbeat,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(heartbeat.mock.calls.length, 2, 'first beat at once, second a third of 15s in');
    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(heartbeat.mock.calls.length, 3);

    upload.resolve('installed');
    assert.equal(await running, 'installed');
    const before = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(heartbeat.mock.calls.length, before, 'no beat outlives the phase');
  });

  test('a beat shorter than the floor still beats no faster than the floor', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => renewedLeaseResponse(1_500));
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      task: () => upload.promise,
      heartbeat,
    });

    await vi.advanceTimersByTimeAsync(999);
    assert.equal(heartbeat.mock.calls.length, 1, 'the floor holds a pathological window off');
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(heartbeat.mock.calls.length, 2);

    upload.resolve('installed');
    assert.equal(await running, 'installed');
  });

  test('an answer that names no window keeps the cadence the beat was asked at', async () => {
    vi.useFakeTimers();
    // Slowing down here would have to rest on evidence about the lease, and an unreadable answer is
    // the absence of evidence: an older daemon renews happily without describing the window.
    const heartbeat = vi.fn(async () => ({ ok: true, data: {} }));
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      task: () => upload.promise,
      heartbeat,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(heartbeat.mock.calls.length, 2, 'immediate first, then the same cadence again');
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(heartbeat.mock.calls.length, 3);

    upload.resolve('installed');
    assert.equal(await running, 'installed');
  });

  test('each beat is given a budget no longer than the cadence it starts on', async () => {
    vi.useFakeTimers();
    const budgets: number[] = [];
    const heartbeat = vi.fn(async (budgetMs: number) => {
      budgets.push(budgetMs);
      return renewedLeaseResponse(60_000);
    });
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      task: () => upload.promise,
      heartbeat,
    });

    await vi.advanceTimersByTimeAsync(40_000);
    // Before the first answer the loop assumes the shortest window the daemon accepts, so the beat
    // that has to prove that lease is alive cannot itself take longer than a fifth of it. Once the
    // window is known the budget is the cadence: a stalled beat dies inside one, not the 90s the
    // command's own heartbeat policy would allow.
    assert.deepEqual(budgets, [1_000, 20_000, 20_000]);

    upload.resolve('installed');
    assert.equal(await running, 'installed');
  });

  test('a beat that never settles is abandoned on schedule and holds no successor off', async () => {
    vi.useFakeTimers();
    // The #2946 failure this loop exists to prevent, in its remaining shape: a beat stuck on a
    // half-open connection. Overlapping is the point — a stalled beat must not take the schedule
    // with it, or the lease dies at 60s while the beat waits out its transport timeout.
    const started: number[] = [];
    const stalled = deferred<never>();
    const heartbeat = vi.fn(async () => {
      started.push(Date.now());
      await stalled.promise;
      return renewedLeaseResponse(5_000);
    });
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      task: () => upload.promise,
      heartbeat,
    });

    // A lease on the registry's five-second minimum window, with every beat stalled.
    await vi.advanceTimersByTimeAsync(4_000);
    assert.ok(
      heartbeat.mock.calls.length >= 3,
      `beats keep coming through a stall, got ${heartbeat.mock.calls.length}`,
    );

    upload.resolve('installed');
    let outcome: string | undefined;
    void running.then((value) => {
      outcome = value;
    });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(outcome, 'installed', 'a finished upload does not wait on a stalled beat');
  });

  test('a late lost-lease answer from an abandoned beat is logged and does not rewrite the outcome', async () => {
    vi.useFakeTimers();
    let reportLost: ((error: unknown) => void) | undefined;
    const heartbeat = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          reportLost = reject;
        }),
    );
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      task: () => upload.promise,
      heartbeat,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    assert.equal(heartbeat.mock.calls.length, 4, 'the stalled beats were abandoned, not awaited');

    upload.resolve('installed');
    let outcome: string | undefined;
    void running.then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error instanceof AppError ? String(error.details?.reason) : 'rejected';
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(outcome, 'resolved', 'the upload had already finished when the beat was dropped');

    // The abandoned beat is still listened to: its late answer is a fact about the lease the caller
    // should be able to find in the log even though its own outcome already stands.
    reportLost?.(lostLeaseError('LEASE_EXPIRED'));
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(outcome, 'resolved');
  });

  test('a beat that fails for a transient reason is survived and re-armed', async () => {
    vi.useFakeTimers();
    // A reason from the same registry that is not a lost lease: contention says nothing about
    // whether this lease is still ours, so the upload keeps going and the next beat asks again.
    const heartbeat = vi.fn<() => Promise<unknown>>(async () => {
      throw new AppError('DEVICE_IN_USE', 'Device is already leased', {
        reason: 'DEVICE_LEASE_BUSY',
      });
    });
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      task: () => upload.promise,
      heartbeat,
    });

    await vi.advanceTimersByTimeAsync(2_500);
    assert.equal(heartbeat.mock.calls.length, 3, 'one failed beat does not stop the others');

    heartbeat.mockImplementation(async () => renewedLeaseResponse(30_000));
    await vi.advanceTimersByTimeAsync(1_000);
    upload.resolve('installed');
    assert.equal(await running, 'installed');
  });

  for (const reason of ['LEASE_NOT_FOUND', 'LEASE_EXPIRED', 'LEASE_REVOKED']) {
    test(`a beat that finds the lease ${reason} ends the phase with that error`, async () => {
      vi.useFakeTimers();
      const heartbeat = vi.fn(async () => {
        throw lostLeaseError(reason);
      });
      const upload = deferred<string>();
      const running = runProtectedLeaseWork({
        task: () => upload.promise,
        heartbeat,
      });

      // #2946 asked for an upload longer than the TTL to still succeed; when the lease really is
      // gone the honest answer is the lease error, delivered before the bytes finish. The
      // expectation rides the promise before the clock moves, so the rejection is never unobserved.
      const rejected = assert.rejects(
        running,
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'UNAUTHORIZED' &&
          error.details?.reason === reason,
      );
      await vi.advanceTimersByTimeAsync(0);
      await rejected;
      upload.resolve('too late');
    });
  }

  for (const reason of ['LEASE_SCOPE_REQUIRED', 'LEASE_SCOPE_MISMATCH']) {
    test(`a beat refused ${reason} ends the phase instead of beating to the lease's death`, async () => {
      vi.useFakeTimers();
      // Both say this request can never renew the lease — the scope it names is missing or belongs
      // to someone else. Surviving would spend the whole upload on a lease that stops renewing:
      // the #2946 symptom recreated on the client's own side.
      const heartbeat = vi.fn(async () => {
        throw new AppError('UNAUTHORIZED', "Lease scope is not this request's", { reason });
      });
      const upload = deferred<string>();
      const running = runProtectedLeaseWork({
        task: () => upload.promise,
        heartbeat,
      });

      const rejected = assert.rejects(
        running,
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'UNAUTHORIZED' &&
          error.details?.reason === reason,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      assert.equal(
        heartbeat.mock.calls.length,
        1,
        'a doomed renewal is not retried for the window',
      );
      await rejected;
      upload.resolve('too late');
    });
  }

  test('a beat refused INVALID_ARGS ends the phase, because the beat asks the same thing forever', async () => {
    vi.useFakeTimers();
    // The beat's scope and ttl are fixed when it is built, so a daemon that rejects them — a ttl
    // outside [minLeaseTtlMs, maxLeaseTtlMs] — rejects every successor identically. It carries no
    // reason to key on, so the code is the signal; waiting it out only spends the upload.
    const heartbeat = vi.fn(async () => {
      throw new AppError('INVALID_ARGS', 'Lease ttlMs must be between 5000 and 3600000.');
    });
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      task: () => upload.promise,
      heartbeat,
    });

    const rejected = assert.rejects(
      running,
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
    await vi.advanceTimersByTimeAsync(5_000);
    assert.equal(heartbeat.mock.calls.length, 1, 'a refusal the beat cannot fix is not retried');
    await rejected;
    upload.resolve('too late');
  });

  test('a beat that ends the protection cancels the upload the phase is running', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => {
      throw lostLeaseError('LEASE_NOT_FOUND');
    });
    let sawAbort = false;
    const running = runProtectedLeaseWork({
      task: (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(signal.reason);
          });
        }),
      heartbeat,
    });

    const rejected = assert.rejects(running);
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    assert.equal(sawAbort, true, 'the upload is told to stop before the bytes finish');
  });

  test('a phase that throws synchronously still stops the beats', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => ({ ok: true }));
    await assert.rejects(
      (async () =>
        await runProtectedLeaseWork({
          task: () => {
            throw new AppError('INVALID_ARGS', 'artifact vanished');
          },
          heartbeat,
        }))(),
      /artifact vanished/,
    );

    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(heartbeat.mock.calls.length, 0, 'no timer outlived a phase that never started');
  });

  test('a lost lease surfaces as a rejection even when the task finishes first', async () => {
    vi.useFakeTimers();

    let beat: (() => void) | undefined;
    const first = deferred<string>();
    const running = runProtectedLeaseWork({
      task: () => first.promise,
      heartbeat: () =>
        new Promise((_, reject) => {
          beat = () => reject(lostLeaseError('LEASE_NOT_FOUND'));
        }),
    });

    const rejected = assert.rejects(
      running,
      (error: unknown) => error instanceof AppError && error.details?.reason === 'LEASE_NOT_FOUND',
    );
    await vi.advanceTimersByTimeAsync(0);
    assert.ok(beat, 'a beat started');
    first.resolve('installed');
    beat?.();
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
  });

  test('a task rejection propagates and still stops the beats', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => ({ ok: true }));
    const running = runProtectedLeaseWork({
      task: async () => {
        throw new AppError('COMMAND_FAILED', 'upload failed');
      },
      heartbeat,
    });

    await assert.rejects((async () => await running)(), /upload failed/);
    const before = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(heartbeat.mock.calls.length, before);
  });

  test('an abandoned beat arms no successor once the phase has settled', async () => {
    vi.useFakeTimers();
    const beat = deferred<void>();
    const upload = deferred<string>();
    const heartbeat = vi.fn(async () => {
      await beat.promise;
      return renewedLeaseResponse(30_000);
    });
    const running = runProtectedLeaseWork({
      task: () => upload.promise,
      heartbeat,
    });

    await vi.advanceTimersByTimeAsync(0);
    assert.equal(heartbeat.mock.calls.length, 1, 'a beat is in flight while the upload finishes');

    upload.resolve('installed');
    assert.equal(await running, 'installed', 'the phase does not wait on a beat it gave up on');

    beat.resolve();
    await vi.advanceTimersByTimeAsync(120_000);
    assert.equal(heartbeat.mock.calls.length, 1, 'the renewal that landed last arms no successor');
  });
});

describe('leaseScopeForHeartbeat', () => {
  test('names no lease for a request that carries none', () => {
    assert.equal(leaseScopeForHeartbeat({ flags: {}, meta: undefined }), undefined);
  });

  test('reads the lease scope from the request meta, then from the flags', () => {
    assert.equal(
      leaseScopeForHeartbeat({ meta: { leaseId: 'lease-meta', tenantId: 'acme' } })?.leaseId,
      'lease-meta',
    );
    assert.equal(
      leaseScopeForHeartbeat({ flags: { leaseId: 'lease-flag' } })?.leaseId,
      'lease-flag',
    );
  });
});

describe('buildLeaseHeartbeatRequest', () => {
  test('carries the lease scope and nothing that belongs to the request it is protecting', () => {
    const beat = buildLeaseHeartbeatRequest(
      {
        leaseId: 'lease-1',
        tenantId: 'acme',
        runId: 'run-1',
        leaseBackend: 'android-instance',
        leaseProvider: 'proxy',
        deviceKey: 'android:mobile:emulator-5554',
        clientId: 'client-1',
      },
      {
        session: 'adc-android',
        sessionIsolation: 'tenant',
        requestId: 'beat-1',
        token: 'daemon-token',
      },
    );

    assert.equal(beat.command, 'lease_heartbeat');
    assert.deepEqual(beat.positionals, []);
    assert.equal(beat.session, 'adc-android');
    assert.equal(beat.token, 'daemon-token');
    assert.deepEqual(beat.meta, {
      leaseId: 'lease-1',
      tenantId: 'acme',
      runId: 'run-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'proxy',
      deviceKey: 'android:mobile:emulator-5554',
      clientId: 'client-1',
      sessionIsolation: 'tenant',
      requestId: 'beat-1',
    });
    // The socket transport serializes the whole request, so a beat that rode along with the install
    // would re-send a 449 MB artifact every interval.
    assert.equal(beat.flags, undefined);
    assert.equal('installSource' in (beat.meta ?? {}), false);
    assert.equal(beat.internal, undefined);
  });

  test('sends no ttl for an install, whose scope never carried one, so the lease keeps its own window', () => {
    // connection-runtime passes the TTL to `leases.allocate` only, so an install request's scope has
    // none. A beat that invented one would shorten a lease allocated longer.
    const installRequest: Pick<DaemonRequest, 'flags' | 'meta'> = {
      flags: { leaseId: 'lease-1', platform: 'android' },
      meta: { leaseId: 'lease-1', tenantId: 'acme' },
    };
    const scope = leaseScopeForHeartbeat(installRequest)!;
    const beat = buildLeaseHeartbeatRequest(scope, {
      session: 'default',
      requestId: 'beat-1',
      token: 't',
    });
    assert.equal(beat.meta?.leaseTtlMs, undefined);
  });

  test('a caller that did name a ttl keeps renewing on it', () => {
    const scope = leaseScopeForHeartbeat({
      flags: { leaseId: 'lease-1' },
      meta: { leaseId: 'lease-1', leaseTtlMs: 600_000 },
    })!;
    const beat = buildLeaseHeartbeatRequest(scope, {
      session: 'default',
      requestId: 'beat-1',
      token: 't',
    });
    assert.equal(beat.meta?.leaseTtlMs, 600_000);
  });
});

describe('createLeaseRenewalBeat', () => {
  const scope = {
    leaseId: 'lease-1',
    tenantId: 'acme',
    runId: 'run-1',
    leaseBackend: 'android-instance',
  } as const;

  function beatContext(send: (request: DaemonRequest, budgetMs: number) => Promise<unknown>) {
    return {
      session: 'adc-android',
      sessionIsolation: 'tenant' as const,
      token: 'daemon-token',
      send,
    };
  }

  test('sends one lease_heartbeat naming the lease it is protecting', async () => {
    const sent: DaemonRequest[] = [];
    await createLeaseRenewalBeat(
      scope,
      beatContext(async (request) => void sent.push(request)),
    )(1_000);

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.command, 'lease_heartbeat');
    assert.equal(sent[0]!.meta?.leaseId, 'lease-1');
    assert.equal(sent[0]!.meta?.tenantId, 'acme');
    assert.equal(sent[0]!.meta?.runId, 'run-1');
    assert.equal(sent[0]!.meta?.sessionIsolation, 'tenant');
    assert.equal(sent[0]!.session, 'adc-android');
    assert.equal(sent[0]!.token, 'daemon-token');
  });

  test('every beat is a distinct request, so a timed-out beat cannot cancel the next one', async () => {
    const sent: DaemonRequest[] = [];
    const beat = createLeaseRenewalBeat(
      scope,
      beatContext(async (request) => void sent.push(request)),
    );
    await beat(1_000);
    await beat(1_000);
    await beat(1_000);

    const ids = sent.map((request) => request.meta?.requestId);
    assert.equal(new Set(ids).size, 3, 'three beats, three request ids');
    assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
  });

  test('a transport failure propagates to the caller that survives it', async () => {
    const beat = createLeaseRenewalBeat(
      scope,
      beatContext(async () => {
        throw new AppError('COMMAND_FAILED', 'connection reset');
      }),
    );
    await assert.rejects((async () => await beat(1_000))(), /connection reset/);
  });
});

describe('buildUploadLeaseHeartbeat', () => {
  const installRequest = {
    command: 'install',
    positionals: ['/tmp/app.apk'],
    session: 'adc-android',
    flags: {
      leaseId: 'lease-1',
      tenantId: 'acme',
      runId: 'run-1',
      deviceKey: 'android:mobile:emulator-5554',
      platform: 'android' as const,
    },
    meta: { leaseId: 'lease-1', tenantId: 'acme', runId: 'run-1' },
  };

  const settings = {
    paths: resolveDaemonPaths('/tmp/agent-device-upload-lease'),
    transportPreference: 'socket' as const,
    serverMode: 'socket' as const,
  };

  test('no beat for a remote request that names no lease, which has nothing to renew', () => {
    // The lease-less path is the one an unleased install takes; a timer there would beat a lease
    // that does not exist and keep a request alive that owns no device.
    assert.equal(
      buildUploadLeaseHeartbeat(
        { baseUrl: 'http://remote.example.test/agent-device', token: 't', pid: 1 },
        settings,
        { ...installRequest, flags: {}, meta: undefined },
      ),
      undefined,
    );
  });

  test('no beat for a local daemon, which never uploads and holds no billed device', () => {
    assert.equal(
      buildUploadLeaseHeartbeat(
        { port: 1, token: 't', pid: process.pid },
        settings,
        installRequest,
      ),
      undefined,
    );
  });

  test('the beat reaches a remote daemon over its HTTP endpoint', async () => {
    const requests: { method?: string; path?: string; body: string }[] = [];
    const server = net.createServer((socket) => {
      let body = '';
      socket.on('data', (chunk) => {
        body += chunk.toString('utf8');
        const headerEnd = body.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const head = body.slice(0, headerEnd);
        const [requestLine] = head.split('\r\n');
        const [method, path] = requestLine?.split(' ') ?? [];
        requests.push({ method, path, body: body.slice(headerEnd + 4) });
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: 'x',
          result: { ok: true },
        });
        socket.write(
          `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${String(
            payload.length,
          )}\r\n\r\n${payload}`,
        );
        socket.end();
      });
    });
    const port = await listenOnLoopback(server);

    try {
      const beat = buildUploadLeaseHeartbeat(
        { baseUrl: `http://127.0.0.1:${String(port)}/agent-device`, token: 'remote-token', pid: 1 },
        { ...settings, transportPreference: 'auto' },
        installRequest,
      );
      assert.ok(beat);
      await beat!(5_000);
    } finally {
      await closeLoopbackServer(server);
    }

    const posted = requests.find((request) => request.method === 'POST');
    assert.ok(posted, 'the beat POSTs to the remote daemon');
    const payload = JSON.parse(posted!.body) as {
      method: string;
      params: Record<string, unknown>;
    };
    assert.equal(posted!.path, '/agent-device/rpc');
    assert.equal(payload.method, 'agent_device.lease.heartbeat');
    assert.equal(payload.params.leaseId, 'lease-1');
    assert.equal(payload.params.tenantId, 'acme');
    assert.equal(payload.params.runId, 'run-1');
    assert.equal(payload.params.deviceKey, 'android:mobile:emulator-5554');

    // A beat asks for the same lease to keep going: it names no window, so the daemon renews the one
    // the lease already carries.
    assert.equal('ttlMs' in payload.params, false);
  });

  test('a beat that never answers dies at its budget, not at the heartbeat policy', async () => {
    vi.useFakeTimers();
    // The daemon accepts the connection and never answers — a half-open pipe. The beat exists to
    // notice the lease inside its window, so the transport must cut it at the budget the loop
    // handed it (here well under the command's 90s lease_heartbeat policy) and destroy the
    // socket, instead of holding one half-open for the full policy.
    const server = net.createServer(() => {});
    const port = await listenOnLoopback(server);
    try {
      const beat = buildUploadLeaseHeartbeat(
        { baseUrl: `http://127.0.0.1:${String(port)}/agent-device`, token: 'remote-token', pid: 1 },
        { ...settings, transportPreference: 'auto' },
        installRequest,
      );
      assert.ok(beat);
      const rejected = assert.rejects((async () => await beat!(1_000))(), /timed out/i);
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
    } finally {
      vi.useRealTimers();
      await closeLoopbackServer(server);
    }
  });
});
