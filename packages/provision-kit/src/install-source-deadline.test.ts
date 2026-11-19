import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import * as archive from '@agent-device/host-kit/archive';
import { isTransferPhaseTimeoutError } from '@agent-device/host-kit/transport';
import {
  SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS,
  materializeInstallablePath,
} from './install-source.ts';
import * as networkTransport from './install-source-network-transport.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

// The materialization aggregate and the transfer phase watchdog both run on faked timers, an
// independent deadline clock, while the mocked transport and real stream/IO work run on real
// macrotasks.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushRealIOMacrotasks(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function mockApprovedLookup(): () => void {
  const lookup = vi
    .spyOn(dns, 'lookup')
    .mockImplementation(
      async () =>
        [{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<
          ReturnType<typeof dns.lookup>
        >,
    );
  return () => lookup.mockRestore();
}

function urlSource(): { kind: 'url'; url: string } {
  return { kind: 'url', url: 'https://example.com/app.apk' };
}

const APK_MATCHER = {
  isInstallablePath: (candidatePath: string, stat: { isFile(): boolean }) =>
    stat.isFile() && candidatePath.endsWith('.apk'),
  installableLabel: 'Android installable (.apk or .aab)',
};

test('the standalone materialization aggregate is the adopted finite 600s budget', () => {
  assert.equal(SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS, 600_000);
});

test('a standalone materialization that keeps progressing still expires at the 600s aggregate', async () => {
  const tempRoot = await mkdtempForTest('agent-device-materialize-aggregate-');
  const restoreLookup = mockApprovedLookup();
  const body = new PassThrough();
  const requestMock = vi
    .spyOn(networkTransport, 'requestApprovedUrl')
    .mockImplementation(async () => ({
      statusCode: 200,
      headers: {},
      body,
      close: async () => {},
    }));
  // The aggregate is armed through AbortSignal.timeout at entry; capture its signal so the
  // control clock can expire it independently of the faked phase-timer clock.
  const aggregate = new AbortController();
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    assert.equal(ms, SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS);
    return aggregate.signal;
  });
  try {
    const outcome = materializeInstallablePath({
      source: urlSource(),
      ...APK_MATCHER,
      environment: process.env,
    }).catch((error: unknown) => error);
    await flushRealIOMacrotasks();
    // Steady body progress every 60s of phase-clock time: no phase ceiling fires, but the
    // aggregate still ends the download.
    for (
      let elapsed = 0;
      elapsed < SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS;
      elapsed += 60_000
    ) {
      body.write('chunk');
      await flushRealIOMacrotasks();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    aggregate.abort(new DOMException('This operation timed out', 'TimeoutError'));
    const error = await outcome;
    assert.ok(error instanceof AppError, 'aggregate expiry must stay a typed AppError');
    assert.equal(isTransferPhaseTimeoutError(error), false, 'the aggregate is not a phase timer');
    assert.equal(
      isRequestCanceledError(error),
      false,
      'aggregate expiry is not caller cancellation',
    );
    assert.deepEqual(error.details, {
      reason: 'source_materialization_deadline_exceeded',
      transferPhase: 'materialization',
      timeoutMs: SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS,
    });
    assert.ok(error.cause instanceof Error, 'the underlying failure stays attached as cause');
  } finally {
    timeoutSpy.mockRestore();
    requestMock.mockRestore();
    restoreLookup();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('an earlier caller deadline wins over the 600s aggregate and stays typed cancellation', async () => {
  const tempRoot = await mkdtempForTest('agent-device-materialize-caller-cap-');
  const restoreLookup = mockApprovedLookup();
  const requestMock = vi.spyOn(networkTransport, 'requestApprovedUrl').mockImplementation(
    (args) =>
      new Promise<never>((_resolve, reject) => {
        args.signal.addEventListener('abort', () => reject(args.signal.reason), {
          once: true,
        });
      }),
  );
  const caller = new AbortController();
  setTimeout(() => caller.abort(createRequestCanceledError()), 1_000);
  try {
    const outcome = materializeInstallablePath({
      source: urlSource(),
      ...APK_MATCHER,
      signal: caller.signal,
      environment: process.env,
    }).catch((error: unknown) => error);
    await flushRealIOMacrotasks();
    await vi.advanceTimersByTimeAsync(1_001);
    const error = await outcome;
    assert.ok(isRequestCanceledError(error), 'caller cancellation must stay typed cancellation');
    // The aggregate must not replace or outlive the caller's earlier cutoff.
    await vi.advanceTimersByTimeAsync(SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS);
    assert.ok(isRequestCanceledError(error));
  } finally {
    requestMock.mockRestore();
    restoreLookup();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('an already-aborted caller signal fails materialization fast as typed cancellation', async () => {
  const restoreLookup = mockApprovedLookup();
  const requestMock = vi.spyOn(networkTransport, 'requestApprovedUrl');
  const caller = new AbortController();
  caller.abort(createRequestCanceledError());
  try {
    const error = await materializeInstallablePath({
      source: urlSource(),
      ...APK_MATCHER,
      signal: caller.signal,
      environment: process.env,
    }).catch((error: unknown) => error);
    assert.ok(isRequestCanceledError(error));
    assert.equal(requestMock.mock.calls.length, 0, 'no network work may start after cancellation');
  } finally {
    requestMock.mockRestore();
    restoreLookup();
  }
});

test('a DNS approval stall reports the connect phase timeout', async () => {
  let releaseLookup!: (error: Error) => void;
  const pending = new Promise<Awaited<ReturnType<typeof dns.lookup>>>((_resolve, reject) => {
    releaseLookup = reject;
  });
  const lookup = vi.spyOn(dns, 'lookup').mockReturnValue(pending);
  try {
    const outcome = materializeInstallablePath({
      source: urlSource(),
      ...APK_MATCHER,
      environment: process.env,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => assert.equal(lookup.mock.calls.length, 1));
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await outcome;
    assert.ok(error instanceof AppError);
    assert.deepEqual(error.details, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'connect',
      timeoutMs: 30_000,
    });
  } finally {
    releaseLookup(new Error('lookup fixture released'));
    lookup.mockRestore();
  }
});

test('a connect phase timeout survives caller cancellation during failure propagation', async () => {
  const restoreLookup = mockApprovedLookup();
  const caller = new AbortController();
  const requester = vi.spyOn(networkTransport, 'requestApprovedUrl').mockImplementation(
    ({ signal }) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            caller.abort(createRequestCanceledError());
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  );
  try {
    const outcome = materializeInstallablePath({
      source: urlSource(),
      ...APK_MATCHER,
      signal: caller.signal,
      environment: process.env,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => assert.equal(requester.mock.calls.length, 1));
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await outcome;
    assert.ok(isTransferPhaseTimeoutError(error));
  } finally {
    requester.mockRestore();
    restoreLookup();
  }
});

test.for(['during extraction', 'after resolution', 'after cutoff before timer delivery'] as const)(
  'materialization refuses and cleans up an archive when the aggregate expires %s',
  async (expiry) => {
    const tempRoot = await mkdtempForTest('agent-device-materialize-extraction-cap-');
    const archivePath = path.join(tempRoot, 'bundle.zip');
    await fs.writeFile(archivePath, 'owned archive fixture');
    const aggregate = new AbortController();
    const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(aggregate.signal);
    const now = vi.spyOn(performance, 'now');
    let outputRoot: string | undefined;
    const extract = vi
      .spyOn(archive, 'extractArchiveSafely')
      .mockImplementation(async (options) => {
        outputRoot = options.outputRoot;
        await fs.mkdir(outputRoot, { recursive: true });
        await fs.writeFile(path.join(outputRoot, 'app.apk'), 'owned app fixture');
        if (expiry === 'during extraction') {
          aggregate.abort(new DOMException('This operation timed out', 'TimeoutError'));
          options.signal?.throwIfAborted();
        }
      });
    try {
      const error = await materializeInstallablePath({
        source: { kind: 'path', path: archivePath },
        ...APK_MATCHER,
        isInstallablePath: (candidate, stat) => {
          if (!APK_MATCHER.isInstallablePath(candidate, stat)) return false;
          if (expiry === 'after resolution') {
            aggregate.abort(new DOMException('This operation timed out', 'TimeoutError'));
          }
          if (expiry === 'after cutoff before timer delivery') {
            now.mockReturnValue(performance.now() + SOURCE_MATERIALIZATION_AGGREGATE_TIMEOUT_MS);
          }
          return true;
        },
        environment: process.env,
      }).catch((error: unknown) => error);
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'source_materialization_deadline_exceeded');
      assert.ok(outputRoot);
      await assert.rejects(fs.stat(outputRoot), { code: 'ENOENT' });
      assert.equal(await fs.readFile(archivePath, 'utf8'), 'owned archive fixture');
    } finally {
      extract.mockRestore();
      now.mockRestore();
      timer.mockRestore();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);
