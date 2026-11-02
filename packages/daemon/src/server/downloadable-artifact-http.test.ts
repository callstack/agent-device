import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import * as streamPromises from 'node:stream/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test, vi } from 'vitest';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import * as command from '@agent-device/host-kit/command';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import * as artifactTracking from '../resources/artifact-tracking.ts';
import { createDaemonHttpServer } from './http/http-server.ts';

vi.mock('node:stream/promises', { spy: true });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type DownloadFixture = {
  url: string;
  source: string;
  runtime: ReturnType<typeof createRuntimeStateHandle>;
  streams: fs.ReadStream[];
  start(): void;
  abortClient(): void;
  failResponse(): void;
  outcome(): 'pending' | 'complete' | 'failed';
  cleanupCount(): number;
  closedResponses(): number;
  receivedRequests(): number;
  expire(): void;
  expiryPending(): boolean;
  fireDeadlines(): void;
};

async function withDownloadFixture(
  run: (fixture: DownloadFixture) => Promise<void>,
  configureStream: (stream: fs.ReadStream) => void,
): Promise<void> {
  const root = mkdtempForTestSync('fu-art-pipeline-');
  const source = path.join(root, 'capture.trace');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'payload'), crypto.randomBytes(256 * 1024));
  const runtime = createRuntimeStateHandle();
  const server = await runtime.run(() =>
    createDaemonHttpServer({
      token: 'fu-art-secret',
      handleRequest: async () => ({ ok: true, data: {} }),
      env: process.env,
      cwd: process.cwd(),
    }),
  );
  const port = await listenOnLoopback(server);
  let activeResponse: http.ServerResponse | undefined;
  let closedResponses = 0;
  let receivedRequests = 0;
  server.on('request', (_request, response) => {
    receivedRequests++;
    activeResponse = response;
    response.once('close', () => closedResponses++);
  });
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const clearedTimers = vi.spyOn(globalThis, 'clearTimeout');
  const id = runtime.run(() =>
    artifactTracking.trackDownloadableArtifact({ artifactPath: source, artifactType: 'trace-log' }),
  );
  const expire = timers.mock.calls[0]![0];
  const expiryTimer = timers.mock.results[0]!.value;
  const removed = vi.spyOn(fs, 'rmSync');
  const streams: fs.ReadStream[] = [];
  const createReadStream = fs.createReadStream;
  const reads = vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
    const stream = createReadStream(file, options);
    streams.push(stream);
    configureStream(stream);
    return stream;
  });
  const agent = new http.Agent({ keepAlive: true });
  let request: http.ClientRequest | undefined;
  let outcome: 'pending' | 'complete' | 'failed' = 'pending';
  try {
    await run({
      url: `http://127.0.0.1:${port}/artifacts/${id}`,
      source,
      runtime,
      streams,
      start: () => {
        request = http.get(
          `http://127.0.0.1:${port}/artifacts/${id}`,
          {
            agent,
            headers: { authorization: 'Bearer fu-art-secret' },
          },
          (response) => {
            response.on('end', () => {
              outcome = 'complete';
            });
            response.on('aborted', () => {
              outcome = 'failed';
            });
            response.on('error', () => {
              outcome = 'failed';
            });
            response.resume();
          },
        );
        request.on('error', () => {
          outcome = 'failed';
        });
      },
      abortClient: () => request?.destroy(),
      failResponse: () => activeResponse?.destroy(new Error('injected response failure')),
      outcome: () => outcome,
      closedResponses: () => closedResponses,
      receivedRequests: () => receivedRequests,
      cleanupCount: () => removed.mock.calls.filter(([target]) => target === source).length,
      expire: () => runtime.run(expire),
      expiryPending: () => !clearedTimers.mock.calls.some(([timer]) => timer === expiryTimer),
      fireDeadlines: () => {
        for (const [index, [callback, delay]] of timers.mock.calls.entries()) {
          const handle = timers.mock.results[index]!.value;
          if (
            delay !== 15 * 60 * 1000 ||
            clearedTimers.mock.calls.some(([cleared]) => cleared === handle)
          )
            continue;
          runtime.run(callback);
        }
      },
    });
  } finally {
    request?.destroy();
    agent.destroy();
    for (const stream of streams) {
      if (stream.closed) continue;
      const closed = new Promise<void>((resolve) => stream.once('close', resolve));
      stream.destroy();
      await closed;
    }
    reads.mockRestore();
    timers.mockRestore();
    clearedTimers.mockRestore();
    await closeLoopbackServer(server);
    runtime.dispose();
    removed.mockRestore();
  }
}

