import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryWithPolicy } from '../retry.ts';
import { flushDiagnosticsToSessionFile, withDiagnosticsScope } from '../diagnostics.ts';

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
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-retry-home-'));
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
        return flushDiagnosticsToSessionFile({ force: true });
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
