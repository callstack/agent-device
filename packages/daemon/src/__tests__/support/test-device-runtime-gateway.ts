import path from 'node:path';
import { vi } from 'vitest';
import {
  type ApplicationLifecycleOperationFacts,
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type DeviceBindingRequest,
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
} from '../../server/request-router.ts';
import type { BindDeviceRuntime } from '../../core/request-runtime-binding.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  applicationLifecycleRuntimeFixture,
  type LifecycleOperationsLoader,
} from './application-lifecycle-runtime-fixture.ts';
import { createUnavailableRuntimeFactsForTest } from '@agent-device/test-kit';
import { withClientReplayScriptSources } from '@agent-device/replay-port/replay-script-source-fixtures';
import type { DaemonInvokeFn } from '../../core/daemon-request.ts';
import { clearAndroidObservationFixture } from './android-observation-fixture.ts';
import {
  daemonClaimRecoveryGatewayFixture,
  daemonPlatformServicesFixture,
} from './platform-services-fixture.ts';
import { platformResourceCleanupFixture } from './platform-resource-cleanup-fixture.ts';
import { providerCredentialsFixture } from './provider-credentials-fixture.ts';
import {
  unavailableBinding,
  unavailableDeviceRuntimeGateway,
} from './unavailable-device-runtime-gateway.ts';

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

async function lifecycleBindingForTest(
  device: DeviceInfo,
  loadLifecycleOperations: LifecycleOperationsLoader = applicationLifecycleRuntimeFixture,
  signal?: AbortSignal,
) {
  const lifecycleFacts = lifecycleFactsForTest(device);
  const base = createUnavailableRuntimeFactsForTest(device, localRuntimeOwner(device.platform));
  return {
    device,
    owner: localRuntimeOwner(device.platform),
    facts: {
      device: base.device,
      operations: {
        ...base.operations,
        ...lifecycleFacts,
        ...admittedGestureFamilyFacts,
        ...admittedSystemFamilyFacts,
      },
    },
    operations: {
      ...availableApplicationLifecycleOperations(
        // The request's signal reaches the loader so a canceled request aborts the bound
        // lifecycle operations instead of handing them a fresh, uncontended signal.
        await loadLifecycleOperations(device, signal),
        lifecycleFacts,
      ),
      // The gesture family rides along: replay flows drive `scroll`/`swipe` through this gateway,
      // and R52/R53 put them on bound operations rather than the mocked dispatcher.
      ...gestureRuntimeSpies,
      // Same reason for the Wave 6 system leaves: R56 put `app-switcher` on a bound operation,
      // so router/replay flows that drive it no longer reach the mocked dispatcher either.
      ...systemRuntimeSpies,
    },
    [Symbol.asyncDispose]: async () => {},
  };
}

/** Opt-in lifecycle fixture: commands bind the canned lifecycle port after fact admission. */
export const lifecycleDeviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> =
  Object.freeze({
    inspectFacts: async (device) => (await lifecycleBindingForTest(device)).facts,
    bind: async ({ device, scope }) =>
      await lifecycleBindingForTest(device, applicationLifecycleRuntimeFixture, scope.signal),
    shutdown: async () => {},
  });

/** The same gateway shape bound to a caller-supplied lifecycle-ops loader (root composition lanes pass the real fixture). */
export function createLifecycleDeviceRuntimeGateway(
  loadLifecycleOperations: LifecycleOperationsLoader,
): DeviceRuntimeGateway<PlatformRuntimeOperations> {
  return Object.freeze({
    inspectFacts: async (device) =>
      (await lifecycleBindingForTest(device, loadLifecycleOperations)).facts,
    bind: async ({ device, scope }) =>
      await lifecycleBindingForTest(device, loadLifecycleOperations, scope.signal),
    shutdown: async () => {},
  });
}

/**
 * A fresh, unfrozen `lifecycleDeviceRuntimeGateway`-equivalent whose `inspectFacts`/`bind` are
 * `vi.fn()` spies. The shared `lifecycleDeviceRuntimeGateway` above is `Object.freeze`d and reused
 * across many router-seam suites, so it can't be spied on in place (and spying on it in place
 * would leak call counts between tests in other files) — call this per test that needs to observe
 * fact-inspection/binding call counts through the router seam.
 */
export function createLifecycleDeviceRuntimeGatewaySpies(
  loadLifecycleOperations: LifecycleOperationsLoader = applicationLifecycleRuntimeFixture,
) {
  const inspectFacts = vi.fn(
    async (device: DeviceInfo) =>
      (await lifecycleBindingForTest(device, loadLifecycleOperations)).facts,
  );
  const bind = vi.fn(
    async (request: DeviceBindingRequest) =>
      await lifecycleBindingForTest(request.device, loadLifecycleOperations, request.scope.signal),
  );
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts,
    bind,
    shutdown: async () => {},
  };
  return { gateway, inspectFacts, bind };
}

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

const admittedSystemFamilyFacts = Object.freeze({ appSwitcher: available });

export const systemRuntimeSpies = {
  appSwitcher: vi.fn(async () => undefined),
};

export const gestureRuntimeSpies = {
  captureSnapshot: vi.fn(async () => ({
    backend: 'xctest' as const,
    producer: 'apple-runner' as const,
    nodes: [],
  })),
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

export const gestureInspectFacts = gestureDeviceRuntimeGateway.inspectFacts;
export const gestureBindDevice: BindDeviceRuntime = async (device, use) =>
  narrowDeviceBinding(await gestureBinding(device), use);

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

export function createRequestHandler(
  deps: Omit<
    RequestRouterDeps,
    | 'deviceRuntimeGateway'
    | 'providerCredentials'
    | 'platformServices'
    | 'claimRecoveryGateway'
    | 'androidObservation'
    | 'platformResourceCleanup'
  > &
    Partial<
      Pick<
        RequestRouterDeps,
        | 'deviceRuntimeGateway'
        | 'providerCredentials'
        | 'platformServices'
        | 'claimRecoveryGateway'
        | 'androidObservation'
        | 'platformResourceCleanup'
      >
    >,
) {
  const {
    deviceRuntimeGateway = unavailableDeviceRuntimeGateway,
    providerCredentials = providerCredentialsFixture({}, path.dirname(deps.logPath)),
    platformServices = daemonPlatformServicesFixture(),
    claimRecoveryGateway = daemonClaimRecoveryGatewayFixture(),
    androidObservation = clearAndroidObservationFixture,
    platformResourceCleanup = platformResourceCleanupFixture(),
    ...rest
  } = deps;
  const handle = createProductionRequestHandler({
    ...rest,
    androidObservation,
    platformResourceCleanup,
    platformServices,
    claimRecoveryGateway,
    deviceRuntimeGateway,
    providerCredentials,
  });
  // #1802: stand in for the client that reads a replay script and sends its content, so router
  // cases keep naming a path while the daemon still sees only bundled sources.
  const handleWithClientScriptSources: DaemonInvokeFn = async (req) =>
    await handle(await withClientReplayScriptSources(req));
  return handleWithClientScriptSources;
}