test('a completed download finishes its pipeline without aborting', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const pipelines = vi.spyOn(streamPromises, 'pipeline');
  try {
    await withDownloadFixture(
      async (fixture) => {
        const expected = fs.readFileSync(path.join(fixture.source, 'payload'));
        const response = await fetch(fixture.url, {
          headers: { authorization: 'Bearer fu-art-secret' },
        });
        expect(response.status).toBe(200);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes).toHaveLength(Number(response.headers.get('content-length')));
        expect(gunzipSync(bytes).includes(expected)).toBe(true);
        await vi.waitFor(() => expect(fixture.closedResponses()).toBe(1));
        expect(pipelines).toHaveBeenCalledTimes(1);
        await expect(pipelines.mock.results[0]!.value).resolves.toBeUndefined();
        expect(pipelines.mock.calls[0]!.at(-1)).toMatchObject({ signal: { aborted: false } });
        await vi.waitFor(() => expect(fs.existsSync(fixture.source)).toBe(false));
      },
      () => {},
    );
  } finally {
    pipelines.mockRestore();
  }
});

test.each(['lone', 'shared'] as const)(
  'a client abort cancels its preparation during a %s archive build',
  async (kind) => {
    const started = deferred();
    const proceed = deferred();
    let archiveSignal: AbortSignal | undefined;
    let archiveDir = '';
    const runCmd = command.runCmd;
    const archive = vi.spyOn(command, 'runCmd').mockImplementationOnce(async (...args) => {
      archiveSignal = args[2]?.signal;
      archiveDir = path.dirname(String(args[1]?.[1]));
      started.resolve();
      await proceed.promise;
      return await runCmd(...args);
    });
    try {
      await withDownloadFixture(
        async (fixture) => {
          const expected = fs.readFileSync(path.join(fixture.source, 'payload'));
          let second: Promise<Response> | undefined;
          try {
            fixture.start();
            await started.promise;
            if (kind === 'shared') {
              second = fetch(fixture.url, { headers: { authorization: 'Bearer fu-art-secret' } });
              void second.catch(() => {});
              await vi.waitFor(() => expect(fixture.receivedRequests()).toBe(2));
            }
            fixture.abortClient();
            await vi.waitFor(() => expect(fixture.closedResponses()).toBe(1));
            expect(archiveSignal?.aborted).toBe(kind === 'lone');
            proceed.resolve();
            if (second) {
              const response = await second;
              expect(response.status).toBe(200);
              const bytes = Buffer.from(await response.arrayBuffer());
              expect(bytes).toHaveLength(Number(response.headers.get('content-length')));
              expect(gunzipSync(bytes).includes(expected)).toBe(true);
              await vi.waitFor(() => expect(fs.existsSync(fixture.source)).toBe(false));
            } else {
              await vi.waitFor(() => expect(fs.existsSync(archiveDir)).toBe(false));
              expect(fs.existsSync(fixture.source)).toBe(true);
            }
            expect(fixture.streams).toHaveLength(kind === 'shared' ? 1 : 0);
            expect(archive).toHaveBeenCalledTimes(1);
          } finally {
            proceed.resolve();
            await Promise.allSettled(second ? [second] : []);
          }
        },
        () => {},
      );
    } finally {
      proceed.resolve();
      archive.mockRestore();
    }
  },
);

test.each(['destroyed', 'truncated', 'errored'] as const)(
  'a %s artifact read terminates the HTTP response',
  async (failure) => {
    await withDownloadFixture(
      async (fixture) => {
        fixture.start();
        await vi.waitFor(() => expect(fixture.outcome()).toBe('failed'));
        fixture.expire();
        await vi.waitFor(() => expect(fs.existsSync(fixture.source)).toBe(false));
        expect(fixture.cleanupCount()).toBe(1);
      },
      (stream) => {
        if (failure === 'truncated') {
          stream.once('open', () =>
            fs.truncateSync(String(stream.path), fs.statSync(String(stream.path)).size - 1),
          );
        } else {
          let chunks = 0;
          stream.on('data', () => {
            if (++chunks === 2)
              stream.destroy(
                failure === 'errored' ? new Error('injected read failure') : undefined,
              );
          });
        }
      },
    );
  },
);

test('an artifact open failure returns a complete JSON error before streaming starts', async () => {
  await withDownloadFixture(
    async (fixture) => {
      const response = await fetch(fixture.url, {
        headers: { authorization: 'Bearer fu-art-secret' },
      });
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toMatchObject({ ok: false });
      fixture.expire();
      await vi.waitFor(() => expect(fs.existsSync(fixture.source)).toBe(false));
    },
    (stream) => fs.unlinkSync(String(stream.path)),
  );
});

