import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { handleLeaseCommands } from '@agent-device/daemon/testing/handlers/lease';
import { LeaseRegistry } from '@agent-device/daemon/testing/lease-registry';
import type { DaemonRequest } from '@agent-device/daemon';
import { makeSessionStore } from '@agent-device/daemon/testing/__tests__/support/store-factory';
import { AppError } from '@agent-device/kernel/errors';
import {
  providerCredentialFingerprint,
  readDaemonProviderCredentials,
} from '../../../provider-credential-fingerprint.ts';
import { pluginHome, selectPluginManifest } from '@agent-device/test-kit/plugin.fixtures';

/**
 * Lease refusal compares the client's credential fingerprint against the digest the daemon
 * computes from its own startup environment through the real root fingerprint reader and the
 * installed-plugin manifest registry. Those digests and manifest lookups are the composition
 * this suite pins, so it lives root-owned; lease mechanics stay in the daemon suite.
 */

function allocateRequest(): DaemonRequest {
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
      leaseBackend: 'android-instance',
      leaseProvider: 'cloud',
    },
  };
}

const LIMRUN_ATTACH_ENV = {
  LIMRUN_API_KEY: 'lim-key',
  LIM_IOS_INSTANCE_URL: 'https://region.limrun.example/v1/ios_x/api',
  LIM_IOS_INSTANCE_TOKEN: 'ios-token',
};
const BROWSERSTACK_ENV = { BROWSERSTACK_USERNAME: 'user', BROWSERSTACK_ACCESS_KEY: 'key-1' };

function providerAllocateRequest(
  leaseProvider: string,
  providerCredentialFingerprint: string | undefined,
  leaseBackend: 'ios-instance' | 'android-instance' = 'ios-instance',
): DaemonRequest {
  const request = allocateRequest();
  return {
    ...request,
    meta: {
      ...request.meta,
      leaseProvider,
      leaseBackend,
      providerCredentialFingerprint,
    },
  };
}

async function allocateWithDaemonEnv(
  req: DaemonRequest,
  daemonEnv: Record<string, string>,
): Promise<{ allocations: number; error?: AppError }> {
  const registry = new LeaseRegistry();
  let allocations = 0;
  try {
    await handleLeaseCommands({
      req,
      sessionName: req.session,
      sessionStore: makeSessionStore('agent-device-provider-credentials-'),
      leaseRegistry: registry,
      providerCredentials: readDaemonProviderCredentials(daemonEnv, '/tmp/agent device state'),
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

test('a daemon started with only LIMRUN_API_KEY refuses a shell with instance variables before allocation', async () => {
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest('limrun', providerCredentialFingerprint('limrun', LIMRUN_ATTACH_ENV)),
    { LIMRUN_API_KEY: 'lim-key' },
  );

  assert.equal(outcome.allocations, 0);
  assert.equal(outcome.error?.code, 'INVALID_ARGS');
  assert.equal(outcome.error?.details?.reason, 'provider-credentials-changed');
  assert.equal(outcome.error?.details?.provider, 'limrun');
  assert.match(
    String(outcome.error?.details?.hint),
    /agent-device daemon stop --state-dir '\/tmp\/agent device state'/,
  );
});

test('a Limrun lease compares only the leased platform instance variables', async () => {
  const daemonEnv = {
    ...LIMRUN_ATTACH_ENV,
    LIM_ANDROID_INSTANCE_URL: 'https://region.limrun.example/v1/android_x/api',
    LIM_ANDROID_INSTANCE_TOKEN: 'android-token',
    LIM_ANDROID_INSTANCE_ADB_URL: 'wss://region.limrun.example/v1/android_x/adb',
  };
  const shellEnv = { ...daemonEnv, LIM_ANDROID_INSTANCE_TOKEN: 'android-token-2' };
  const allocate = async (leaseBackend: 'ios-instance' | 'android-instance') =>
    await allocateWithDaemonEnv(
      providerAllocateRequest(
        'limrun',
        providerCredentialFingerprint('limrun', shellEnv, leaseBackend),
        leaseBackend,
      ),
      daemonEnv,
    );

  assert.equal((await allocate('ios-instance')).error, undefined);
  assert.equal(
    (await allocate('android-instance')).error?.details?.reason,
    'provider-credentials-changed',
  );
});

test('a daemon holding rotated BrowserStack keys refuses before allocation', async () => {
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest(
      'browserstack',
      providerCredentialFingerprint('browserstack', {
        ...BROWSERSTACK_ENV,
        BROWSERSTACK_ACCESS_KEY: 'key-2',
      }),
    ),
    BROWSERSTACK_ENV,
  );

  assert.equal(outcome.allocations, 0);
  assert.equal(outcome.error?.details?.reason, 'provider-credentials-changed');
  assert.equal(outcome.error?.details?.provider, 'browserstack');
});

test.for([
  ['limrun', LIMRUN_ATTACH_ENV],
  ['browserstack', BROWSERSTACK_ENV],
] as const)(
  'a daemon holding the %s credentials of the shell allocates',
  async ([provider, env]) => {
    const outcome = await allocateWithDaemonEnv(
      providerAllocateRequest(provider, providerCredentialFingerprint(provider, env)),
      env,
    );

    assert.equal(outcome.error, undefined);
    assert.equal(outcome.allocations, 1);
  },
);

test('a daemon holding credentials allocates for a shell with none', async () => {
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest('limrun', providerCredentialFingerprint('limrun', {})),
    { LIMRUN_API_KEY: 'lim-key' },
  );

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.allocations, 1);
});

