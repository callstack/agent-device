import { vi } from 'vitest';
import {
  type ApplicationLifecycleOperationFacts,
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type DeviceRuntimeGateway,
  localRuntimeOwner,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { GesturePlanInput } from '@agent-device/contracts/gesture-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { ScrollDirectionInput } from '@agent-device/contracts/scroll-runtime';
import {
  createRequestHandler as createProductionRequestHandler,
  type RequestRouterDeps,
} from '../request-router.ts';
import type { BindDeviceRuntime, BindExactDeviceRuntime } from '../request-runtime-binding.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { applicationLifecycleRuntimeFixture } from './application-lifecycle-runtime-fixture.ts';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../__tests__/test-utils/runtime-operation-facts.ts';
import { withClientReplayScriptSources } from '../../__tests__/test-utils/replay-script-source.ts';
import type { DaemonInvokeFn } from '../types.ts';

const unavailable = Object.freeze({
  available: false as const,
  reason: 'owner-capability-missing' as const,
});
const available = Object.freeze({ available: true as const });

function lifecycleFactsForTest(device: DeviceInfo): ApplicationLifecycleOperationFacts {
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: available,
    prepareApplicationOpen: available,
    openApplication: available,
    applyRuntimeHints: available,
    clearRuntimeHints: available,
    closeApplication: available,
    finalizeApplicationClose: available,
    prepareAppleRunner: device.platform === 'apple' ? available : unavailable,
    configureProviderPortReverse: unavailable,
  });
}

