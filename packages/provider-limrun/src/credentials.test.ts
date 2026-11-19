import { expect, test } from 'vitest';
import { readLimrunCredentials } from './credentials.ts';

const IOS_ENV = {
  LIM_IOS_INSTANCE_URL: ' https://region.limrun.example/v1/ios_x/api ',
  LIM_IOS_INSTANCE_TOKEN: 'ios-token',
};
const ANDROID_ENV = {
  LIM_ANDROID_INSTANCE_URL: 'https://region.limrun.example/v1/android_x/api',
  LIM_ANDROID_INSTANCE_TOKEN: 'android-token',
  LIM_ANDROID_INSTANCE_ADB_URL: 'wss://region.limrun.example/v1/android_x/adb',
};

test('reads instance access with the lim CLI variable names', () => {
  expect(readLimrunCredentials({ ...IOS_ENV, ...ANDROID_ENV, LIMRUN_REGION: 'eu' })).toEqual({
    apiKey: undefined,
    region: 'eu',
    keepAlive: false,
    instances: {
      ios: { apiUrl: 'https://region.limrun.example/v1/ios_x/api', token: 'ios-token' },
      android: {
        apiUrl: 'https://region.limrun.example/v1/android_x/api',
        token: 'android-token',
        adbUrl: 'wss://region.limrun.example/v1/android_x/adb',
      },
    },
  });
});

test('reads the API key alone and ignores the removed key alias', () => {
  expect(readLimrunCredentials({ LIMRUN_API_KEY: ' lim_key ' })).toEqual({
    apiKey: 'lim_key',
    region: undefined,
    keepAlive: false,
    instances: undefined,
  });
  expect(readLimrunCredentials({ LIM_API_KEY: 'lim_key', LIMRUN_REGION: 'eu' })).toBeUndefined();
});

test('reads the Watch and iPad models for allocation and rejects an unknown model', () => {
  const env = { LIMRUN_API_KEY: 'key' };
  expect(readLimrunCredentials({ ...env, LIMRUN_IOS_MODEL: 'watch' })?.iosModel).toBe('watch');
  expect(readLimrunCredentials({ ...env, LIMRUN_IOS_MODEL: 'ipad' })?.iosModel).toBe('ipad');
  expect(() => readLimrunCredentials({ ...env, LIMRUN_IOS_MODEL: 'wrong' })).toThrow(
    /LIMRUN_IOS_MODEL/,
  );
});

test('rejects partial instance access instead of creating a new instance', () => {
  expect(() =>
    readLimrunCredentials({ LIMRUN_API_KEY: 'lim_key', LIM_IOS_INSTANCE_URL: 'https://x/api' }),
  ).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: 'Limrun instance access is missing LIM_IOS_INSTANCE_TOKEN.',
    }),
  );
  const { LIM_ANDROID_INSTANCE_ADB_URL: _adbUrl, ...withoutAdbUrl } = ANDROID_ENV;
  expect(() => readLimrunCredentials(withoutAdbUrl)).toThrow(/LIM_ANDROID_INSTANCE_ADB_URL/);
});

test('reads LIMRUN_KEEP_ALIVE as an opt-in flag that never registers a runtime alone', () => {
  const keepAlive = (env: Record<string, string>) =>
    readLimrunCredentials({ ...IOS_ENV, ...env })?.keepAlive;
  expect(keepAlive({ LIMRUN_KEEP_ALIVE: '1' })).toBe(true);
  expect(keepAlive({ LIMRUN_KEEP_ALIVE: ' TRUE ' })).toBe(true);
  expect(keepAlive({ LIMRUN_KEEP_ALIVE: '0' })).toBe(false);
  expect(keepAlive({})).toBe(false);
  expect(readLimrunCredentials({ LIMRUN_KEEP_ALIVE: '1' })).toBeUndefined();
});