test('a daemon started without BrowserStack credentials refuses a shell that has them', async () => {
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest(
      'browserstack',
      providerCredentialFingerprint('browserstack', BROWSERSTACK_ENV),
    ),
    {},
  );

  assert.equal(outcome.allocations, 0);
  assert.equal(outcome.error?.details?.reason, 'provider-credentials-changed');
  assert.match(String(outcome.error?.message), /started without the browserstack credentials/);
});

function testMuPluginEnv(): Record<string, string> {
  const manifest = path.resolve(
    import.meta.dirname,
    '../../../../packages/provider-testmu/package.json',
  );
  const { home, env } = pluginHome();
  selectPluginManifest(home, JSON.parse(fs.readFileSync(manifest, 'utf8')));
  return env;
}

test('a daemon holding other TestMu AI credentials refuses before allocation', async () => {
  const home = testMuPluginEnv();
  const daemonEnv = { ...home, LT_USERNAME: 'user', LT_ACCESS_KEY: 'key-1' };
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest(
      'testmu',
      providerCredentialFingerprint('testmu', { ...daemonEnv, LT_ACCESS_KEY: 'key-2' }),
    ),
    daemonEnv,
  );

  assert.equal(outcome.allocations, 0);
  assert.equal(outcome.error?.code, 'INVALID_ARGS');
  assert.equal(outcome.error?.details?.reason, 'provider-credentials-changed');
  assert.equal(outcome.error?.details?.provider, 'testmu');
});

test('a daemon holding the TestMu AI credentials of the shell allocates', async () => {
  const env = { ...testMuPluginEnv(), LT_USERNAME: 'user', LT_ACCESS_KEY: 'key-1' };
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest('testmu', providerCredentialFingerprint('testmu', env)),
    env,
  );

  assert.equal(outcome.error, undefined);
  assert.equal(outcome.allocations, 1);
});

test('a daemon started without TestMu AI credentials refuses a shell that has them', async () => {
  const home = testMuPluginEnv();
  const outcome = await allocateWithDaemonEnv(
    providerAllocateRequest(
      'testmu',
      providerCredentialFingerprint('testmu', {
        ...home,
        LT_USERNAME: 'user',
        LT_ACCESS_KEY: 'key-1',
      }),
    ),
    home,
  );

  assert.equal(outcome.allocations, 0);
  assert.equal(outcome.error?.details?.reason, 'provider-credentials-changed');
  assert.match(String(outcome.error?.message), /started without the testmu credentials/);
});
