import { resolveSessionRequestLogPath } from '@agent-device/daemon-contracts/session-artifact-paths';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createDaemonHttpServer } from '../http/http-server.ts';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

const RECORD = '{"phase":"request_start"}\n{"phase":"request_failed"}\n';

// A record large enough that the daemon is still writing the response body when the
// client hangs up: the read stream is mid-read, which is the state that leaks its fd.
const LARGE_RECORD_BYTES = 32 * 1024 * 1024;

const OPEN_DENIED = Object.assign(new Error('permission denied'), { code: 'EACCES' });

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

/** Bounds an I/O promise the same way `upload-http-deadline.test.ts` does. */
async function withIO<T>(pending: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timeout = realSetTimeout(() => reject(new Error(`${label} did not complete in 2s`)), 2_000);
  });
  try {
    return await Promise.race([pending, guard]);
  } finally {
    realClearTimeout(timeout);
  }
}

function writeRecord(
  sessionsDir: string,
  session: string,
  requestId: string,
  content: string | Buffer = RECORD,
): string {
  const recordPath = resolveSessionRequestLogPath(
    path.join(sessionsDir, safeSessionName(session)),
    requestId,
  );
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, content);
  return recordPath;
}

/** Resolves once `isDone()` holds, spinning the event loop rather than a clock. */
async function flushUntilDone(isDone: () => boolean, label: string): Promise<void> {
  await withIO(
    (async () => {
      while (!isDone()) await new Promise((resolve) => setImmediate(resolve));
    })(),
    label,
  );
}

async function withDiagnosticsServer(
  run: (context: { baseUrl: string; sessionsDir: string; server: http.Server }) => Promise<void>,
  leaseRegistry?: LeaseRegistry,
): Promise<void> {
  const stateDir = mkdtempForTestSync('agent-device-request-diagnostics-');
  const sessionsDir = path.join(stateDir, 'sessions');
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    leaseRegistry,
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    resolveRequestDiagnosticsPath: (ref) =>
      resolveSessionRequestLogPath(
        path.join(sessionsDir, safeSessionName(ref.session)),
        ref.requestId,
      ),
    env: process.env,
    cwd: process.cwd(),
  });
  try {
    const port = await listenOnLoopback(server);
    await run({ baseUrl: `http://127.0.0.1:${port}`, sessionsDir, server });
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

/** `src/daemon.ts` exits on `uncaughtException`, so an abandoned read must never raise one. */
function watchUncaughtExceptions() {
  const uncaught: unknown[] = [];
  const record = (error: unknown) => {
    uncaught.push(error);
  };
  process.on('uncaughtException', record);
  return { uncaught, stop: () => process.off('uncaughtException', record) };
}

/** Holds every record open the route starts until the test answers it. */
function holdRecordOpens() {
  const createReadStream = fs.createReadStream;
  const opens: Array<{ stream: fs.ReadStream; answer: (error?: Error) => void }> = [];
  const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
    const stream: fs.ReadStream = createReadStream(file, {
      ...(typeof options === 'object' ? options : {}),
      fs: {
        ...fs,
        open: (openFile, flags, mode, callback) => {
          const answer = (error?: Error) => {
            if (error) callback(error);
            else fs.open(openFile, flags, mode, callback);
          };
          opens.push({ stream, answer });
        },
      },
    });
    return stream;
  });
  return { opens, restore: () => spy.mockRestore() };
}

/** Sends a diagnostics request for the test to abandon before the daemon answers it. */
function requestToAbandon(server: http.Server, baseUrl: string) {
  let response: http.ServerResponse | undefined;
  server.once('request', (_request, res) => {
    response = res;
  });
  let answered = false;
  const request = http.get(
    diagnosticsUrl(baseUrl, 'default', 'abc123'),
    { headers: { authorization: 'Bearer daemon-secret' } },
    () => {
      answered = true;
    },
  );
  request.on('error', () => {});
  return {
    async hangUp(): Promise<void> {
      request.destroy();
      await flushUntilDone(() => response?.destroyed === true, 'the daemon to see the hang-up');
    },
    assertNothingWritten(): void {
      assert.equal(answered, false);
      assert.equal(response?.headersSent, false);
      assert.equal(response?.writableEnded, false);
    },
  };
}

