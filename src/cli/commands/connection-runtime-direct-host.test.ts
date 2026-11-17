import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { createAgentDeviceClient } from '@agent-device/client';
import { REMOTE_LEASE_IDLE_TTL_MS } from '@agent-device/contracts/lease-scope';
import { pluginHome, selectV2Plugin, v2RegistrationSource } from '@agent-device/test-kit';
import { materializeRemoteConnectionForCommand } from './connection-runtime.ts';

const capabilities = {
  leaseKind: 'direct-device-provider',
  requiresAppAttachment: false,
  requiresRemoteDaemon: false,
  supportsArtifacts: true,
  supportsDeferredAppSelection: false,
  supportsDirectPortReverse: false,
  usesCloudWebDriverLease: true,
};

afterEach(() => vi.unstubAllEnvs());

test('direct materialization uses supplied host store without an ambient command host', async () => {
  const { home } = pluginHome();
  const ambient = pluginHome();
  vi.stubEnv('AGENT_DEVICE_HOME', ambient.home);
  selectV2Plugin(
    home,
    'example-v2',
    v2RegistrationSource('example-v2', {
      extra: `connection: { capabilities: ${JSON.stringify(capabilities)}, resolve() {}, verify() {} },`,
    }),
  );
  const remoteConfigPath = path.join(home, 'remote.json');
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
  const host = { cwd: home, env: { AGENT_DEVICE_HOME: home } };
  const requests: Array<{ command: string; meta?: { leaseTtlMs?: number } }> = [];
  const client = createAgentDeviceClient(
    {},
    {
      host,
      transport: async (request) => {
        requests.push(request);
        if (request.command === 'lease_allocate')
          return {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-1',
                tenantId: 'team',
                runId: 'run-1',
                backend: 'android-instance',
                created: true,
              },
            },
          };
        throw new Error(`unexpected daemon request: ${request.command}`);
      },
    },
  );
  const result = await materializeRemoteConnectionForCommand({
    host,
    command: 'snapshot',
    client,
    flags: {
      json: true,
      help: false,
      version: false,
      stateDir: path.join(home, 'state'),
      remoteConfig: remoteConfigPath,
      session: 'plugin-direct',
      platform: 'android',
    },
  });
  assert.equal(result.flags.leaseId, 'lease-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.command, 'lease_allocate');
  assert.equal(requests[0]?.meta?.leaseTtlMs, REMOTE_LEASE_IDLE_TTL_MS);
});
