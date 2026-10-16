import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./console-event.ts', () => ({ sendAndroidTelephonyEvent: vi.fn() }));

import { ANDROID_EMULATOR } from '../runtime.fixtures.ts';
import { sendAndroidTelephonyEvent } from './console-event.ts';
import { createAndroidTelephonyOperations } from './runtime.ts';

const mockSend = vi.mocked(sendAndroidTelephonyEvent);

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(undefined);
});

test('the emulator operation sends the event with the bound request signal', async () => {
  const { signal } = new AbortController();
  const operations = createAndroidTelephonyOperations({ device: ANDROID_EMULATOR, signal });

  const input = { action: 'sms', number: '5551234', text: 'hello' } as const;
  await operations.sendTelephonyEvent?.(input);
  expect(mockSend).toHaveBeenCalledExactlyOnceWith(ANDROID_EMULATOR, input, signal);
});

test('an aborted scope never reaches the emulator console', async () => {
  const controller = new AbortController();
  const operations = createAndroidTelephonyOperations({
    device: ANDROID_EMULATOR,
    signal: controller.signal,
  });
  controller.abort();
  await expect(
    operations.sendTelephonyEvent?.({ action: 'call', number: '5551234' }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(mockSend).not.toHaveBeenCalled();
});