/** Answers a held open of an abandoned record and expects the stream to close quietly. */
async function assertAbandonedRecordCloses(
  open: ReturnType<typeof holdRecordOpens>['opens'][number],
  openError: Error | undefined,
): Promise<void> {
  const { stream, answer } = open;
  const exceptions = watchUncaughtExceptions();
  try {
    await flushUntilDone(() => stream.destroyed, 'the record read stream to destroy');
    answer(openError);
    await flushUntilDone(
      () => stream.closed || exceptions.uncaught.length > 0,
      'the record read stream to close',
    );
    assert.deepEqual(exceptions.uncaught, []);
    // `fd` is a runtime-only ReadStream property: null once no descriptor is held.
    const { fd } = stream as fs.ReadStream & { fd: number | null };
    assert.equal(fd, null, 'the record fd is released');
  } finally {
    exceptions.stop();
  }
}

async function requestRawStatus(baseUrl: string, requestTarget: string): Promise<number> {
  const url = new URL(baseUrl);
  return await new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: 'GET',
        path: requestTarget,
        headers: { authorization: 'Bearer daemon-secret' },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

function diagnosticsUrl(baseUrl: string, session: string, requestId: string): string {
  return `${baseUrl}/sessions/${encodeURIComponent(session)}/requests/${encodeURIComponent(requestId)}/diagnostics`;
}

test('request diagnostics route serves one record as ndjson to an authorized caller', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'cwd:9f1:default', 'abc123');
    const response = await fetch(diagnosticsUrl(baseUrl, 'cwd:9f1:default', 'abc123'), {
      headers: { authorization: 'Bearer daemon-secret' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(RECORD)));
    assert.equal(await response.text(), RECORD);
  });
});

test('request diagnostics returns complete JSON when its stream fails before headers', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    const createReadStream = fs.createReadStream;
    const streams = vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) =>
      createReadStream(file, {
        ...(typeof options === 'object' ? options : {}),
        fs: {
          ...fs,
          open: (_file, _flags, _mode, callback) => callback(new Error('record read failed')),
        },
      }),
    );
    let response: Response | undefined;
    try {
      response = await fetch(diagnosticsUrl(baseUrl, 'default', 'abc123'), {
        headers: { authorization: 'Bearer daemon-secret' },
      });
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('content-length')).toBeNull();
      expect(await response.json()).toMatchObject({ ok: false, error: 'record read failed' });
    } finally {
      await response?.body?.cancel().catch(() => {});
      streams.mockRestore();
    }
  });
});

test('request diagnostics answers JSON when the record fails on its first read', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    // The open succeeds, so the failure lands after the route took ownership of the
    // read: a first-read EIO, or a record removed under a Windows handle.
    const createReadStream = fs.createReadStream;
    const streams = vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) =>
      createReadStream(file, {
        ...(typeof options === 'object' ? options : {}),
        fs: {
          ...fs,
          read: (
            _stream: fs.ReadStream,
            _buffer: Buffer,
            _offset: number,
            _length: number,
            _position: number | null,
            callback: (error: Error | null, bytesRead?: number, buffer?: Buffer) => void,
          ) => {
            callback(Object.assign(new Error('record read failed'), { code: 'EIO' }));
          },
        },
      }),
    );
    let response: Response | undefined;
    try {
      response = await fetch(diagnosticsUrl(baseUrl, 'default', 'abc123'), {
        headers: { authorization: 'Bearer daemon-secret' },
      });
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('content-length')).toBeNull();
      expect(await response.json()).toMatchObject({ ok: false, error: 'record read failed' });
    } finally {
      await response?.body?.cancel().catch(() => {});
      streams.mockRestore();
    }
  });
});

