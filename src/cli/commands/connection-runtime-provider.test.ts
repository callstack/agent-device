import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import browserstack from '@agent-device/browserstack';
import { pluginHome, selectPlugin, pluginSource } from '@agent-device/test-kit';
import {
  connectionWorkspace,
  createTestClient,
  recordedLeaseAllocate,
  seedConnectionState,
} from '../../__tests__/remote-connection.fixtures.ts';
import { materializeRemoteConnectionForCommand } from '../../__tests__/test-utils/host-bound-commands.ts';
import { providerContributionOf } from '@agent-device/plugins/validate';

afterEach(() => vi.unstubAllEnvs());

test('deferred provider materialization forwards provider profile fields to lease allocation', async () => {
  const { home } = pluginHome();
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  selectPlugin(
    home,
    '@agent-device/browserstack',
    pluginSource('browserstack', {
      extra: `connection: { capabilities: ${JSON.stringify(providerContributionOf(browserstack()).connection?.capabilities)}, resolve() {}, verify() {} },`,
    }),
  );
  const { tempRoot, stateDir } = connectionWorkspace('agent-device-provider-lease-flags-');
  const remoteConfigPath = path.join(tempRoot, 'browserstack.json');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      tenant: 'browserstack',
      runId: 'browserstack-run',
      leaseProvider: 'browserstack',
      leaseBackend: 'android-instance',
      platform: 'android',
      device: 'Google Pixel 8',
      providerOsVersion: '14.0',
      providerApp: '/tmp/WikipediaSample.apk',
      providerProject: 'agent-device',
      providerBuild: 'live-smoke',
    }),
  );
  seedConnectionState({
    stateDir,
    state: {
      session: 'adc-browserstack',
      remoteConfigPath,
      tenant: 'browserstack',
      runId: 'browserstack-run',
      leaseBackend: 'android-instance',
      leaseProvider: 'browserstack',
      platform: 'android',
    },
  });
  const allocate = recordedLeaseAllocate({
    leaseId: 'lease-browserstack',
    backend: 'android-instance',
  });

  const materialized = await materializeRemoteConnectionForCommand({
    command: 'open',
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir,
      remoteConfig: remoteConfigPath,
      tenant: 'browserstack',
      runId: 'browserstack-run',
      session: 'adc-browserstack',
      leaseBackend: 'android-instance',
      platform: 'android',
      device: 'Google Pixel 8',
      providerOsVersion: '14.0',
      providerApp: '/tmp/WikipediaSample.apk',
      providerProject: 'agent-device',
      providerBuild: 'live-smoke',
    },
    client: createTestClient({ allocate: allocate.stub }),
  });

  assert.equal(materialized.flags.leaseId, 'lease-browserstack');
  assert.equal(allocate.request?.platform, 'android');
  assert.equal(allocate.request?.device, 'Google Pixel 8');
  assert.equal(allocate.request?.providerApp, '/tmp/WikipediaSample.apk');
  assert.equal(allocate.request?.providerOsVersion, '14.0');
  assert.equal(allocate.request?.providerProject, 'agent-device');
  assert.equal(allocate.request?.providerBuild, 'live-smoke');

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
