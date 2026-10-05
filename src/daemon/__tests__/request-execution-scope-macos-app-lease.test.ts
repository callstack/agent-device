import { expect, test } from 'vitest';
import { makeMacOsSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestExecutionScope } from '../request-execution-scope.ts';

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
