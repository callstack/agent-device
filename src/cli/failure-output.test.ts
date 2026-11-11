import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync, withCapturedStderrAsync } from '@agent-device/test-kit';
import { printHumanError } from './failure-output.ts';

test('printHumanError writes a body-less failure as its one summary line', async () => {
  const stderr = await withCapturedStderrAsync(async () => {
    await printHumanError(
      new AppError('COMMAND_FAILED', 'Could not reach the app', { hint: 'Open the app first.' }),
    );
  });

  assert.equal(
    stderr,
    'Error (COMMAND_FAILED): Could not reach the app. Next: Open the app first.\n',
  );
});

// Callers merge stderr into stdout and keep `tail -1` or `head -1`; both must be the summary.
test('printHumanError closes a multi-line failure with the same summary line', async () => {
  const stderr = await withCapturedStderrAsync(async () => {
    await printHumanError(
      new AppError('COMMAND_FAILED', 'boom', { logPath: '/tmp/req.ndjson', dispatched: 'unknown' }),
    );
  });

  const lines = stderr.trimEnd().split('\n');
  assert.deepEqual(lines, [
    'Error (COMMAND_FAILED): boom. May have reached the device. Next: Run snapshot to check the screen before you retry. Read the diagnostics log for the failing step.',
    'Log: /tmp/req.ndjson',
    'Error (COMMAND_FAILED): boom. May have reached the device. Next: Run snapshot to check the screen before you retry. Read the diagnostics log for the failing step.',
  ]);
});

test.each(['.', '..'])(
  'printHumanError preserves the command failure for invalid remote session %s',
  async (session) => {
    const stateDir = mkdtempForTestSync('failure-output-invalid-record-');
    const outside = path.join(
      stateDir,
      ...(session === '.' ? ['remote-diagnostics'] : []),
      'requests',
      'abc123.ndjson',
    );
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'private outside record');
    const stderr = await withCapturedStderrAsync(async () => {
      await printHumanError(new AppError('COMMAND_FAILED', 'Original command failed'), {
        debugTier: true,
        logTail: {
          daemonBaseUrl: 'https://remote.example.test',
          daemonPaths: { baseDir: stateDir, logPath: path.join(stateDir, 'daemon.log') },
          record: { session, requestId: 'abc123' },
        },
      });
    });
    assert.ok(stderr.startsWith('Error (COMMAND_FAILED): Original command failed'));
    assert.equal(stderr.includes('private outside record'), false);
    assert.equal(stderr.includes('[remote diagnostics]'), false);
  },
);

test.each(['local', 'remote'] as const)(
  'printHumanError includes available %s diagnostics',
  async (source) => {
    const stateDir = mkdtempForTestSync('failure-output-valid-record-');
    const logPath = path.join(stateDir, 'daemon.log');
    const recordPath =
      source === 'local'
        ? logPath
        : path.join(stateDir, 'remote-diagnostics', 'valid-session', 'requests', 'abc123.ndjson');
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, 'original failure evidence\n');
    const stderr = await withCapturedStderrAsync(async () => {
      await printHumanError(new AppError('COMMAND_FAILED', 'Original command failed'), {
        debugTier: true,
        logTail: {
          daemonBaseUrl: source === 'remote' ? 'https://remote.example.test' : undefined,
          daemonPaths: { baseDir: stateDir, logPath },
          record: { session: 'valid-session', requestId: 'abc123' },
        },
      });
    });
    assert.ok(stderr.startsWith('Error (COMMAND_FAILED): Original command failed'));
    assert.ok(stderr.includes(`[${source === 'local' ? 'daemon log' : 'remote diagnostics'}]`));
    assert.ok(stderr.includes('original failure evidence'));
  },
);
