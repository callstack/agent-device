import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
  localRuntimeOwner,
  narrowDeviceBinding,
  type ApplicationLifecycleOperationFacts,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
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
      },
    },
    operations: availableApplicationLifecycleOperations(
      await applicationLifecycleRuntimeFixture(device),
      lifecycleFacts,
    ),
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
