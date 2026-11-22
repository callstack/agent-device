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
import { pluginHome, selectPlugin } from '@agent-device/test-kit';

test.each(['missing', 'failed'] as const)(
  'AWS profile and stored connection refuse a %s plugin before lease actions',
  async (kind) => {
    const { home, env } = pluginHome();
    if (kind === 'failed')
      selectPlugin(home, '@agent-device/aws-device-farm', 'throw new Error("registration failed")');
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
    const status = await runCliCapture(
      ['connection', 'status', '--state-dir', stateDir, '--json'],
      opts,
    );
    assert.equal(status.code, null, status.stdout);
    assert.deepEqual(status.calls, []);
    const snapshot = await runCliCapture(['snapshot', '--state-dir', stateDir, '--json'], opts);
    assert.equal(snapshot.code, 1, snapshot.stdout);
    assert.equal(JSON.parse(snapshot.stdout).error?.code, 'UNSUPPORTED_OPERATION', snapshot.stdout);
    assert.equal(JSON.parse(snapshot.stdout).error?.details?.reason, expected, snapshot.stdout);
    assert.deepEqual(snapshot.calls, []);
  },
);

test.each([undefined, 'arn:aws:devicefarm:us-west-2:123:upload:demo'])(
  'configured AWS Device Farm connect gives guidance based on the effective app ARN %s',
  async (awsAppArn) => {
    const { home, env } = pluginHome();
    const stateDir = path.join(home, 'state');
    const remoteConfigPath = path.join(home, 'aws remote.json');
    const daemonBaseUrl = 'https://daemon.example.test';
    const token = 'adc_live_aws_profile_test_token';
    const profile = {
      leaseProvider: 'aws-device-farm',
      leaseBackend: 'android-instance',
      platform: 'android',
      awsProjectArn: 'arn:aws:devicefarm:us-west-2:123:project:project-a',
      awsDeviceArn: 'arn:aws:devicefarm:us-west-2::device:device-a',
    };
    fs.writeFileSync(remoteConfigPath, JSON.stringify(profile));
    const argv = [
      'connect',
      '--remote-config',
      remoteConfigPath,
      '--daemon-base-url',
      daemonBaseUrl,
      '--daemon-auth-token',
      token,
      '--tenant',
      'override-team',
      '--run-id',
      'override-run',
      '--state-dir',
      stateDir,
      '--session',
      'checkout',
      '--json',
      ...(awsAppArn ? ['--aws-app-arn', awsAppArn] : []),
    ];
    const result = await runCliCapture(argv, { cwd: home, env });
    assert.ok(!result.stdout.includes(token));
    assert.equal(result.code, null, result.stdout + result.stderr);
    assert.deepEqual(result.calls, []);
    const { data } = JSON.parse(result.stdout);
    assert.equal(data.verification.status, 'configured');
    assert.deepEqual(data.leasePreparation.nextSteps, data.nextSteps);
    if (awsAppArn) {
      assert.deepEqual(data.nextSteps, [
        'agent-device open <package-id> --relaunch --session checkout',
      ]);
    } else {
      assert.equal(data.app.status, 'missing');
      assert.match(data.leasePreparation.message, /awsAppArn/);
      assert.deepEqual(data.nextSteps, ['Repeat your original connect invocation with --force.']);
      fs.writeFileSync(
        remoteConfigPath,
        JSON.stringify({
          ...profile,
          awsAppArn: 'arn:aws:devicefarm:us-west-2:123:upload:demo',
        }),
      );
      const reconnect = await runCliCapture([...argv, '--force'], { cwd: home, env });
      assert.equal(reconnect.code, null, reconnect.stdout + reconnect.stderr);
      assert.deepEqual(reconnect.calls, []);
      assert.ok(!reconnect.stdout.includes(token));
      assert.deepEqual(JSON.parse(reconnect.stdout).data.nextSteps, [
        'agent-device open <package-id> --relaunch --session checkout',
      ]);
      const connection = readRemoteConnectionState({ stateDir, session: 'checkout' });
      assert.equal(connection?.tenant, 'override-team');
      assert.equal(connection?.runId, 'override-run');
      assert.equal(connection?.remoteConfigHash, hashRemoteConfigFile(remoteConfigPath));
    }
  },
);
