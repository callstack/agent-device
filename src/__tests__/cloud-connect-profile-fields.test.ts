import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { resolveConnectProviderProfile } from '../cli/connection/connect-provider-adapters.ts';
import { resolveLimrunConnectProfile } from '../cli/connection/limrun-profile.ts';
import { runCliCapture } from './cli-capture.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

test('connect limrun refuses profile fields Limrun does not read', async () => {
  const result = await runCliCapture(
    [
      'connect',
      'limrun',
      '--session',
      'ci',
      '--platform',
      'ios',
      '--provider-os-version',
      '18',
      '--provider-geo-location',
      'US',
      '--json',
    ],
    {
      env: { LIMRUN_API_KEY: 'lim_test_key' },
      stateDirPrefix: 'agent-device-connect-limrun-profile-fields-',
    },
  );
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'INVALID_ARGS');
  assert.deepEqual(payload.error.details.flags, [
    '--provider-os-version',
    '--provider-geo-location',
  ]);
});

test('connect limrun applies the same refusal when attaching to an existing instance', () => {
  const tempRoot = mkdtempForTestSync('agent-device-connect-limrun-attach-profile-fields-');
  const connect = (flags: Record<string, unknown>) =>
    resolveLimrunConnectProfile({
      stateDir: path.join(tempRoot, '.state'),
      cwd: tempRoot,
      env: {
        LIM_IOS_INSTANCE_URL: 'https://region.limrun.example/v1/ios_x/api',
        LIM_IOS_INSTANCE_TOKEN: 'ios-instance-token',
      },
      flags: { json: false, help: false, version: false, platform: 'ios', ...flags },
    });

  try {
    assert.equal(connect({ providerApp: 'Example.ipa' }).flags.providerApp, 'Example.ipa');
    assert.throws(
      () => connect({ providerOsVersion: '18.0' }),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        JSON.stringify(error.details?.flags) === '["--provider-os-version"]',
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
