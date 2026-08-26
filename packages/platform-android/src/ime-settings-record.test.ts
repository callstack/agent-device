import { expect, test } from 'vitest';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import {
  readAndroidDefaultInputMethod,
  readPersistedPreviousIme,
  restorePriorPersistedIme,
  writePersistedPreviousIme,
} from './ime-settings-record.ts';
import { fakeImeDeviceAdb } from './ime-device.fixtures.ts';

test('the restore target only counts as persisted when it reads back', async () => {
  bindAndroidAdbHostStub();
  const store = new Map<string, string>([['default_input_method', 'com.samsung/.Keyboard']]);
  const adb = fakeImeDeviceAdb({ settings: store });

  expect(await readAndroidDefaultInputMethod(adb)).toBe('com.samsung/.Keyboard');
  expect(await readPersistedPreviousIme(adb)).toBeUndefined();

  expect(await writePersistedPreviousIme(adb, 'com.samsung/.Keyboard')).toBe(true);
  expect(await readPersistedPreviousIme(adb)).toBe('com.samsung/.Keyboard');

  const failing = fakeImeDeviceAdb({ settings: store, settingsWritesFail: true });
  expect(await writePersistedPreviousIme(failing, 'other/.Ime')).toBe(false);
});

test('rollback restores the prior record, or clears it, and reports only failures', async () => {
  const host = bindAndroidAdbHostStub();
  const store = new Map<string, string>([['agent_device_ime_helper_previous_ime', 'stale/.Value']]);
  const adb = fakeImeDeviceAdb({ settings: store });

  // No prior record: rollback clears the key it wrote.
  await restorePriorPersistedIme(adb, undefined, 'emulator-5554');
  expect(store.has('agent_device_ime_helper_previous_ime')).toBe(false);
  expect(host.diagnostics).toEqual([]);

  // A prior record is written back.
  await restorePriorPersistedIme(adb, 'prior/.Ime', 'emulator-5554');
  expect(store.get('agent_device_ime_helper_previous_ime')).toBe('prior/.Ime');
  expect(host.diagnostics).toEqual([]);

  // A rollback that cannot persist is reported, never thrown.
  const failing = fakeImeDeviceAdb({ settings: store, settingsWritesFail: true });
  await restorePriorPersistedIme(failing, 'prior/.Ime', 'emulator-5554');
  expect(host.diagnostics).toEqual([
    { phase: 'android_test_ime_record_rollback_failed', level: 'warn' },
  ]);
});
