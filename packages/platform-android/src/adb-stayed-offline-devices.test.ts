import { expect, onTestFinished, test, vi } from 'vitest';
import { createStayedOfflineDevices } from './adb-stayed-offline-devices.ts';

test('a mark lasts its window, and marking a device drops the marks that lapsed', () => {
  vi.useFakeTimers({ toFake: ['Date'], now: 0 });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const expiries = new Map<string, number>();
  const devices = createStayedOfflineDevices(30_000, expiries);

  devices.mark('/emulator-5554');
  vi.setSystemTime(29_999);
  expect(devices.has('/emulator-5554')).toBe(true);
  vi.setSystemTime(30_000);
  expect(devices.has('/emulator-5554')).toBe(false);

  devices.mark('/emulator-5556');
  expect([...expiries.keys()]).toEqual(['/emulator-5556']);

  devices.forget('/emulator-5556');
  expect(devices.has('/emulator-5556')).toBe(false);
  expect(expiries.size).toBe(0);
});
