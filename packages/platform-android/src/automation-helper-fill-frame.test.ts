import { beforeEach, expect, test, vi } from 'vitest';

const SESSION_HELPER = { packageName: 'snapshot-helper', runner: 'runner' };

vi.mock('./snapshot-helper-session-lifecycle.ts', () => ({
  getLiveAndroidSnapshotHelperSession: vi.fn(async () => ({
    helper: SESSION_HELPER,
    port: 1234,
    commands: new Set(['input']),
  })),
  stopAndroidSnapshotHelperSession: vi.fn(),
}));
vi.mock('./automation-helper-artifact.ts', () => ({
  prepareAndroidAutomationHelper: vi.fn(async () => ({ artifact: {} })),
  androidAutomationHelperIdentity: vi.fn(() => SESSION_HELPER),
}));
// The real encoder, frame builder and byte cap own this scenario; only the socket is doubled.
vi.mock('./snapshot-helper-session-protocol.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./snapshot-helper-session-protocol.ts')>()),
  sendAndroidSnapshotHelperSessionCommand: vi.fn(),
}));
import { runAndroidAutomationHelper } from './automation-helper.ts';
import { stopAndroidSnapshotHelperSession } from './snapshot-helper-session-lifecycle.ts';
import { ANDROID_SNAPSHOT_HELPER_PROTOCOL } from './snapshot-helper-types.ts';
import {
  ANDROID_SNAPSHOT_HELPER_SESSION_MAX_COMMAND_BYTES,
  sendAndroidSnapshotHelperSessionCommand,
} from './snapshot-helper-session-protocol.ts';
import { ANDROID_EMULATOR } from './__tests__/test-utils/device-fixtures.ts';

// The `fill --text-stdin` contract accepts this many raw UTF-8 bytes (fill-text-stdin.ts).
const FILL_TEXT_STDIN_MAX_BYTES = 64 * 1024;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendAndroidSnapshotHelperSessionCommand).mockImplementation(async (_port, command) => {
    const requestId = command.split(' ')[1];
    return `agentDeviceProtocol=${ANDROID_SNAPSHOT_HELPER_PROTOCOL}\nrequestId=${requestId}\nok=true\n\n`;
  });
});

test('a maximum-size fill of JSON-escaped control characters fits one session frame', async () => {
  // U+001E is one UTF-8 byte that JSON.stringify writes as six (\u001e), the worst expansion an
  // accepted stdin value can reach before Base64 adds another third.
  const text = '\u001e'.repeat(FILL_TEXT_STDIN_MAX_BYTES);
  expect(Buffer.byteLength(text)).toBe(FILL_TEXT_STDIN_MAX_BYTES);

  await expect(
    runAndroidAutomationHelper(ANDROID_EMULATOR, {
      action: 'input',
      input: { kind: 'fill', x: 10, y: 20, text },
    }),
  ).resolves.toBe(true);

  expect(sendAndroidSnapshotHelperSessionCommand).toHaveBeenCalledTimes(1);
  const [, command] = vi.mocked(sendAndroidSnapshotHelperSessionCommand).mock.calls[0]!;
  expect(Buffer.byteLength(command)).toBeLessThanOrEqual(
    ANDROID_SNAPSHOT_HELPER_SESSION_MAX_COMMAND_BYTES,
  );
  const payload = JSON.parse(Buffer.from(command.split(' ')[2]!, 'base64').toString('utf8'));
  expect(payload).toMatchObject({ kind: 'fill', x: 10, y: 20, text });
  expect(stopAndroidSnapshotHelperSession).not.toHaveBeenCalled();
});
