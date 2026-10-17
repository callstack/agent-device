import type { ApplicationLifecycleResourceLifecycle } from '@agent-device/contracts/application-lifecycle-runtime';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createOwnedProcessRecordStore } from '@agent-device/host-kit/process';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { vi } from 'vitest';
import type {
  ComposeDaemonRuntimeDeps,
  DaemonRuntimeDeps,
  DaemonRuntimeDepsInput,
} from '../../server/http/daemon-runtime.ts';
import type { PlatformOwnerLifecycle } from '../../core/platform-owner-lifecycle.ts';
import { clearAndroidObservationFixture } from './android-observation-fixture.ts';
import { fakeCreateCommandSurface } from './command-surface-fake.ts';
import { hostDiagnosticsFixture } from './host-diagnostics-fixture.ts';
import { platformResourceCleanupFixture } from './platform-resource-cleanup-fixture.ts';
import {
  daemonClaimRecoveryGatewayFixture,
  daemonPlatformServicesFixture,
} from './platform-services-fixture.ts';
import { providerCredentialsFixture } from './provider-credentials-fixture.ts';
import { lifecycleDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';

/** The durable lifecycle phases the runtime runs at startup and shutdown, as spies. */
export function applicationLifecycleResourceFixture(
  overrides: Partial<ApplicationLifecycleResourceLifecycle> = {},
): ApplicationLifecycleResourceLifecycle {
  return Object.freeze({
    recoverStartupResources: vi.fn(async () => {}),
    detachForDaemonShutdown: vi.fn(async (): Promise<readonly string[]> => []),
    finalizeDaemonShutdown: vi.fn(async (): Promise<readonly string[]> => []),
    ...overrides,
  });
}

/** Every member observable as a spy, which is how the runtime suites read the owner back. */
export function platformOwnerLifecycleFixture(
  overrides: Partial<PlatformOwnerLifecycle> = {},
): PlatformOwnerLifecycle {
  return Object.freeze({
    configureForDaemonLock: vi.fn(async () => {}),
    clearDaemonLockConfiguration: vi.fn(async () => {}),
    recoverLegacyAppLogMarkers: vi.fn(async () => ({ recovered: [], retained: [] })),
    cleanupManagedWebOrphans: vi.fn(async () => {}),
    resetAndroidSnapshotHelper: vi.fn(async () => {}),
    ...overrides,
  });
}

/**
 * The `composeDeps` factory a daemon-runtime suite hands `startDaemonRuntime`: every capability the
 * root composition would supply is an inert port, so a suite exercises the server's own lifecycle,
 * idle, lease, and shutdown decisions. A suite that cares about one capability replaces just that
 * member, receiving the paths and session callbacks the server owns.
 */
export function daemonRuntimeDepsFixture(
  overrides:
    | Partial<DaemonRuntimeDeps>
    | ((input: DaemonRuntimeDepsInput) => Partial<DaemonRuntimeDeps>) = {},
): ComposeDaemonRuntimeDeps {
  return async (input) => {
    const resolved = typeof overrides === 'function' ? overrides(input) : overrides;
    return Object.freeze({
      runtimeStates: [],
      ownedProcessRecords: createOwnedProcessRecordStore({
        stateDir: input.baseDir,
        sessionsDir: input.sessionsDir,
        resolveSessionDir: input.resolveSessionDir,
      }),
      hostDiagnostics: hostDiagnosticsFixture(),
      ownerLifecycle: platformOwnerLifecycleFixture(),
      shutdownProviderRuntimes: async () => [],
      pluginInventory: [],
      providerRuntimeIds: [],
      recoverableProviderIds: [],
      deviceRuntimeGateway: Object.freeze({
        ...lifecycleDeviceRuntimeGateway,
        applicationLifecycle: applicationLifecycleResourceFixture(),
      }),
      platformResourceCleanup: platformResourceCleanupFixture(),
      claimRecoveryGateway: daemonClaimRecoveryGatewayFixture(),
      interactorResolution: Object.freeze({
        resolve: async () => {
          throw new Error('daemon runtime fixture: no interactor is composed');
        },
      }),
      providerDeviceAdmission: Object.freeze({ isActive: () => false }),
      cleanupManagedWebOrphans: async () => {},
      requestRouter: Object.freeze({
        deviceInventoryGateways: createTestDeviceInventoryGateways(),
        platformServices: daemonPlatformServicesFixture(),
        androidObservation: clearAndroidObservationFixture,
        providerCredentials: providerCredentialsFixture(input.host.env, input.baseDir),
        createCommandSurface: fakeCreateCommandSurface,
      }),
      ...resolved,
    });
  };
}

/**
 * A plugin registry over provider runtimes, as the composition hands it to the daemon: the
 * inventory of active plugins and the one `close` that shuts each runtime down and answers with a
 * per-plugin outcome.
 */
export function pluginRegistryFixture(
  runtimes: readonly Pick<ProviderDeviceRuntime, 'provider' | 'shutdown'>[],
): Pick<DaemonRuntimeDeps, 'pluginInventory' | 'shutdownProviderRuntimes'> {
  return {
    pluginInventory: runtimes.map((runtime) => ({
      provider: runtime.provider,
      source: 'builtin' as const,
      state: 'active' as const,
      credentials: { variables: [], byBackend: {} },
    })),
    shutdownProviderRuntimes: async () =>
      await Promise.all(
        runtimes.map(async (runtime) => {
          try {
            await runtime.shutdown();
            return {
              provider: runtime.provider,
              source: 'builtin' as const,
              shutdown: { status: 'ok' as const },
              dispose: { status: 'ok' as const },
            };
          } catch (error) {
            return {
              provider: runtime.provider,
              source: 'builtin' as const,
              shutdown: {
                status: 'failed' as const,
                error: {
                  code: 'COMMAND_FAILED',
                  message: error instanceof Error ? error.message : String(error),
                },
              },
              dispose: { status: 'ok' as const },
            };
          }
        }),
      ),
  };
}
