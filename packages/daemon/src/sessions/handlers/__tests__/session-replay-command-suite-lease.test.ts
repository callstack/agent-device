import { AppError } from '@agent-device/kernel/errors';
import type { WithSessionExecutionLock } from '../../../core/session-store.ts';
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

test.each(['uncontended', 'retry', 'replacement'] as const)(
  'suite-owned test-session close respects its pinned lifetime with %s cleanup',
  async (cleanup) => {
    const sessionStore = makeSessionStore();
    const leaseRegistry = new LeaseRegistry();
    const release = vi.fn(async (_lease: DeviceLease) => ({ release: 'confirmed' as const }));
    const root = mkdtempForTestSync('agent-device-test-suite-provider-lease-');
    fs.writeFileSync(path.join(root, '01-open.ad'), 'context platform=android\nopen "Settings"\n');
    const lease = leaseRegistry.allocateLease({
      tenantId: 'tenant-a',
      runId: 'run-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'proxy',
    });

    let deviceAcquisitions = 0;
    const withSessionExecutionLock: WithSessionExecutionLock = async (address, task) => {
      try {
        return await task(async () => {
          if (++deviceAcquisitions === 1 && cleanup !== 'uncontended')
            throw new AppError('DEVICE_IN_USE', 'Fixture device lock is busy', {
              reason: 'DEVICE_EXECUTION_LOCK_BUSY',
            });
        });
      } catch (error) {
        if (cleanup === 'replacement') {
          const incumbent = sessionStore.lookup(address)!;
          sessionStore.retire(incumbent);
          sessionStore.publish(
            address,
            makeAndroidSession(address, { appBundleId: 'com.example.replacement' }),
          );
        }
        throw error;
      }
    };
    let attemptAddress = '';
    const response = await handleSessionCommands({
      host: createTestHostEnvironment(),
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      req: {
        token: 't',
        session: 'default',
        command: 'test',
        positionals: [root],
        meta: { cwd: root, requestId: 'suite-provider-lease', leaseId: lease.leaseId },
        flags: {},
      },
      sessionName: 'default',
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      sessionStore,
      leaseRegistry,
      leaseLifecycleProvider: { release },
      withSessionExecutionLock,
      invoke: async (req) => {
        attemptAddress = req.session;
        storeSessionForTest(
          sessionStore,
          makeAndroidSession(req.session, {
            lease: {
              leaseId: lease.leaseId,
              tenantId: lease.tenantId,
              runId: lease.runId,
              backend: lease.backend,
              leaseProvider: lease.leaseProvider,
            },
          }),
          req.session,
        );
        return { ok: true, data: {} };
      },
    });

    expect(expectOkData(response).passed).toBe(1);
    if (cleanup === 'replacement') {
      expect(deviceAcquisitions).toBe(1);
      expect(release).not.toHaveBeenCalled();
      expect(sessionStore.get(attemptAddress)?.appBundleId).toBe('com.example.replacement');
    } else {
      expect(deviceAcquisitions).toBe(cleanup === 'retry' ? 2 : 1);
      expect(release).toHaveBeenCalledOnce();
      expect(release.mock.calls[0]?.[0]).toMatchObject({ leaseId: lease.leaseId });
      expect(sessionStore.get(attemptAddress)).toBeUndefined();
    }
  },
);
