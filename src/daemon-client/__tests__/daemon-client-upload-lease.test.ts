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
  LEASE_HEARTBEAT_INTERVAL_MS,
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

describe('runProtectedLeaseWork', () => {
  test('runs the task untouched when there is no lease to protect', async () => {
    const heartbeat = vi.fn();
    assert.equal(
      await runProtectedLeaseWork({ heartbeat: undefined, task: async () => 'ok' }),
      'ok',
    );
    assert.equal(heartbeat.mock.calls.length, 0);
  });

  test('beats on the interval while a slow task runs, and stops when it ends', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => ({}));
    const upload = deferred<string>();

    const running = runProtectedLeaseWork({
      heartbeat,
      task: () => upload.promise,
    });

    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS * 3);
    // #2946: a 1m47s upload beat zero times and the lease died. Three intervals, three beats.
    assert.equal(heartbeat.mock.calls.length, 3);

    upload.resolve('installed');
    assert.equal(await running, 'installed');

    const before = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LEASE_HEARTBEAT_INTERVAL_MS * 3);
    assert.equal(heartbeat.mock.calls.length, before, 'no beat outlives the phase');
  });

  test('never overlaps beats', async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let maxConcurrent = 0;
    const gates: ReturnType<typeof deferred<void>>[] = [];
    const upload = deferred<void>();
    const running = runProtectedLeaseWork({
      intervalMs: 10,
      task: () => upload.promise,
      heartbeat: async () => {
        const gate = deferred<void>();
        gates.push(gate);
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await gate.promise;
        inFlight -= 1;
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    assert.equal(gates.length, 1);

    // Three more intervals pass with the first beat still outstanding: none of them may start a
    // second one, or a slow beat would pile up behind a stalled transport.
    await vi.advanceTimersByTimeAsync(30);
    assert.equal(gates.length, 1, 'an outstanding beat holds the next one off');

    gates[0]!.resolve();
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(gates.length, 2, 'the next beat starts once the previous one lands');

    gates[1]!.resolve();
    upload.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await running;
    assert.equal(maxConcurrent, 1);
  });

  test('a beat that fails for a reason other than the lease still running is survived', async () => {
    vi.useFakeTimers();
    const failing: () => Promise<unknown> = async () => {
      // A reason from the same registry that is not a lost lease: contention says nothing about
      // whether this lease is still ours, so the upload keeps going and the next beat asks again.
      throw new AppError('DEVICE_IN_USE', 'Device is already leased', {
        reason: 'DEVICE_LEASE_BUSY',
      });
    };
    const heartbeat = vi.fn(failing);
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      intervalMs: 10,
      task: () => upload.promise,
      heartbeat,
    });

    await vi.advanceTimersByTimeAsync(35);
    assert.equal(heartbeat.mock.calls.length, 3, 'one lost beat does not stop the others');

    heartbeat.mockImplementation(async () => ({}));
    await vi.advanceTimersByTimeAsync(10);
    upload.resolve('installed');
    assert.equal(await running, 'installed');
  });

  for (const reason of [
    'LEASE_NOT_FOUND',
    'LEASE_EXPIRED',
    'LEASE_REVOKED',
    'LEASE_SESSION_MISMATCH',
  ]) {
    test(`a beat that finds the lease ${reason} ends the phase with that error`, async () => {
      vi.useFakeTimers();
      const heartbeat = vi.fn(async () => {
        throw lostLeaseError(reason);
      });
      const upload = deferred<string>();
      const running = runProtectedLeaseWork({
        intervalMs: 10,
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
      await vi.advanceTimersByTimeAsync(15);
      await rejected;
      upload.resolve('too late');
    });
  }

  test('an upload that lands before the first beat reports success', async () => {
    vi.useFakeTimers();
    const upload = deferred<string>();
    const running = runProtectedLeaseWork({
      intervalMs: 10,
      task: () => upload.promise,
      heartbeat: async () => {
        throw lostLeaseError('LEASE_NOT_FOUND');
      },
    });

    upload.resolve('installed');
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(await running, 'installed');
  });

  test('a phase that throws synchronously still stops the beats', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => ({}));
    await assert.rejects(
      (async () =>
        await runProtectedLeaseWork({
          intervalMs: 10,
          task: () => {
            throw new AppError('INVALID_ARGS', 'artifact vanished');
          },
          heartbeat,
        }))(),
      /artifact vanished/,
    );

    await vi.advanceTimersByTimeAsync(100);
    assert.equal(heartbeat.mock.calls.length, 0, 'no timer outlived a phase that never started');
  });

  test('a lost lease surfaces as a rejection even when the task finishes first', async () => {
    vi.useFakeTimers();

    let beat: (() => void) | undefined;
    const first = deferred<string>();
    const running = runProtectedLeaseWork({
      intervalMs: 10,
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
    await vi.advanceTimersByTimeAsync(10);
    assert.ok(beat, 'a beat started');
    first.resolve('installed');
    beat?.();
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
  });

  test('a task rejection propagates and still stops the beats', async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => ({}));
    const running = runProtectedLeaseWork({
      intervalMs: 10,
      task: async () => {
        throw new AppError('COMMAND_FAILED', 'upload failed');
      },
      heartbeat,
    });

    await assert.rejects((async () => await running)(), /upload failed/);
    const before = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(heartbeat.mock.calls.length, before);
  });

  test('an in-flight beat is awaited on the way out', async () => {
    vi.useFakeTimers();
    const beat = deferred<void>();
    const upload = deferred<string>();
    let started = false;
    const running = runProtectedLeaseWork({
      intervalMs: 10,
      task: () => upload.promise,
      heartbeat: async () => {
        started = true;
        await beat.promise;
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    assert.equal(started, true, 'a beat is in flight while the upload finishes');

    upload.resolve('installed');
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(settled, false, 'the phase waits for the renewal it started');

    beat.resolve();
    assert.equal(await running, 'installed');
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

  function beatContext(send: (request: DaemonRequest) => Promise<unknown>) {
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
    )();

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
    await beat();
    await beat();
    await beat();

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
    await assert.rejects((async () => await beat())(), /connection reset/);
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
      await beat!();
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
});