test('a caller that hangs up mid-download releases the record read stream', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123', Buffer.alloc(LARGE_RECORD_BYTES, 7));
    const createReadStream = fs.createReadStream;
    const streams: Array<{ stream: fs.ReadStream; closed: Promise<void> }> = [];
    const reads = vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
      const stream = createReadStream(file, options);
      // A bare `close` listener: `once(stream, 'close')` would add an `error` listener the
      // route is expected to own.
      streams.push({
        stream,
        closed: new Promise<void>((resolve) => {
          stream.on('close', () => resolve());
        }),
      });
      return stream;
    });
    const url = new URL(diagnosticsUrl(baseUrl, 'default', 'abc123'));
    let status = 0;
    const hungUp = new Promise<void>((resolve) => {
      const request = http.request(
        {
          host: url.hostname,
          port: url.port,
          method: 'GET',
          path: url.pathname,
          headers: { authorization: 'Bearer daemon-secret' },
        },
        (response) => {
          status = response.statusCode ?? 0;
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            // Hang up once the body is clearly under way: the daemon is mid-read here.
            if (received >= 64 * 1024) request.destroy();
          });
          response.on('error', () => {});
          response.on('close', () => resolve());
        },
      );
      request.on('error', () => {});
      request.end();
    });

    try {
      await withIO(hungUp, 'the caller hang-up');
      assert.equal(status, 200);
      const [record] = streams;
      assert.ok(record, 'the route opened the record');
      assert.ok(record.stream.bytesRead > 0, 'the route had started the download');
      await withIO(record.closed, 'the record read stream to close');
      assert.equal(record.stream.destroyed, true);
      // `fd` is a runtime-only ReadStream property: it is the descriptor number while
      // the record is open and null once the descriptor is released.
      const { fd } = record.stream as fs.ReadStream & { fd: number | null };
      assert.equal(fd, null, 'the record fd is released');
    } finally {
      reads.mockRestore();
    }
  });
});

test.for([
  { outcome: 'succeeds', openError: undefined },
  { outcome: 'fails with EACCES', openError: OPEN_DENIED },
])(
  'a caller that hangs up during a record open that then $outcome releases the record',
  async ({ openError }, t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;

    await withDiagnosticsServer(async ({ baseUrl, sessionsDir, server }) => {
      writeRecord(sessionsDir, 'default', 'abc123');
      const held = holdRecordOpens();
      try {
        const caller = requestToAbandon(server, baseUrl);
        await flushUntilDone(() => held.opens.length > 0, 'the route to open the record');
        await caller.hangUp();
        await assertAbandonedRecordCloses(held.opens[0]!, openError);
        caller.assertNothingWritten();
      } finally {
        held.restore();
      }
    });
  },
);

test('a caller gone before the record read stream exists leaves a failed open caught', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir, server }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    const stat = fs.promises.stat;
    let finishStat: (() => void) | undefined;
    const stats = vi.spyOn(fs.promises, 'stat').mockImplementationOnce(async (file) => {
      await new Promise<void>((resolve) => {
        finishStat = resolve;
      });
      return await stat(file);
    });
    const held = holdRecordOpens();
    try {
      const caller = requestToAbandon(server, baseUrl);
      await flushUntilDone(() => finishStat !== undefined, 'the route to stat the record');
      await caller.hangUp();
      assert.equal(held.opens.length, 0, 'the caller left before the read stream existed');
      finishStat?.();
      await flushUntilDone(() => held.opens.length > 0, 'the route to open the record');
      await assertAbandonedRecordCloses(held.opens[0]!, OPEN_DENIED);
      caller.assertNothingWritten();
    } finally {
      held.restore();
      stats.mockRestore();
    }
  });
});

test('request diagnostics route refuses an unauthenticated caller', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    const response = await fetch(diagnosticsUrl(baseUrl, 'default', 'abc123'));
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes('request_start'), false);
  });
});

test('request diagnostics route answers 404 for a record that was never written', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    const auth = { authorization: 'Bearer daemon-secret' };
    const unknownRequest = await fetch(diagnosticsUrl(baseUrl, 'default', 'nope'), {
      headers: auth,
    });
    assert.equal(unknownRequest.status, 404);
    const unknownSession = await fetch(diagnosticsUrl(baseUrl, 'other', 'abc123'), {
      headers: auth,
    });
    assert.equal(unknownSession.status, 404);
  });
});