test('a truncated directory archive preserves the source and expires without leaking its cached archive', async () => {
  await withDownloadFixture(
    async (fixture) => {
      const payloadPath = path.join(fixture.source, 'payload');
      const expected = fs.readFileSync(payloadPath);
      fixture.start();
      await vi.waitFor(() => expect(fixture.outcome()).toBe('failed'));
      const stream = fixture.streams[0]!;
      await vi.waitFor(() => expect(stream.closed).toBe(true));
      const archiveDir = path.dirname(String(stream.path));
      expect(fs.readFileSync(payloadPath)).toEqual(expected);
      expect(fs.existsSync(archiveDir)).toBe(true);
      expect(fixture.expiryPending()).toBe(true);
      const inventory = await fetch(fixture.url.slice(0, fixture.url.lastIndexOf('/')), {
        headers: { authorization: 'Bearer fu-art-secret' },
      });
      expect(await inventory.json()).toMatchObject({
        artifacts: [{ id: fixture.url.split('/').at(-1) }],
      });
      fixture.expire();
      await vi.waitFor(() => expect(fs.existsSync(fixture.source)).toBe(false));
      expect(fs.existsSync(archiveDir)).toBe(false);
      expect(fixture.cleanupCount()).toBe(1);
    },
    (stream) =>
      stream.once('open', () =>
        fs.truncateSync(String(stream.path), fs.statSync(String(stream.path)).size - 1),
      ),
  );
});

test.each(['deadline', 'runtime disposal'] as const)(
  '%s cancels an active download and removes its files',
  async (trigger) => {
    const started = deferred();
    await withDownloadFixture(
      async (fixture) => {
        fixture.start();
        await started.promise;
        if (trigger === 'deadline') fixture.fireDeadlines();
        else fixture.runtime.dispose();
        await vi.waitFor(() => expect(fixture.outcome()).toBe('failed'));
        await vi.waitFor(() => expect(fs.existsSync(fixture.source)).toBe(false));
        expect(fixture.streams.every((stream) => stream.closed)).toBe(true);
        expect(fixture.cleanupCount()).toBe(1);
        for (const stream of fixture.streams) {
          expect(fs.existsSync(path.dirname(String(stream.path)))).toBe(false);
        }
      },
      (stream) =>
        stream.once('data', () => {
          stream.pause();
          started.resolve();
        }),
    );
  },
);

test.each(['client abort', 'response error'] as const)(
  '%s releases an active download before expiry cleanup',
  async (failure) => {
    const started = deferred();
    await withDownloadFixture(
      async (fixture) => {
        fixture.start();
        await started.promise;
        if (failure === 'client abort') fixture.abortClient();
        else fixture.failResponse();
        await vi.waitFor(() => expect(fixture.outcome()).toBe('failed'));
        fixture.expire();
        await vi.waitFor(() => expect(fs.existsSync(fixture.source)).toBe(false));
        expect(fixture.cleanupCount()).toBe(1);
      },
      (stream) =>
        stream.once('data', () => {
          stream.pause();
          started.resolve();
        }),
    );
  },
);

