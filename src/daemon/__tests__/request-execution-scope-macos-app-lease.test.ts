import { expect, test } from 'vitest';
import { makeMacOsSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { parseDaemonPolicy } from '../../daemon-policy-file.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestExecutionScope } from '../request-execution-scope.ts';

const LEASE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

function putLease(leaseRegistry: LeaseRegistry) {
  return leaseRegistry.putHostLease(LEASE_ID, {
    tenantId: 'stim',
    runId: 'session-1',
    clientId: 'client-1',
    leaseBackend: 'macos-app',
    leaseProvider: 'proxy',
    deviceKey: 'com.example.app',
  });
}

const LEASE_META = {
  tenantId: 'stim',
  runId: 'session-1',
  leaseId: LEASE_ID,
  leaseBackend: 'macos-app',
  clientId: 'client-1',
  leaseProvider: 'proxy',
  deviceKey: 'com.example.app',
} as const;

async function runScoped(params: {
  req: Omit<DaemonRequest, 'token' | 'session' | 'positionals'> &
    Partial<Pick<DaemonRequest, 'positionals'>>;
  sessionStore: ReturnType<typeof makeSessionStore>;
  leaseRegistry: LeaseRegistry;
  daemonPolicy?: ReturnType<typeof parseDaemonPolicy>;
}): Promise<{ ran: boolean; error?: unknown }> {
  const scope = await createRequestExecutionScope({
    req: { token: 't', session: 'default', positionals: [], ...params.req },
    sessionStore: params.sessionStore,
    leaseRegistry: params.leaseRegistry,
    daemonPolicy: params.daemonPolicy,
  });
  let ran = false;
  try {
    await scope.runLocked(async () => {
      ran = true;
    });
    return { ran };
  } catch (error) {
    return { ran, error };
  }
}

test('a daemon that requires a macos-app lease refuses lease-exempt inventory commands', async () => {
  const sessionStore = makeSessionStore('agent-device-macos-app-policy-');
  const leaseRegistry = new LeaseRegistry();
  putLease(leaseRegistry);
  const daemonPolicy = parseDaemonPolicy(
    { version: 1, leases: { require: 'macos-app' } },
    '/policy.json',
  );
  for (const command of ['doctor', 'session_list']) {
    const unleased = await runScoped({
      req: { command, flags: { platform: 'macos' } },
      sessionStore,
      leaseRegistry,
      daemonPolicy,
    });
    expect(unleased.ran).toBe(false);
    expect(unleased.error).toMatchObject({
      code: 'UNAUTHORIZED',
      details: { reason: 'DAEMON_POLICY_DENIED', rule: 'lease' },
    });
    const leased = await runScoped({
      req: { command, flags: { platform: 'macos' }, meta: LEASE_META },
      sessionStore,
      leaseRegistry,
      daemonPolicy,
    });
    expect(leased.ran).toBe(false);
    expect(leased.error).toMatchObject({
      code: 'UNAUTHORIZED',
      details: { reason: 'MACOS_APP_LEASE_DENIED', rule: 'command', command },
    });
  }
  const heartbeat = await runScoped({
    req: { command: 'lease_heartbeat', flags: {}, meta: LEASE_META },
    sessionStore,
    leaseRegistry,
    daemonPolicy,
  });
  expect(heartbeat).toEqual({ ran: true });
});

test('a request under a pid-pinned macos-app lease does not run once that process is gone', async () => {
  const sessionStore = makeSessionStore('agent-device-macos-app-scope-');
  const leaseRegistry = new LeaseRegistry();
  const deviceKey = 'com.example.app@2147483646';
  const lease = leaseRegistry.putHostLease('a1b2c3d4e5f60718293a4b5c6d7e8f90', {
    tenantId: 'stim',
    runId: 'session-1',
    leaseBackend: 'macos-app',
    deviceKey,
  });
  sessionStore.publish(
    'default',
    makeMacOsSession('default', {
      appBundleId: 'com.example.app',
      lease: {
        leaseId: lease.leaseId,
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseBackend: lease.backend,
        deviceKey,
      },
    }),
  );
  const scope = await createRequestExecutionScope({
    req: { token: 't', session: 'default', command: 'snapshot', positionals: [], flags: {} },
    sessionStore,
    leaseRegistry,
  });
  let ran = false;
  await expect(
    scope.runLocked(async () => {
      ran = true;
    }),
  ).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
    details: { reason: 'MACOS_APP_LEASE_DENIED', rule: 'process' },
  });
  expect(ran).toBe(false);
});
