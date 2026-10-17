import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readAndroidSdkInt } from '../device-sdk-int.ts';
import { withFakeAdb, type FakeAdbResponse } from './test-utils/fake-adb.ts';

test.each([
  { response: '34\n', expected: 34 },
  { response: '', expected: null },
  { response: 'unknown', expected: null },
  { response: '0', expected: null },
  { response: '27garbage', expected: null },
  { response: { stderr: 'error: closed', exitCode: 1 }, expected: null },
] satisfies { response: FakeAdbResponse; expected: number | null }[])(
  'readAndroidSdkInt reads $response as $expected',
  async ({ response, expected }) => {
    await withFakeAdb(
      () => response,
      async ({ calls, device }) => {
        assert.equal((await readAndroidSdkInt(device)).sdkInt, expected);
        assert.deepEqual(calls, [['shell', 'getprop', 'ro.build.version.sdk']]);
      },
    );
  },
);