test('a directory artifact expires after download header setup throws', async () => {
  const root = mkdtempForTestSync('fu-art-header-error-');
  const source = path.join(root, 'profile.trace');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'payload'), 'trace payload');
  const runtime = createRuntimeStateHandle();
  const server = await runtime.run(() =>
    createDaemonHttpServer({
      token: 'fu-art-secret',
      handleRequest: async () => ({ ok: true, data: {} }),
      env: process.env,
      cwd: process.cwd(),
    }),
  );
  const port = await listenOnLoopback(server);
  const timer = vi.spyOn(globalThis, 'setTimeout');
  const artifactId = runtime.run(() =>
    artifactTracking.trackDownloadableArtifact({
      artifactPath: source,
      artifactType: 'trace-log',
      fileName: 'trace-💥',
    }),
  );
  const expire = timer.mock.calls[0]![0];
  timer.mockRestore();
  const streams = vi.spyOn(fs, 'createReadStream');
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/artifacts/${artifactId}`, {
      headers: { authorization: 'Bearer fu-art-secret' },
      signal: controller.signal,
    });
    expect(response.status).toBe(500);
    let body: unknown;
    const consumed = response.json().then((value: unknown) => {
      body = value;
    });
    void consumed.catch(() => {});
    await vi.waitFor(() => expect(body).toMatchObject({ ok: false }));
    await consumed;
    const stream = streams.mock.results[0]!.value as fs.ReadStream;
    const archiveDir = path.dirname(String(stream.path));
    runtime.run(expire);
    await vi.waitFor(() => expect(fs.existsSync(source)).toBe(false));
    expect(stream.closed).toBe(true);
    expect(fs.existsSync(archiveDir)).toBe(false);
  } finally {
    controller.abort();
    for (const result of streams.mock.results) {
      const stream = result.value as fs.ReadStream;
      if (stream.closed) continue;
      const closed = new Promise<void>((resolve) => stream.once('close', resolve));
      stream.destroy();
      await closed;
    }
    streams.mockRestore();
    await closeLoopbackServer(server);
    runtime.dispose();
  }
});

test.each(['another download completes', 'expiry fires'] as const)(
  'a directory download keeps its archive until its delayed file open finishes when %s',
  async (trigger) => {
    const root = mkdtempForTestSync('fu-art-download-');
    const source = path.join(root, 'profile.trace');
    fs.mkdirSync(source);
    const expected = crypto.randomBytes(64 * 1024).toString('hex');
    fs.writeFileSync(path.join(source, 'payload'), expected);
    const runtime = createRuntimeStateHandle();
    const server = await runtime.run(() =>
      createDaemonHttpServer({
        token: 'fu-art-secret',
        handleRequest: async () => ({ ok: true, data: {} }),
        env: process.env,
        cwd: process.cwd(),
      }),
    );
    const port = await listenOnLoopback(server);
    const headers = { authorization: 'Bearer fu-art-secret' };
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const artifactId = runtime.run(() =>
      artifactTracking.trackDownloadableArtifact({
        artifactPath: source,
        artifactType: 'trace-log',
      }),
    );
    const expire = timer.mock.calls[0]![0];
    timer.mockRestore();
    const url = `http://127.0.0.1:${port}/artifacts/${artifactId}`;
    const opened = deferred();
    const release = deferred();
    const createReadStream = fs.createReadStream;
    const cleanup = vi.spyOn(fs, 'rmSync');
    let archivePath = '';
    const streams: fs.ReadStream[] = [];
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
      archivePath = String(file);
      const stream = createReadStream(file, {
        ...(typeof options === 'object' ? options : {}),
        fs: {
          ...fs,
          open: (filePath, flags, mode, callback) => {
            opened.resolve();
            void release.promise.then(() => fs.open(filePath, flags, mode, callback));
          },
        },
      });
      streams.push(stream);
      return stream;
    });
    const download = () =>
      fetch(url, { headers }).then(async (response) => {
        if (response.status !== 200) {
          await response.body?.cancel();
          return { status: response.status, bytes: Buffer.alloc(0) };
        }
        return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
      });
    const pending = download();
    try {
      await opened.promise;
      spy.mockRestore();
      let first: Awaited<ReturnType<typeof download>> | undefined;
      if (trigger === 'another download completes') {
        first = await download();
        expect(first.status).toBe(200);
      } else {
        runtime.run(expire);
      }
      const archiveDir = path.dirname(archivePath);
      expect(fs.existsSync(archivePath)).toBe(true);
      expect(fs.existsSync(source)).toBe(true);
      expect((await fetch(url, { headers })).status).toBe(404);
      const inventory = await fetch(`http://127.0.0.1:${port}/artifacts`, { headers });
      expect(await inventory.json()).toEqual({ artifacts: [] });
      release.resolve();
      const delayed = await pending;
      expect(delayed.status).toBe(200);
      if (first) expect(delayed.bytes).toEqual(first.bytes);
      const downloaded = path.join(root, 'download.tar.gz');
      fs.writeFileSync(downloaded, delayed.bytes);
      expect(command.runCmdSync('tar', ['-xOzf', downloaded, 'profile.trace/payload']).stdout).toBe(
        expected,
      );
      await vi.waitFor(() => expect(fs.existsSync(archiveDir)).toBe(false));
      expect(fs.existsSync(source)).toBe(false);
      for (const target of [source, archiveDir]) {
        expect(cleanup.mock.calls.filter(([removed]) => removed === target)).toHaveLength(1);
      }
    } finally {
      release.resolve();
      spy.mockRestore();
      cleanup.mockRestore();
      for (const stream of streams) stream.destroy();
      await Promise.allSettled([pending]);
      await closeLoopbackServer(server);
      runtime.dispose();
    }
  },
);
