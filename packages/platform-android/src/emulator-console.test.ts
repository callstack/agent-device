import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./adb.ts', () => ({ runAndroidAdb: vi.fn() }));

import { runAndroidAdb } from './adb.ts';
import { runEmulatorConsole } from './emulator-console.ts';
import { ANDROID_EMULATOR } from './runtime.fixtures.ts';

const mockAdb = vi.mocked(runAndroidAdb);

function answer(stdout: string, exitCode = 0) {
  return { stdout, stderr: '', exitCode };
}

beforeEach(() => {
  mockAdb.mockReset();
});

test('runs the command under adb emu with the caller signal and a bounded timeout', async () => {
  mockAdb.mockResolvedValueOnce(answer('OK\n'));
  const { signal } = new AbortController();
  await expect(runEmulatorConsole(ANDROID_EMULATOR, ['posture', '3'], signal)).resolves.toEqual({
    stdout: 'OK\n',
  });
  expect(mockAdb).toHaveBeenCalledExactlyOnceWith(ANDROID_EMULATOR, ['emu', 'posture', '3'], {
    signal,
    allowFailure: true,
    timeoutMs: 10_000,
  });
});

test.each([
  ['KO: bad phone number format\n', 'bad phone number format'],
  ['some banner\nKO:   no call\n', 'no call'],
  ['KO\nnext line\n', ''],
])(
  'returns the KO reply %j as a refusal, which adb reports with exit 0',
  async (stdout, refusal) => {
    mockAdb.mockResolvedValueOnce(answer(stdout));
    await expect(
      runEmulatorConsole(ANDROID_EMULATOR, ['gsm', 'accept', '5551234'], undefined),
    ).resolves.toEqual({ stdout, refusal });
  },
);

test('throws the adb failure for a failed exit, naming the command but not its operands', async () => {
  mockAdb.mockResolvedValueOnce({ stdout: '', stderr: 'error: device offline', exitCode: 1 });
  const failure = runEmulatorConsole(
    ANDROID_EMULATOR,
    ['sms', 'send', '5551234', 'secret'],
    undefined,
  );
  await expect(failure).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'adb emu sms send exited with code 1',
    details: expect.objectContaining({ deviceId: ANDROID_EMULATOR.id, exitCode: 1 }),
  });
});
