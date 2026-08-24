import {
  handleSessionCommands as handleProductionSessionCommands,
  type SessionCommandInput,
} from '../session.ts';
import type {
  AppDeploymentInput,
  AppDeploymentResult,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
  MaterializedAppSource,
  PushNotificationInput,
  PushNotificationResult,
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
import { screenshotRuntimeOperationFacts } from '@agent-device/contracts/screenshot-runtime';
import { snapshotRuntimeOperationFacts } from '@agent-device/contracts/snapshot-runtime';
import { touchRuntimeOperationFacts } from '@agent-device/contracts/touch-runtime';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import { deviceShape, isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { beforeEach, vi } from 'vitest';
import { applicationLifecycleRuntimeFixture } from '../../__tests__/application-lifecycle-runtime-fixture.ts';
import { withClientReplayScriptSources } from '../../../__tests__/test-utils/replay-script-source.ts';

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
export const mockBindDeviceRuntime = vi.fn(async (device: DeviceInfo, use) =>
  narrowDeviceBinding(await readinessBinding(device), use),
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
  mockBindDeviceRuntime.mockClear();
});

/** Unit-handler default is explicitly fail-closed; production must inject exact-owner recovery. */
export async function handleSessionCommands(
  params: Omit<SessionCommandInput, 'reconcileOrphanedDeviceClaim'>,
): ReturnType<typeof handleProductionSessionCommands> {
  return await handleProductionSessionCommands({
    ...params,
    req: await withClientReplayScriptSources(params.req),
    inspectFacts: params.inspectFacts ?? mockInspectDeviceRuntimeFacts,
    bindDevice: params.bindDevice ?? mockBindDeviceRuntime,
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
    bind: async ({ device }) => await readinessBinding(device),
    shutdown: async () => {},
  });

function readinessFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  const normalAvailable = supportsReadiness(device);
  const headlessAvailable = device.platform === 'android' && device.kind === 'emulator';
  const shutdownAvailable = isShutdownDevice(device);
  const deployment = deploymentAvailability(device);
  return {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      ...snapshotRuntimeOperationFacts({
        capture: unavailable,
        customActions: unavailable,
        withoutActiveApp: unavailable,
      }),
      // Mirrors the real owners: every kind this harness models except an Apple `simulator`-shaped
      // Android placeholder can capture pixels, and `capabilities` now reads this cell.
      ...screenshotRuntimeOperationFacts({
        capture: operationAvailability(device.kind !== 'simulator' || device.platform === 'apple'),
      }),
      findText: unavailable,
      findSelector: unavailable,
      setViewport: unavailable,
      focusPoint: unavailable,
      typeText: unavailable,
      ...touchRuntimeOperationFacts({
        tap: unavailable,
        longPress: unavailable,
        hover: unavailable,
        fill: unavailable,
        tapElementSelector: unavailable,
      }),
      readTextAtPoint: unavailable,
      back: unavailable,
      home: unavailable,
      setOrientation: unavailable,
      tvRemote: unavailable,
      keyboardStatus: unavailable,
      keyboardDismiss: unavailable,
      keyboardEnter: unavailable,
      deployApp: operationAvailability(deployment.deploy),
      materializeAppSource: operationAvailability(deployment.source),
      deployMaterializedApp: operationAvailability(deployment.source),
      sendPushNotification: operationAvailability(deployment.push),
      appState: operationAvailability(device.platform === 'android'),
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: operationAvailability(device.appleOs !== 'watchos'),
      bootTarget: operationAvailability(normalAvailable),
      bootTargetHeadless: operationAvailability(headlessAvailable),
      listApps: unavailable,
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
): Promise<DeviceBinding<PlatformRuntimeOperations>> {
  const facts = readinessFacts(device);
  const lifecycle = await applicationLifecycleRuntimeFixture(
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
