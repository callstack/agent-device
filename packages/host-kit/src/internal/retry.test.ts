import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { retryWithPolicy } from './retry.ts';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from './diagnostics.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

test('retryWithPolicy retries until success', async () => {
  let attempts = 0;
  const result = await retryWithPolicy(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('transient');
      }
      return 'ok';
    },
    { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('retryWithPolicy can wake one scheduled retry from a readiness signal', async () => {
  vi.useFakeTimers();
  try {
    const readiness = new AbortController();
    let attempts = 0;
    const result = retryWithPolicy(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('not ready');
        return 'ok';
      },
      { maxAttempts: 2, baseDelayMs: 10_000, maxDelayMs: 10_000, jitter: 0 },
      { retryWakeSignal: readiness.signal },
    );

    await Promise.resolve();
    assert.equal(attempts, 1);
    readiness.abort();
    assert.equal(await result, 'ok');
    assert.equal(attempts, 2);
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test('retryWithPolicy preserves cancellation while waiting for a retry wake', async () => {
  vi.useFakeTimers();
  try {
    const cancellation = new AbortController();
    const readiness = new AbortController();
    const result = retryWithPolicy(
      async () => {
        throw new Error('not ready');
      },
      { maxAttempts: 2, baseDelayMs: 10_000, maxDelayMs: 10_000, jitter: 0 },
      { signal: cancellation.signal, retryWakeSignal: readiness.signal },
    );

    await Promise.resolve();
    cancellation.abort();
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'request_canceled');
      return true;
    });
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    vi.useRealTimers();
  }
});

test('retryWithPolicy emits telemetry events', async () => {
  const events: string[] = [];
  await retryWithPolicy(
    async ({ attempt }) => {
      if (attempt === 1) throw new Error('transient');
      return 'ok';
    },
    { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
    {
      phase: 'boot',
      classifyReason: () => 'ANDROID_BOOT_TIMEOUT',
      onEvent: (event) => events.push(event.event),
    },
  );
  assert.deepEqual(events, ['attempt_failed', 'retry_scheduled', 'succeeded']);
});

test('retryWithPolicy publishes retry diagnostics events', async () => {
  const previousHome = process.env.HOME;
  const tempHome = mkdtempForTestSync('agent-device-retry-home-');
  process.env.HOME = tempHome;
  try {
    const outPath = await withDiagnosticsScope(
      {
        session: 'retry-session',
        requestId: 'retry-1',
        command: 'boot',
      },
      async () => {
        await retryWithPolicy(
          async ({ attempt }) => {
            if (attempt === 1) throw new Error('transient');
            return 'ok';
          },
          { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: 0 },
        );
        return flushDiagnosticsToSessionFile({ force: true })?.path;
      },
    );
    assert.ok(outPath);
    const rows = fs
      .readFileSync(outPath as string, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      rows.some((row) => row.phase === 'retry'),
      true,
    );
  } finally {
    process.env.HOME = previousHome;
  }
});
