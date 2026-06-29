import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '../kernel/errors.ts';
import { runCliCapture, type CapturedCliRun } from './cli-capture.ts';

function runCliWithDaemonStartupFailure(argv: string[]): Promise<CapturedCliRun> {
  return runCliCapture(argv, async () => {
    throw new AppError('COMMAND_FAILED', 'Failed to start daemon', {
      infoPath: '/tmp/daemon.json',
      hint: 'stale daemon info',
    });
  });
}

async function runCliCaptureWithErrorDetails(
  argv: string[],
  details: Record<string, unknown>,
  message = 'Failed to start daemon',
): Promise<CapturedCliRun> {
  return runCliCapture(argv, async () => {
    throw new AppError('COMMAND_FAILED', message, details);
  });
}

test('close treats daemon startup failure as no-op', async () => {
  const result = await runCliWithDaemonStartupFailure(['close']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('close --json treats daemon startup failure as no-op success', async () => {
  const result = await runCliWithDaemonStartupFailure(['close', '--json']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, true);
  assert.equal(payload.data.closed, 'session');
  assert.equal(payload.data.source, 'no-daemon');
  assert.equal(result.stderr, '');
});

test('close treats lock-only daemon startup failure as no-op', async () => {
  const result = await runCliCaptureWithErrorDetails(['close'], {
    lockPath: '/tmp/daemon.lock',
    hint: 'stale daemon lock',
  });
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('close treats structured daemon startup failure as no-op without relying on message text', async () => {
  const result = await runCliCaptureWithErrorDetails(
    ['close'],
    {
      kind: 'daemon_startup_failed',
      lockPath: '/tmp/daemon.lock',
    },
    'daemon bootstrap failed',
  );
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('close --shutdown is accepted as a valid flag', async () => {
  const result = await runCliWithDaemonStartupFailure(['close', '--shutdown']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('close --shutdown --json treats daemon startup failure as no-op success', async () => {
  const result = await runCliWithDaemonStartupFailure(['close', '--shutdown', '--json']);
  assert.equal(result.code, null);
  assert.equal(result.calls.length, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.success, true);
  assert.equal(payload.data.closed, 'session');
  assert.equal(payload.data.source, 'no-daemon');
  assert.equal(result.stderr, '');
});
