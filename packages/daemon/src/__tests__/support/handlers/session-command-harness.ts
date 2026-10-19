import { handleSessionCommands as handleProductionSessionCommands } from '../../../sessions/handlers/session.ts';
import type { SessionCommandInput } from '../../../sessions/handlers/session-command-input.ts';
import type {
  AppDeploymentInput,
  AppDeploymentResult,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
  MaterializedAppSource,
  PushNotificationInput,
  PushNotificationResult,
  AppUninstallInput,
  AppUninstallResult,
} from '@agent-device/contracts/app-deployment-runtime';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import type { EnsureReadyInput } from '@agent-device/contracts/device-readiness-runtime';
import {
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { beforeEach, vi } from 'vitest';
import {
  applicationLifecycleRuntimeFixture,
  type LifecycleOperationsLoader,
} from '../application-lifecycle-runtime-fixture.ts';
import { withClientReplayScriptSources } from '../replay-script-source-fixture.ts';
import { createUnavailableRuntimeFactsForTest } from '@agent-device/test-kit';
import { platformResourceCleanupFixture } from '../platform-resource-cleanup-fixture.ts';

const unavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);
const available = Object.freeze({ available: true } as const);

export const mockInspectDeviceRuntimeFacts = vi.fn(async (device: DeviceInfo) =>
  readinessFacts(device),
);
export const mockEnsureReadyRuntime = vi.fn(
  async (_input: EnsureReadyInput): Promise<DeviceInfo | undefined> => undefined,
);
export const mockEnsureReadyHeadlessRuntime = vi.fn(
  async (_input: EnsureReadyInput): Promise<DeviceInfo | undefined> => undefined,
);
export const mockShutdownTargetRuntime = vi.fn(async (): Promise<TargetShutdownResult> => ({
  success: true,
  exitCode: 0,
  stdout: '',
  stderr: '',
}));
export const mockDeployAppRuntime = vi.fn(
  async (_input: AppDeploymentInput): Promise<AppDeploymentResult> => ({}),
);
export const mockMaterializeAppSourceRuntime = vi.fn(
  async (_input: MaterializeAppSourceInput): Promise<MaterializedAppSource> => ({
    installablePath: '/tmp/materialized-app',
    cleanup: async () => {},
  }),
);
export const mockDeployMaterializedAppRuntime = vi.fn(
  async (_input: DeployMaterializedAppInput): Promise<AppDeploymentResult> => ({}),
);
export const mockPushNotificationRuntime = vi.fn(
  async (_input: PushNotificationInput): Promise<PushNotificationResult> => ({}),
);
export const mockUninstallAppRuntime = vi.fn(
  async (_input: AppUninstallInput): Promise<AppUninstallResult> => ({ wasInstalled: false }),
);
export const mockBindDeviceRuntime = vi.fn(
  async (
    device: DeviceInfo,
    use,
    loadLifecycleOperations: LifecycleOperationsLoader = applicationLifecycleRuntimeFixture,
  ) => narrowDeviceBinding(await readinessBinding(device, loadLifecycleOperations), use),
);

beforeEach(() => {
  mockInspectDeviceRuntimeFacts.mockClear();
  mockEnsureReadyRuntime.mockClear();
  mockEnsureReadyHeadlessRuntime.mockClear();
  mockShutdownTargetRuntime.mockReset();
  mockShutdownTargetRuntime.mockResolvedValue({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  mockDeployAppRuntime.mockReset();
  mockDeployAppRuntime.mockResolvedValue({});
  mockMaterializeAppSourceRuntime.mockReset();
  mockMaterializeAppSourceRuntime.mockResolvedValue({
    installablePath: '/tmp/materialized-app',
    cleanup: async () => {},
  });
  mockDeployMaterializedAppRuntime.mockReset();
  mockDeployMaterializedAppRuntime.mockResolvedValue({});
  mockPushNotificationRuntime.mockReset();
  mockPushNotificationRuntime.mockResolvedValue({});
  mockUninstallAppRuntime.mockReset();
  mockUninstallAppRuntime.mockResolvedValue({ wasInstalled: false });
  mockBindDeviceRuntime.mockClear();
});

/**
 * Unit-handler default is explicitly fail-closed; production must inject exact-owner recovery.
 * `lifecycleOperationsLoader` points the harness bindings at another lifecycle-ops fixture —
 * root composition suites pass the real composed fixture per call, exactly like the gateway
 * factories take theirs; calls without it keep the canned port fixture default.
 */
export async function handleSessionCommands(
  params: Omit<SessionCommandInput, 'reconcileOrphanedDeviceClaim'> &
    Readonly<{ lifecycleOperationsLoader?: LifecycleOperationsLoader }>,
): ReturnType<typeof handleProductionSessionCommands> {
  const { lifecycleOperationsLoader, ...commandParams } = params;
  return await handleProductionSessionCommands({
    ...commandParams,
    req: await withClientReplayScriptSources(params.req),
    inspectFacts: params.inspectFacts ?? mockInspectDeviceRuntimeFacts,
    bindDevice:
      params.bindDevice ??
      (lifecycleOperationsLoader === undefined
        ? mockBindDeviceRuntime
        : (device, use) => mockBindDeviceRuntime(device, use, lifecycleOperationsLoader)),
    platformResourceCleanup: params.platformResourceCleanup ?? platformResourceCleanupFixture(),
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained',
      reason: 'test-harness-has-no-exact-owner-recovery',
    }),
  });
}

/**
 * The harness bindings as a gateway, so a test can drive the real
 * `createRequestExecutionScope` seam instead of injecting `bindDevice` directly.
 */
