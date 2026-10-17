import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import { pluginHome, selectV2Plugin, v2RegistrationSource } from '@agent-device/test-kit';
import {
  connectionWorkspace,
  createTestClient,
} from '../../__tests__/remote-connection.fixtures.ts';
import { materializeRemoteConnectionForCommand } from './connection-runtime.ts';

const LOCAL_CAPABILITIES = {
  leaseKind: 'direct-device-provider',
  requiresAppAttachment: false,
  requiresRemoteDaemon: false,
  supportsArtifacts: true,
  supportsDeferredAppSelection: false,
  supportsDirectPortReverse: false,
  usesCloudWebDriverLease: true,
};

test('a stored profile for a v2 plugin provider needs no remote daemon URL', async () => {
  const { home } = pluginHome();
  vi.stubEnv('AGENT_DEVICE_HOME', home);
  selectV2Plugin(
    home,
    'example-v2',
    v2RegistrationSource('example-v2', {
      extra: `connection: { capabilities: ${JSON.stringify(LOCAL_CAPABILITIES)}, resolve() {}, verify() {} },`,
    }),
  );
  const { stateDir, remoteConfigPath } = connectionWorkspace('plugin-capabilities-');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      tenant: 'team',
      runId: 'run-1',
      leaseProvider: 'example-v2',
      leaseBackend: 'android-instance',
      platform: 'android',
    }),
  );

  // Without the plugin's declared capabilities the profile reads as a remote provider and is
  // refused for lacking a daemonBaseUrl.
  await expect(
    materializeRemoteConnectionForCommand({
      command: 'snapshot',
      client: createTestClient(),
      flags: {
        json: true,
        help: false,
        version: false,
        stateDir,
        remoteConfig: remoteConfigPath,
        session: 'plugin-capabilities',
        platform: 'android',
      },
    }),
  ).resolves.toBeDefined();
  vi.unstubAllEnvs();
});