test('request diagnostics route rejects ids that do not name one record', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    // Sent over a raw request rather than `fetch`: URL parsing resolves `..`
    // away client-side, so only a hand-built request target reaches the daemon
    // with the segment a traversal attempt would actually carry.
    for (const [session, requestId] of [
      ['..', 'abc123'],
      ['default', '..'],
      ['', 'abc123'],
      ['default', ''],
    ] as const) {
      const status = await requestRawStatus(
        baseUrl,
        `/sessions/${session}/requests/${requestId}/diagnostics`,
      );
      assert.equal(status, 400, `expected 400 for session=${session} request=${requestId}`);
    }
  });
});

/**
 * No auth hook is configured on this server, so every tenant here is a
 * client-DECLARED label. `scopeRequestSession` partitions nothing for such a
 * caller, and the same caller can already run any command in any session over
 * `/rpc` (`http-server-tenant-trust.test.ts`, "no hook configured keeps a
 * client-declared flags.tenant unchanged"). The prefix rule that does bite is
 * proven against an ATTESTING hook in that file.
 */
test('request diagnostics route reads an unattested tenant as no session partition', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'tenant-a:default', 'abc123');
    const auth = { authorization: 'Bearer daemon-secret' };
    const owner = await fetch(diagnosticsUrl(baseUrl, 'tenant-a:default', 'abc123'), {
      headers: { ...auth, 'x-agent-device-tenant': 'tenant-a' },
    });
    assert.equal(owner.status, 200);
    const otherTenant = await fetch(diagnosticsUrl(baseUrl, 'tenant-a:default', 'abc123'), {
      headers: { ...auth, 'x-agent-device-tenant': 'tenant-b' },
    });
    assert.equal(otherTenant.status, 200);
  });
});

test('request diagnostics route serves a plain session to the tenant that ran the command', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    const response = await fetch(diagnosticsUrl(baseUrl, 'default', 'abc123'), {
      headers: {
        authorization: 'Bearer daemon-secret',
        'x-agent-device-tenant': 'tenant-a',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), RECORD);
  });
});

test('request diagnostics route serves the cwd-scoped session its owner ran in', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'cwd:9f1:default', 'abc123');
    const response = await fetch(diagnosticsUrl(baseUrl, 'cwd:9f1:default', 'abc123'), {
      headers: {
        authorization: 'Bearer daemon-secret',
        'x-agent-device-tenant': 'tenant-a',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), RECORD);
  });
});

test('request diagnostics route does not serve a tenant that held a macos-app lease, even after it ended', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const leaseRegistry = new LeaseRegistry();
  const leaseId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  leaseRegistry.putHostLease(leaseId, {
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'proxy',
    clientId: 'client-a',
    leaseBackend: 'macos-app',
    deviceKey: 'com.example.app',
  });
  leaseRegistry.releaseLease({
    leaseId,
    tenantId: 'tenant-a',
    runId: 'run-1',
    clientId: 'client-a',
    leaseProvider: 'proxy',
    leaseBackend: 'macos-app',
    deviceKey: 'com.example.app',
  });
  await withDiagnosticsServer(async ({ baseUrl, sessionsDir }) => {
    writeRecord(sessionsDir, 'default', 'abc123');
    const auth = { authorization: 'Bearer daemon-secret' };
    const leased = await fetch(diagnosticsUrl(baseUrl, 'default', 'abc123'), {
      headers: { ...auth, 'x-agent-device-tenant': 'tenant-a' },
    });
    assert.equal(leased.status, 401, await leased.clone().text());
    assert.equal((await leased.text()).includes('request_start'), false);
    const other = await fetch(diagnosticsUrl(baseUrl, 'default', 'abc123'), {
      headers: { ...auth, 'x-agent-device-tenant': 'tenant-b' },
    });
    assert.equal(other.status, 200);
  }, leaseRegistry);
});
