import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildReplayBuiltinVars } from '../session-replay-vars.ts';

test('buildReplayBuiltinVars applies request values over metadata', () => {
  const builtins = buildReplayBuiltinVars({
    req: {
      token: 't',
      session: 'session',
      command: 'replay',
      positionals: [],
      flags: {
        platform: 'ios',
        target: 'desktop',
        device: 'Test Device',
        serial: 'android-serial',
        udid: 'ios-udid',
        shardIndex: 1,
        shardCount: 4,
        artifactsDir: '/tmp/artifacts',
      },
      meta: { cwd: '/tmp/replay' },
    },
    sessionName: 'session',
    metadata: { platform: 'android', target: 'mobile' },
    resolvedPath: '/tmp/replay/flows/test.ad',
  });

  assert.deepEqual(builtins, {
    AD_SESSION: 'session',
    AD_FILENAME: 'flows/test.ad',
    AD_PLATFORM: 'ios',
    AD_TARGET: 'desktop',
    AD_DEVICE: 'Test Device',
    AD_DEVICE_ID: 'android-serial',
    AD_SHARD_INDEX: '1',
    AD_SHARD_COUNT: '4',
    AD_ARTIFACTS: '/tmp/artifacts',
  });
});

test('buildReplayBuiltinVars omits empty optional values', () => {
  const builtins = buildReplayBuiltinVars({
    req: {
      token: 't',
      session: 'session',
      command: 'replay',
      positionals: [],
      flags: {
        device: '',
        serial: '',
        udid: 'ios-udid',
        artifactsDir: '',
      },
      meta: { cwd: '/tmp/replay' },
    },
    sessionName: 'session',
    metadata: { platform: 'android', target: 'mobile' },
    resolvedPath: '/tmp/replay/test.ad',
  });

  assert.deepEqual(builtins, {
    AD_SESSION: 'session',
    AD_FILENAME: 'test.ad',
    AD_PLATFORM: 'android',
    AD_TARGET: 'mobile',
  });
});
