import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import {
  hashRemoteConfigFile,
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { pluginHome, selectV2Plugin } from '@agent-device/test-kit';

test.each(['missing', 'failed'] as const)(
  'AWS profile and stored connection refuse a %s plugin before lease actions',
  async (kind) => {
    const { home, env } = pluginHome();
    if (kind === 'failed')
      selectV2Plugin(
        home,
        '@agent-device/aws-device-farm',
        'throw new Error("registration failed")',
      );
    const stateDir = path.join(home, 'state');
    const remoteConfigPath = path.join(home, 'aws.json');
    fs.writeFileSync(
      remoteConfigPath,
      JSON.stringify({
        tenant: 'team',
        runId: 'run-1',
        leaseProvider: 'aws-device-farm',
        leaseBackend: 'android-instance',
        platform: 'android',
      }),
    );
    const opts = { cwd: home, env: { ...env, AGENT_DEVICE_SESSION: 'default' } };
    const expected = kind === 'missing' ? 'plugin-not-installed' : 'plugin-unavailable';
    const connect = await runCliCapture(
      ['connect', '--remote-config', remoteConfigPath, '--state-dir', stateDir, '--json'],
      opts,
    );
    assert.equal(connect.code, 1, connect.stdout);
    assert.equal(JSON.parse(connect.stdout).error?.code, 'UNSUPPORTED_OPERATION', connect.stdout);
    assert.equal(JSON.parse(connect.stdout).error?.details?.reason, expected, connect.stdout);
    assert.deepEqual(connect.calls, []);
    assert.equal(readRemoteConnectionState({ stateDir, session: 'default' }), null);
    const now = new Date().toISOString();
    writeRemoteConnectionState({
      stateDir,
      state: {
        version: 1,
        session: 'default',
        remoteConfigPath,
        remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
        tenant: 'team',
        runId: 'run-1',
        leaseProvider: 'aws-device-farm',
        leaseBackend: 'android-instance',
        platform: 'android',
        connectedAt: now,
        updatedAt: now,
      },
    });
    for (const argv of [
      ['connection', 'status', '--state-dir', stateDir, '--json'],
      ['snapshot', '--state-dir', stateDir, '--json'],
    ]) {
      const result = await runCliCapture(argv, opts);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(JSON.parse(result.stdout).error?.code, 'UNSUPPORTED_OPERATION', result.stdout);
      assert.equal(JSON.parse(result.stdout).error?.details?.reason, expected, result.stdout);
      assert.deepEqual(result.calls, []);
      assert.doesNotMatch(result.stdout, /install-from-source|leaseId.*pending/);
    }
  },
);
