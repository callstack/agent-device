import { expect, test, vi } from 'vitest';
import {
  getLiveAndroidSnapshotHelperSession,
  stopAndroidSnapshotHelperSession,
} from '../snapshot-helper-session-lifecycle.ts';
import { sendAndroidSnapshotHelperSessionCommand } from '../snapshot-helper-session-protocol.ts';
import { runAndroidSnapshotHelperSessionTouchCommand } from '../snapshot-helper-session.ts';

vi.mock('../snapshot-helper-session-lifecycle.ts', () => ({
  getLiveAndroidSnapshotHelperSession: vi.fn(),
  stopAndroidSnapshotHelperSession: vi.fn(),
}));

vi.mock('../snapshot-helper-session-protocol.ts', () => ({
  sendAndroidSnapshotHelperSessionCommand: vi.fn(),
}));

test('an oversized input frame skips session dispatch and leaves the live helper available', async () => {
  const helper = { packageName: 'snapshot-helper', runner: 'runner' };
  vi.mocked(getLiveAndroidSnapshotHelperSession).mockResolvedValue({
    helper,
    port: 1234,
  } as NonNullable<Awaited<ReturnType<typeof getLiveAndroidSnapshotHelperSession>>>);

  await expect(
    runAndroidSnapshotHelperSessionTouchCommand({
      deviceKey: 'android:emulator-fixture',
      action: 'input',
      helper,
      // The action and request ID also occupy bytes in the frame.
      payloadBase64: 'A'.repeat(256 * 1024),
      timeoutMs: 2_000,
    }),
  ).resolves.toBeUndefined();
  expect(sendAndroidSnapshotHelperSessionCommand).not.toHaveBeenCalled();
  expect(stopAndroidSnapshotHelperSession).not.toHaveBeenCalled();
});