async function lifecycleBindingForTest(device: DeviceInfo) {
  const lifecycleFacts = lifecycleFactsForTest(device);
  return {
    device,
    owner: localRuntimeOwner(device.platform),
    facts: {
      device: {
        family: device.platform,
        kind: device.kind,
        providerMode: 'local' as const,
        ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
        ...(device.target === undefined ? {} : { target: device.target }),
        ...(device.iosPhysicalDeviceBackend === undefined
          ? {}
          : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
      },
      operations: {
        ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
        appLogInspect: unavailable,
        appLogDoctor: unavailable,
        appLogStart: unavailable,
        appLogReattach: unavailable,
        appLogCleanup: unavailable,
        appState: unavailable,
        networkDump: unavailable,
        screenRecordingStart: unavailable,
        screenRecordingReattach: unavailable,
        screenRecordingCleanup: unavailable,
        ensureReady: unavailable,
        bootTarget: unavailable,
        bootTargetHeadless: unavailable,
        listApps: unavailable,
        ...lifecycleFacts,
        ...admittedGestureFamilyFacts,
      },
    },
    operations: {
      ...availableApplicationLifecycleOperations(
        await applicationLifecycleRuntimeFixture(device),
        lifecycleFacts,
      ),
      // The gesture family rides along: replay flows drive `scroll`/`swipe` through this gateway,
      // and R52/R53 put them on bound operations rather than the mocked dispatcher.
      ...gestureRuntimeSpies,
    },
    [Symbol.asyncDispose]: async () => {},
  };
}

/** Opt-in lifecycle fixture: commands bind the real root host after fact admission. */
export const lifecycleDeviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> =
  Object.freeze({
    inspectFacts: async (device) => (await lifecycleBindingForTest(device)).facts,
    bind: async ({ device }) => await lifecycleBindingForTest(device),
    shutdown: async () => {},
  });

export const unavailableDeviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> =
  Object.freeze({
    inspectFacts: async (device) => (await unavailableBinding(device)).facts,
    bind: async ({ device }) => ({
      device,
      owner: localRuntimeOwner(device.platform),
      facts: {
        device: {
          family: device.platform,
          kind: device.kind,
          providerMode: 'local',
          ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
          ...(device.target === undefined ? {} : { target: device.target }),
          ...(device.iosPhysicalDeviceBackend === undefined
            ? {}
            : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
        },
        operations: {
          ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
          appLogInspect: unavailable,
          appLogDoctor: unavailable,
          appLogStart: unavailable,
          appLogReattach: unavailable,
          appLogCleanup: unavailable,
          appState: unavailable,
          networkDump: unavailable,
          screenRecordingStart: unavailable,
          screenRecordingReattach: unavailable,
          screenRecordingCleanup: unavailable,
          ensureReady: unavailable,
          bootTarget: unavailable,
          bootTargetHeadless: unavailable,
          listApps: unavailable,
          ...applicationLifecycleOperationFacts({
            resolveOpenTarget: unavailable,
            prepareApplicationOpen: unavailable,
            openApplication: unavailable,
            applyRuntimeHints: unavailable,
            clearRuntimeHints: unavailable,
            closeApplication: unavailable,
            finalizeApplicationClose: unavailable,
            prepareAppleRunner: unavailable,
            configureProviderPortReverse: unavailable,
          }),
        },
      },
      operations: {},
      [Symbol.asyncDispose]: async () => {},
    }),
    shutdown: async () => {},
  });

/**
 * Spies for the gesture surface a router-level test drives. They replace the retired
 * `dispatchGesturePlan` / `dispatchGestureViewport` module mocks: gestures now reach the platform
 * through a bound operation, so the observation point is the operation, not the dispatcher.
 */
/** The gesture-family cells a gateway admits when it stands in for a working owner. */
const admittedGestureFamilyFacts = Object.freeze({
  captureSnapshot: available,
  performGesturePlan: available,
  performDirectionalFlingPlan: available,
  performMultiTouchGesturePlan: available,
  performTargetAuthoredDrag: available,
  gestureViewport: available,
  scrollDirection: available,
});

export const gestureRuntimeSpies = {
  captureSnapshot: vi.fn(async () => ({ backend: 'xctest' as const, nodes: [] })),
  performGesturePlan: vi.fn(async (_input: GesturePlanInput) => ({})),
  performDirectionalFlingPlan: vi.fn(async (_input: GesturePlanInput) => ({})),
  performMultiTouchGesturePlan: vi.fn(async (_input: GesturePlanInput) => ({})),
  performTargetAuthoredDrag: vi.fn(async (_input: GesturePlanInput) => ({})),
  gestureViewport: vi.fn(async () => ({ x: 0, y: 0, width: 390, height: 844 })),
  scrollDirection: vi.fn(async (_input: ScrollDirectionInput) => ({})),
};

/** The unavailable gateway plus an admitted gesture/scroll surface. */
export const gestureDeviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> =
  Object.freeze({
    inspectFacts: async (device) => (await gestureBinding(device)).facts,
    bind: async (request) => await gestureBinding(request.device),
    shutdown: async () => {},
  });

async function gestureBinding(device: DeviceInfo) {
  const base = await unavailableBinding(device);
  return {
    ...base,
    facts: {
      ...base.facts,
      operations: {
        ...base.facts.operations,
        ...admittedGestureFamilyFacts,
      },
    },
    operations: { ...base.operations, ...gestureRuntimeSpies },
  } as unknown as Awaited<ReturnType<DeviceRuntimeGateway<PlatformRuntimeOperations>['bind']>>;
}

async function unavailableBinding(device: DeviceInfo) {
  return await unavailableDeviceRuntimeGateway.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
}

export const unavailableBindDevice: BindDeviceRuntime = async (device, use) =>
  narrowDeviceBinding(await unavailableBinding(device), use);

export const unavailableInspectFacts = unavailableDeviceRuntimeGateway.inspectFacts;

export const unavailableBindExactDevice: BindExactDeviceRuntime = async (
  device,
  owner,
  fence,
  use,
  scope,
) =>
  narrowDeviceBinding(
    await unavailableDeviceRuntimeGateway.bind({
      device,
      intent: { kind: 'exact-owner', owner, fence },
      scope,
    }),
    use,
  );

export function createRequestHandler(
  deps: Omit<RequestRouterDeps, 'deviceRuntimeGateway'> &
    Partial<Pick<RequestRouterDeps, 'deviceRuntimeGateway'>>,
) {
  const { deviceRuntimeGateway = unavailableDeviceRuntimeGateway, ...rest } = deps;
  const handle = createProductionRequestHandler({ ...rest, deviceRuntimeGateway });
  // #1802: stand in for the client that reads a replay script and sends its content, so router
  // cases keep naming a path while the daemon still sees only bundled sources.
  const handleWithClientScriptSources: DaemonInvokeFn = async (req) =>
    await handle(await withClientReplayScriptSources(req));
  return handleWithClientScriptSources;
}
