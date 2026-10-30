import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import { commonInputFromFlags, readJsonObject, selectionOptionsFromFlags } from './common.ts';

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

// Common-input-fields.ts rows that read a real `CliFlags` key but deliberately join neither
// `flagIn` projection today (operator/env-sourced). Setting these too, on top of
// `ALL_COMMON_FLAGS`, means a row that wrongly gained `flagIn: ['input']` would surface a
// concrete value here rather than being silently dropped by `commonInputFromFlags`'s
// `compactRecord` — over-inclusion `ALL_COMMON_FLAGS` alone cannot catch, since an unset flag
// reads as `undefined` and gets compacted away either way.
const NON_PROJECTED_COMMON_FLAGS: Partial<CliFlags> = {
  daemonBaseUrl: 'https://daemon.example',
  daemonAuthToken: 'token-value',
  tenant: 'tenant-value',
  runId: 'run-value',
  leaseId: 'lease-value',
};

describe('commonInputFromFlags', () => {
  test('projects every common flag into the reader-input shape', () => {
    expect(
      commonInputFromFlags(flags({ ...ALL_COMMON_FLAGS, ...NON_PROJECTED_COMMON_FLAGS })),
    ).toStrictEqual({
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
    expect(
      selectionOptionsFromFlags(flags({ ...ALL_COMMON_FLAGS, ...NON_PROJECTED_COMMON_FLAGS })),
    ).toStrictEqual({
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

// `trigger-app-event [payloadJson]` reads its payload through this reader, so the
// refusal must name the label the user actually typed against.
describe('readJsonObject', () => {
  test('accepts a JSON object', () => {
    expect(readJsonObject('{"aps":{"alert":"hi"}}', 'payload')).toEqual({
      aps: { alert: 'hi' },
    });
  });

  test('refuses malformed JSON, arrays, nulls, and scalars with the labelled error', () => {
    const refusal = (value: string) =>
      expect(() => readJsonObject(value, 'trigger-app-event payload')).toThrow(
        expect.objectContaining({
          code: 'INVALID_ARGS',
          message: 'trigger-app-event payload must be a JSON object',
        }),
      );
    refusal('not json');
    refusal('[1,2]');
    refusal('null');
    refusal('7');
  });
});
