import path from 'node:path';
import { expect, test } from 'vitest';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import {
  providerCredentialFingerprint,
  readDaemonProviderCredentials,
} from '../../provider-credential-fingerprint.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';

const DAEMON_ENV = { LIMRUN_API_KEY: 'lim-key' };

test.for([
  [{ LIMRUN_API_KEY: 'lim-rotated' }, 'provider-credentials-changed', 0],
  [DAEMON_ENV, undefined, 1],
] as const)(
  'the router hands the daemon provider credentials to lease allocation (shell %j)',
  async ([shellEnv, reason, allocations]) => {
    const stateDir = mkdtempForTestSync('agent-device-router-provider-credentials-');
    let allocated = 0;
    const handler = createRequestHandler({
      logPath: path.join(stateDir, 'daemon.log'),
      token: 'test-token',
      sessionStore: makeSessionStore('agent-device-router-provider-credentials-store-'),
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      providerCredentials: readDaemonProviderCredentials(DAEMON_ENV, stateDir),
      leaseLifecycleProvider: {
        allocate: async () => {
          allocated += 1;
          return {};
        },
      },
      trackDownloadableArtifact: () => 'artifact-id',
    });

    const response = await handler({
      token: 'test-token',
      session: 'default',
      command: 'lease_allocate',
      positionals: [],
      flags: {},
      meta: {
        requestId: 'req-provider-credentials',
        tenantId: 'tenant-a',
        runId: 'run-a',
        clientId: 'client-a',
        leaseBackend: 'ios-instance',
        leaseProvider: 'limrun',
        providerCredentialFingerprint: providerCredentialFingerprint('limrun', shellEnv),
      },
    });

    expect(response.ok ? undefined : response.error.details?.reason).toBe(reason);
    expect(allocated).toBe(allocations);
  },
);