export const readinessDeviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> =
  Object.freeze({
    inspectFacts: async (device: DeviceInfo) => readinessFacts(device),
    bind: async ({ device }) => await readinessBinding(device, applicationLifecycleRuntimeFixture),
    shutdown: async () => {},
  });

function readinessFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  const normalAvailable = supportsReadiness(device);
  const headlessAvailable = device.platform === 'android' && device.kind === 'emulator';
  const shutdownAvailable = isShutdownDevice(device);
  const deployment = deploymentAvailability(device);
  const base = createUnavailableRuntimeFactsForTest(device, localRuntimeOwner(device.platform));
  return {
    device: base.device,
    operations: {
      ...base.operations,
      // Mirrors the real owners: every kind this harness models except an Apple `simulator`-shaped
      // Android placeholder can capture pixels, and `capabilities` now reads this cell.
      captureScreenshot: operationAvailability(
        device.kind !== 'simulator' || device.platform === 'apple',
      ),
      deployApp: operationAvailability(deployment.deploy),
      materializeAppSource: operationAvailability(deployment.source),
      deployMaterializedApp: operationAvailability(deployment.source),
      sendPushNotification: operationAvailability(deployment.push),
      uninstallApp: operationAvailability(deployment.uninstall),
      appState: operationAvailability(device.platform === 'android'),
      ensureReady: operationAvailability(device.appleOs !== 'watchos'),
      bootTarget: operationAvailability(normalAvailable),
      bootTargetHeadless: operationAvailability(headlessAvailable),
      shutdownTarget: shutdownAvailable ? available : unavailable,
      ...applicationLifecycleOperationFacts({
        resolveOpenTarget: available,
        prepareApplicationOpen: available,
        openApplication: available,
        applyRuntimeHints: available,
        clearRuntimeHints: available,
        closeApplication: available,
        finalizeApplicationClose: available,
        prepareAppleRunner: device.platform === 'apple' ? available : unavailable,
        configureProviderPortReverse: unavailable,
      }),
    },
  };
}

function isShutdownDevice(device: DeviceInfo): boolean {
  return isIosFamily(device) && device.appleOs !== 'watchos'
    ? device.kind === 'simulator'
    : device.platform === 'android' && device.kind === 'emulator';
}

function operationAvailability(supported: boolean): typeof available | typeof unavailable {
  return supported ? available : unavailable;
}

async function readinessBinding(
  device: DeviceInfo,
  loadLifecycleOperations: LifecycleOperationsLoader,
): Promise<DeviceBinding<PlatformRuntimeOperations>> {
  const facts = readinessFacts(device);
  const lifecycle = await loadLifecycleOperations(
    device,
    new AbortController().signal,
    async () => await mockShutdownTargetRuntime(),
  );
  return {
    device,
    owner: localRuntimeOwner(device.platform),
    facts,
    operations: {
      ensureReady: async (input) =>
        (await mockEnsureReadyRuntime(input)) ?? { ...device, booted: true },
      ...(device.platform === 'android'
        ? { appState: async () => ({ package: 'com.example.app', activity: '.MainActivity' }) }
        : {}),
      ...(facts.operations.bootTarget.available
        ? {
            bootTarget: async (input) =>
              (await mockEnsureReadyRuntime(input)) ?? { ...device, booted: true },
          }
        : {}),
      listApps: async () => [],
      ...(facts.operations.bootTargetHeadless.available
        ? {
            bootTargetHeadless: async (input) =>
              (await mockEnsureReadyHeadlessRuntime(input)) ?? { ...device, booted: true },
          }
        : {}),
      ...(facts.operations.shutdownTarget.available
        ? {
            shutdownTarget: async () =>
              (await mockShutdownTargetRuntime()) ?? {
                success: true,
                exitCode: 0,
                stdout: '',
                stderr: '',
              },
          }
        : {}),
      ...(facts.operations.deployApp.available
        ? {
            deployApp: async (input) => await mockDeployAppRuntime(input),
          }
        : {}),
      ...(facts.operations.materializeAppSource.available
        ? {
            materializeAppSource: async (input) => await mockMaterializeAppSourceRuntime(input),
            deployMaterializedApp: async (input) => await mockDeployMaterializedAppRuntime(input),
          }
        : {}),
      ...(facts.operations.sendPushNotification.available
        ? {
            sendPushNotification: async (input) => await mockPushNotificationRuntime(input),
          }
        : {}),
      ...(facts.operations.uninstallApp.available
        ? {
            uninstallApp: async (input) => await mockUninstallAppRuntime(input),
          }
        : {}),
      ...lifecycle,
    },
    [Symbol.asyncDispose]: async () => {},
  };
}

function supportsReadiness(device: DeviceInfo): boolean {
  return (
    (device.platform === 'apple' && device.appleOs !== 'macos' && device.appleOs !== 'watchos') ||
    device.platform === 'android'
  );
}

function deploymentAvailability(device: DeviceInfo) {
  const deploy = supportsDeployment(device);
  return {
    deploy,
    source: deploy && (device.platform === 'apple' || device.platform === 'android'),
    push:
      device.platform === 'android' || (device.platform === 'apple' && device.kind === 'simulator'),
    uninstall:
      deploy &&
      ((device.platform === 'apple' && (device.kind === 'simulator' || device.kind === 'device')) ||
        (device.platform === 'android' &&
          (device.kind === 'emulator' || device.kind === 'device'))),
  };
}

function supportsDeployment(device: DeviceInfo): boolean {
  if (device.platform === 'apple') {
    return (
      device.appleOs !== 'macos' &&
      device.appleOs !== 'watchos' &&
      !(device.kind === 'device' && device.iosPhysicalDeviceBackend === 'xctest')
    );
  }
  return device.platform === 'android' || device.platform === 'harmonyos';
}
