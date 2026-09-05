import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import { commonInputFromFlags, selectionOptionsFromFlags } from './common.ts';

function flags(overrides: Partial<CliFlags> = {}): CliFlags {
  return overrides as CliFlags;
}

// Every flag either reader function is documented to read (see the `commonInputFromFlags` and
// `selectionOptionsFromFlags` doc comments in ./common.ts).
const ALL_COMMON_FLAGS: Partial<CliFlags> = {
  noRecord: true,
  session: 'my-session',
  platform: 'ios',
  target: 'mobile',
  device: 'iPhone 15',
  udid: 'ABCD-1234',
  serial: 'emulator-5554',
  iosSimulatorDeviceSet: '/tmp/device-set',
  iosXctestrunFile: '/tmp/run.xctestrun',
  iosXctestDerivedDataPath: '/tmp/derived-data',
  iosXctestEnvDir: '/tmp/env-dir',
  androidDeviceAllowlist: 'emulator-5554,emulator-5556',
};

describe('commonInputFromFlags', () => {
  test('projects every common flag into the reader-input shape', () => {
    expect(commonInputFromFlags(flags(ALL_COMMON_FLAGS))).toStrictEqual({
      noRecord: true,
      session: 'my-session',
      platform: 'ios',
      deviceTarget: 'mobile',
      device: 'iPhone 15',
      udid: 'ABCD-1234',
      serial: 'emulator-5554',
      iosSimulatorDeviceSet: '/tmp/device-set',
      iosXctestrunFile: '/tmp/run.xctestrun',
      iosXctestDerivedDataPath: '/tmp/derived-data',
      iosXctestEnvDir: '/tmp/env-dir',
      androidDeviceAllowlist: 'emulator-5554,emulator-5556',
    });
  });

  test('drops every key when no common flag is set', () => {
    expect(commonInputFromFlags(flags())).toStrictEqual({});
  });
});

describe('selectionOptionsFromFlags', () => {
  test('projects the selection-options subset, keeping the raw target spelling', () => {
    expect(selectionOptionsFromFlags(flags(ALL_COMMON_FLAGS))).toStrictEqual({
      noRecord: true,
      platform: 'ios',
      target: 'mobile',
      device: 'iPhone 15',
      udid: 'ABCD-1234',
      serial: 'emulator-5554',
      iosSimulatorDeviceSet: '/tmp/device-set',
      androidDeviceAllowlist: 'emulator-5554,emulator-5556',
    });
  });

  test('keeps every key present (undefined, not dropped) when no common flag is set', () => {
    expect(selectionOptionsFromFlags(flags())).toStrictEqual({
      noRecord: undefined,
      platform: undefined,
      target: undefined,
      device: undefined,
      udid: undefined,
      serial: undefined,
      iosSimulatorDeviceSet: undefined,
      androidDeviceAllowlist: undefined,
    });
  });
});
