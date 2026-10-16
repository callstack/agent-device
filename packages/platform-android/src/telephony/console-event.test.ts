import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../adb.ts', () => ({ runAndroidAdb: vi.fn() }));

import { runAndroidAdb } from '../adb.ts';
import { ANDROID_EMULATOR } from '../runtime.fixtures.ts';
import { sendAndroidTelephonyEvent } from './console-event.ts';

const mockAdb = vi.mocked(runAndroidAdb);

function answer(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 };
}

function sentArgs(): readonly string[] | undefined {
  return mockAdb.mock.calls[0]?.[1];
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
  await sendAndroidTelephonyEvent(ANDROID_EMULATOR, input, signal);
  expect(mockAdb).toHaveBeenCalledExactlyOnceWith(
    ANDROID_EMULATOR,
    args,
    expect.objectContaining({ signal }),
  );
});

test('passes SMS text with spaces, quotes, and shell metacharacters as one argument', async () => {
  const text = `Don't "pause" $HOME; echo $(id) & *`;
  await sendAndroidTelephonyEvent(
    ANDROID_EMULATOR,
    { action: 'sms', number: '5551234', text },
    new AbortController().signal,
  );
  expect(sentArgs()).toEqual(['emu', 'sms', 'send', '5551234', text]);
});

test('escapes backslashes and line breaks for the console instead of ending its command line', async () => {
  await sendAndroidTelephonyEvent(
    ANDROID_EMULATOR,
    {
      action: 'sms',
      number: '5551234',
      text: 'line one\nC:\\path\\n',
    },
    new AbortController().signal,
  );
  expect(sentArgs()).toEqual(['emu', 'sms', 'send', '5551234', String.raw`line one\nC:\\path\\n`]);
});

test.each([
  ['KO: no current call for this number\n', { consoleReason: 'no current call for this number' }],
  ['KO\n', {}],
])('reports the console reply %j as telephony-console-refused', async (stdout, extra) => {
  mockAdb.mockResolvedValueOnce(answer(stdout));
  const refusal = sendAndroidTelephonyEvent(
    ANDROID_EMULATOR,
    {
      action: 'accept',
      number: '5551234',
    },
    new AbortController().signal,
  );
  await expect(refusal).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      deviceId: ANDROID_EMULATOR.id,
      reason: 'telephony-console-refused',
      hint: expect.stringContaining('telephony call <number>'),
      ...extra,
    },
  });
  if (!('consoleReason' in extra)) {
    await expect(refusal).rejects.not.toMatchObject({
      details: { consoleReason: expect.anything() },
    });
  }
});
