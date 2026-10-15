import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../adb.ts', () => ({ runAndroidAdb: vi.fn() }));

import { runAndroidAdb } from '../adb.ts';
import { ANDROID_EMULATOR } from '../runtime.fixtures.ts';
import { sendAndroidTelephonyEvent } from './emulator-console.ts';

const mockAdb = vi.mocked(runAndroidAdb);

function answer(stdout: string, exitCode = 0) {
  return { stdout, stderr: '', exitCode };
}

beforeEach(() => {
  mockAdb.mockReset();
  mockAdb.mockResolvedValue(answer('OK\n'));
});

test.each([
  [{ action: 'call', number: '5551234' }, ['emu', 'gsm', 'call', '5551234']],
  [{ action: 'accept', number: '5551234' }, ['emu', 'gsm', 'accept', '5551234']],
  [{ action: 'cancel', number: '+15551234567' }, ['emu', 'gsm', 'cancel', '+15551234567']],
  [{ action: 'sms', number: '5551234', text: 'hello' }, ['emu', 'sms', 'send', '5551234', 'hello']],
] as const)('sends %o to the emulator console as %o', async (input, args) => {
  const { signal } = new AbortController();
  await sendAndroidTelephonyEvent(ANDROID_EMULATOR, input, { signal });
  expect(mockAdb).toHaveBeenCalledExactlyOnceWith(ANDROID_EMULATOR, args, {
    signal,
    allowFailure: true,
  });
});

test('passes SMS text with spaces, quotes, and shell metacharacters as one argument', async () => {
  const text = `Don't "pause" $HOME; echo $(id) & *`;
  await sendAndroidTelephonyEvent(ANDROID_EMULATOR, { action: 'sms', number: '5551234', text });
  expect(mockAdb.mock.calls[0]?.[1]).toEqual(['emu', 'sms', 'send', '5551234', text]);
});

test('escapes backslashes and line breaks for the console instead of ending its command line', async () => {
  await sendAndroidTelephonyEvent(ANDROID_EMULATOR, {
    action: 'sms',
    number: '5551234',
    text: 'line one\nC:\\path\\n',
  });
  expect(mockAdb.mock.calls[0]?.[1]).toEqual([
    'emu',
    'sms',
    'send',
    '5551234',
    String.raw`line one\nC:\\path\\n`,
  ]);
  expect(mockAdb.mock.calls[0]?.[1].at(-1)).not.toContain('\n');
});

test('reports a console KO reply as a typed refusal even though adb exits 0', async () => {
  mockAdb.mockResolvedValueOnce(answer('KO: no current call for this number\n'));
  await expect(
    sendAndroidTelephonyEvent(ANDROID_EMULATOR, { action: 'accept', number: '5551234' }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      deviceId: ANDROID_EMULATOR.id,
      reason: 'telephony-console-refused',
      consoleReason: 'no current call for this number',
      hint: expect.stringContaining('telephony call <number>'),
    },
  });
});

test('reports an adb failure with the adb exit details rather than a console refusal', async () => {
  mockAdb.mockResolvedValueOnce({ stdout: '', stderr: 'error: device offline', exitCode: 1 });
  const failure = sendAndroidTelephonyEvent(ANDROID_EMULATOR, {
    action: 'call',
    number: '5551234',
  });
  await expect(failure).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: expect.stringContaining('exited with code 1'),
    details: expect.objectContaining({ deviceId: ANDROID_EMULATOR.id, exitCode: 1 }),
  });
  await expect(failure).rejects.not.toMatchObject({
    details: { reason: 'telephony-console-refused' },
  });
});
