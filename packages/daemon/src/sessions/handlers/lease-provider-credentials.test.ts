import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DaemonProviderCredentials } from '@agent-device/daemon-contracts/provider-credentials';
import type { AppError } from '@agent-device/kernel/errors';
import { handleLeaseCommands } from './lease.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { providerCredentialsFixture } from '../../__tests__/support/provider-credentials-fixture.ts';

const STATE_DIR = '/tmp/agent device state';
const PROVIDERS = ['limrun', 'browserstack', 'testmu'] as const;

type LeaseBackend = 'ios-instance' | 'android-instance';

function allocateRequest(
  leaseProvider: string,
  providerCredentialFingerprint: string | undefined,
  leaseBackend: LeaseBackend = 'ios-instance',
): DaemonRequest {
  return {
    token: 'test-token',
    session: 'lease-ttl-test',
    command: 'lease_allocate',
    positionals: [],
    flags: {},
    meta: {
      tenantId: 'tenant-a',
      runId: 'run-a',
      clientId: 'client-a',
      leaseBackend,
      leaseProvider,
      providerCredentialFingerprint,
    },
  };
}

async function allocateWithDaemonCredentials(
  req: DaemonRequest,
  providerCredentials: DaemonProviderCredentials,
): Promise<{ allocations: number; error?: AppError }> {
  const registry = new LeaseRegistry();
  let allocations = 0;
  try {
    await handleLeaseCommands({
      req,
      sessionName: req.session,
      sessionStore: makeSessionStore('agent-device-provider-credentials-'),
      leaseRegistry: registry,
      providerRuntimeIds: [req.meta?.leaseProvider ?? ''],
      providerCredentials,
      leaseLifecycleProvider: {
        allocate: async () => {
          allocations += 1;
          return {};
        },
      },
    });
  } catch (error) {
    assert.deepEqual(registry.listActiveLeases(), []);
    return { allocations, error: error as AppError };
  }
  return { allocations };
}

function shellFingerprint(env: Record<string, string>): string | undefined {
  return providerCredentialsFixture(env).fingerprint('any');
}

test.for(PROVIDERS)(
  'a daemon holding other %s credentials than the shell refuses before allocation',
  async (provider) => {
    const outcome = await allocateWithDaemonCredentials(
      allocateRequest(provider, shellFingerprint({ KEY: 'key-2' })),
      providerCredentialsFixture({ KEY: 'key-1' }, STATE_DIR),
    );

    assert.equal(outcome.allocations, 0);
    assert.equal(outcome.error?.code, 'INVALID_ARGS');
    assert.equal(outcome.error?.details?.reason, 'provider-credentials-changed');
    assert.equal(outcome.error?.details?.provider, provider);
    assert.match(
      String(outcome.error?.details?.hint),
      /agent-device daemon stop --state-dir '\/tmp\/agent device state'/,
    );
  },
);

test.for(PROVIDERS)(
  'a daemon holding the %s credentials of the shell allocates',
  async (provider) => {
    const env = { KEY: 'key-1' };
    const outcome = await allocateWithDaemonCredentials(
      allocateRequest(provider, shellFingerprint(env)),
      providerCredentialsFixture(env, STATE_DIR),
    );

    assert.equal(outcome.error, undefined);
    assert.equal(outcome.allocations, 1);
  },
);

test.for(PROVIDERS)(
  'a daemon holding %s credentials allocates for a shell with none',
  async (provider) => {
    const outcome = await allocateWithDaemonCredentials(
      allocateRequest(provider, shellFingerprint({})),
      providerCredentialsFixture({ KEY: 'key-1' }, STATE_DIR),
    );

    assert.equal(outcome.error, undefined);
    assert.equal(outcome.allocations, 1);
  },
);

test.for(PROVIDERS)(
  'a daemon started without %s credentials refuses a shell that has them',
  async (provider) => {
    const outcome = await allocateWithDaemonCredentials(
      allocateRequest(provider, shellFingerprint({ KEY: 'key-1' })),
      providerCredentialsFixture({}, STATE_DIR),
    );

    assert.equal(outcome.allocations, 0);
    assert.equal(outcome.error?.details?.reason, 'provider-credentials-changed');
    assert.match(
      String(outcome.error?.message),
      new RegExp(`started without the ${provider} credentials`),
    );
  },
);

test('a lease compares the daemon fingerprint of the leased backend only', async () => {
  const daemonFingerprints: Record<string, string> = {
    'ios-instance': 'ios-digest',
    'android-instance': 'android-digest',
  };
  const requested: Array<[string, string | undefined]> = [];
  const providerCredentials: DaemonProviderCredentials = {
    stateDir: STATE_DIR,
    fingerprint: (provider, leaseBackend) => {
      requested.push([provider, leaseBackend]);
      return leaseBackend ? daemonFingerprints[leaseBackend] : undefined;
    },
  };
  const allocate = async (leaseBackend: LeaseBackend, shellDigest: string) =>
    await allocateWithDaemonCredentials(
      allocateRequest('limrun', shellDigest, leaseBackend),
      providerCredentials,
    );

  assert.equal((await allocate('ios-instance', 'ios-digest')).error, undefined);
  assert.equal(
    (await allocate('android-instance', 'ios-digest')).error?.details?.reason,
    'provider-credentials-changed',
  );
  assert.deepEqual(requested, [
    ['limrun', 'ios-instance'],
    ['limrun', 'android-instance'],
  ]);
});
