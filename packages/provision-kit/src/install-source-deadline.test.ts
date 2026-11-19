import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, vi } from 'vitest';
import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
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
