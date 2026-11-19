import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { expect, test, vi } from 'vitest';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import { ANDROID_SNAPSHOT_HELPER_PROTOCOL } from '../snapshot-helper-types.ts';
import {
  getLiveAndroidSnapshotHelperSession,
  stopAndroidSnapshotHelperSession,
} from '../snapshot-helper-session-lifecycle.ts';
import {
  ANDROID_SNAPSHOT_HELPER_SESSION_MAX_COMMAND_BYTES,
  sendAndroidSnapshotHelperSessionCommand,
} from '../snapshot-helper-session-protocol.ts';
import { runAndroidSnapshotHelperSessionTouchCommand } from '../snapshot-helper-session.ts';
import { mkdtempForTest } from './test-utils/tmp-dir.ts';

vi.mock('../snapshot-helper-session-lifecycle.ts', () => ({
  getLiveAndroidSnapshotHelperSession: vi.fn(),
  stopAndroidSnapshotHelperSession: vi.fn(),
}));

// The real max-command-bytes constant owns this scenario; only dispatch is doubled.
vi.mock('../snapshot-helper-session-protocol.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../snapshot-helper-session-protocol.ts')>()),
  sendAndroidSnapshotHelperSessionCommand: vi.fn(),
}));

const HELPER = { packageName: 'snapshot-helper', runner: 'runner' };
const DEVICE_KEY = 'android:emulator-fixture';

function mockLiveHelperSession(): void {
  vi.mocked(getLiveAndroidSnapshotHelperSession).mockResolvedValue({
    helper: HELPER,
    port: 1234,
  } as NonNullable<Awaited<ReturnType<typeof getLiveAndroidSnapshotHelperSession>>>);
}

function runTouchCommand(payloadBase64: string) {
  return runAndroidSnapshotHelperSessionTouchCommand({
    deviceKey: DEVICE_KEY,
    action: 'input',
    helper: HELPER,
    payloadBase64,
    timeoutMs: 2_000,
  });
}

// A frame larger than any documented producer: the payload alone fills the cap, and the action and
// request id push the frame past it.
const OVER_LIMIT_PAYLOAD = 'A'.repeat(ANDROID_SNAPSHOT_HELPER_SESSION_MAX_COMMAND_BYTES);

test('an oversized input frame skips session dispatch and leaves the live helper available', async () => {
  mockLiveHelperSession();

  await expect(runTouchCommand(OVER_LIMIT_PAYLOAD)).resolves.toBeUndefined();
  // The action and request ID also occupy bytes in the frame.
  expect(sendAndroidSnapshotHelperSessionCommand).not.toHaveBeenCalled();
  expect(stopAndroidSnapshotHelperSession).not.toHaveBeenCalled();
});

test('declining an over-limit frame answers one fitting frame and keeps the session for the next', async () => {
  mockLiveHelperSession();
  vi.mocked(sendAndroidSnapshotHelperSessionCommand).mockImplementation(async (_port, command) => {
    const [, requestId = ''] = command.split(' ', 2);
    return [
      `agentDeviceProtocol=${ANDROID_SNAPSHOT_HELPER_PROTOCOL}`,
      `requestId=${requestId}`,
      'ok=true',
      '',
      '',
    ].join('\n');
  });

  await expect(runTouchCommand(OVER_LIMIT_PAYLOAD)).resolves.toBeUndefined();
  const headers = await runTouchCommand(
    Buffer.from(JSON.stringify({ kind: 'tap', x: 1, y: 2 })).toString('base64'),
  );

  expect(headers).toMatchObject({ ok: 'true' });
  expect(sendAndroidSnapshotHelperSessionCommand).toHaveBeenCalledTimes(1);
  expect(stopAndroidSnapshotHelperSession).not.toHaveBeenCalled();
});

test('declining an over-limit frame records a warn diagnostic with the frame size and the cap', async () => {
  mockLiveHelperSession();
  const tmpDir = await mkdtempForTest('android-session-command-decline-');
  const logPath = path.join(tmpDir, 'diag.ndjson');
  try {
    await withDiagnosticsScope(
      { debug: true, logPath, session: 'android-test', requestId: 'req-1', command: 'fill' },
      async () => {
        await expect(runTouchCommand(OVER_LIMIT_PAYLOAD)).resolves.toBeUndefined();
      },
    );

    // No diagnostic means no log file at all: that is the decline going unrecorded.
    const log = await fs.readFile(logPath, 'utf8').catch(() => '');
    const declined = log
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { level?: string; phase?: string; data?: Record<string, unknown> },
      )
      .find((event) => event.phase === 'android_snapshot_helper_session_command_declined');
    assert.ok(declined, 'expected a session command decline diagnostic');
    assert.equal(declined.level, 'warn');
    assert.equal(declined.data?.reason, 'android_snapshot_helper_session_command_too_large');
    assert.equal(declined.data?.deviceKey, DEVICE_KEY);
    assert.equal(declined.data?.action, 'input');
    assert.equal(declined.data?.maxCommandBytes, ANDROID_SNAPSHOT_HELPER_SESSION_MAX_COMMAND_BYTES);
    const commandBytes = declined.data?.commandBytes;
    assert.equal(typeof commandBytes, 'number');
    assert.ok(
      (commandBytes as number) > ANDROID_SNAPSHOT_HELPER_SESSION_MAX_COMMAND_BYTES,
      'the recorded frame is larger than the cap it was declined for',
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
