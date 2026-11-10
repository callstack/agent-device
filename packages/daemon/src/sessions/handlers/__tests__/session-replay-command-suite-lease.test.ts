import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { DeviceLease } from '@agent-device/contracts/device';
import { handleSessionCommands } from '../../../__tests__/support/handlers/session-command-harness.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import { makeAndroidSession } from '../../../__tests__/support/session-factories.ts';
import { storeSessionForTest } from '../../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../../resources/lease-registry.ts';
import {
  expectOkData,
  makeSessionStore,
} from '../../__tests__/replay-suite/session-test-suite.fixtures.ts';
import {
  bindTestCommandHost,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';

bindTestCommandHost();

test('suite-owned test-session close releases a non-retained provider lease through the provider', async () => {
  const sessionStore = makeSessionStore();
  const leaseRegistry = new LeaseRegistry();
  const release = vi.fn(async (_lease: DeviceLease) => ({}));
  const root = mkdtempForTestSync('agent-device-test-suite-provider-lease-');
  fs.writeFileSync(path.join(root, '01-open.ad'), 'context platform=android\nopen "Settings"\n');
  let leaseId: string | undefined;

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'test',
      positionals: [root],
      meta: { cwd: root, requestId: 'suite-provider-lease' },
      flags: {},
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider: { release },
    invoke: async (req) => {
      const lease = leaseRegistry.allocateLease({
        tenantId: 'tenant-a',
        runId: 'run-1',
        leaseBackend: 'android-instance',
        leaseProvider: 'proxy',
      });
      leaseId = lease.leaseId;
      storeSessionForTest(
        sessionStore,
        makeAndroidSession(req.session, {
          lease: {
            leaseId: lease.leaseId,
            tenantId: lease.tenantId,
            runId: lease.runId,
            leaseBackend: lease.backend,
            leaseProvider: lease.leaseProvider,
          },
        }),
        req.session,
      );
      return { ok: true, data: {} };
    },
  });

  expect(expectOkData(response).passed).toBe(1);
  expect(release).toHaveBeenCalledOnce();
  expect(release.mock.calls[0]?.[0]).toMatchObject({ leaseId });
});
