import type {
  DeviceBinding,
  NetworkDumpInput,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  EnsureReadyInput,
} from '@agent-device/contracts/platform';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
  bindLocalSnapshotInteractor,
  localRuntimeOwner,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAndroidAppLogRuntime } from './logs/runtime.ts';
import { dumpAndroidNetworkTraffic } from './network/runtime.ts';
import { bindAndroidScreenRecordingRuntime } from './recording/runtime.ts';
import { ensureAndroidReady } from './readiness/runtime.ts';
import { readAndroidAppState } from './app-state.ts';
import { bindAndroidApplicationLifecycle } from './lifecycle.ts';
import {
  androidAppDeploymentFacts,
  createAndroidAppDeploymentOperations,
} from './deployment/runtime.ts';

const owner = localRuntimeOwner('android');
const available = Object.freeze({ available: true } as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Headless boot is supported only for Android emulators.',
} as const);
const appStateUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Android appstate is supported only for Android emulators and devices.',
} as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Apple runner preparation is supported only for Apple targets.',
} as const);
const openTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'open is supported only for Android emulators and devices.',
} as const);
const closeTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'close is supported only for Android emulators and devices.',
} as const);
const runtimeHintsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'Runtime hints are supported only for Android emulators and devices.',
} as const);
const portReverseUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Port reverse is supported only by an owning provider runtime.',
} as const);
const shutdownKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'shutdown is supported only for Apple simulators and Android emulators.',
} as const);
const snapshotKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'snapshot is supported only for Android emulators and devices.',
} as const);
const snapshotCustomActionsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Re-run without --actions, or target an iOS simulator.',
} as const);

function androidLifecycleFacts(device: DeviceInfo) {
  const openTarget = androidOpenTargetFact(device);
  const closeTarget = androidCloseTargetFact(device);
  const runtimeHints = androidRuntimeHintsFact(device);
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: openTarget,
    prepareApplicationOpen: openTarget,
    openApplication: openTarget,
    applyRuntimeHints: runtimeHints,
    clearRuntimeHints: runtimeHints,
    closeApplication: closeTarget,
    finalizeApplicationClose: closeTarget,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: portReverseUnavailable,
  });
}

function androidOpenTargetFact(device: DeviceInfo) {
  return device.kind === 'emulator' || device.kind === 'device' ? available : openTargetUnavailable;
}

function androidCloseTargetFact(device: DeviceInfo) {
  return device.kind === 'emulator' || device.kind === 'device'
    ? available
    : closeTargetUnavailable;
}

function androidRuntimeHintsFact(device: DeviceInfo) {
  return device.kind === 'emulator' || device.kind === 'device'
    ? available
    : runtimeHintsUnavailable;
}

export function createAndroidPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const appLogs = createAndroidAppLogRuntime(host);
  const inspectFacts = async (device: Parameters<typeof appLogs.inspectFacts>[0]) => {
    const logs = await appLogs.inspectFacts(device);
    const deployment = androidAppDeploymentFacts(device);
    return Object.freeze({
      device: logs.device,
      operations: {
        ...logs.operations,
        ...deployment,
        appState: device.kind === 'simulator' ? appStateUnavailable : available,
        networkDump: available,
        screenRecordingStart: available,
        screenRecordingReattach: available,
        screenRecordingCleanup: available,
        ...snapshotRuntimeOperationFacts({
          capture: device.kind === 'simulator' ? snapshotKindUnavailable : available,
          customActions: snapshotCustomActionsUnavailable,
          withoutActiveApp: device.kind === 'simulator' ? snapshotKindUnavailable : available,
        }),
        ensureReady: available,
        bootTarget: available,
        bootTargetHeadless: device.kind === 'emulator' ? available : headlessUnavailable,
        listApps: available,
        ...androidLifecycleFacts(device),
        shutdownTarget: device.kind === 'emulator' ? available : shutdownKindUnavailable,
      },
    });
  };
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'android',
    inspectFacts,
    bind: async (request) => {
      const logs = await appLogs.bind(request);
      const facts = await inspectFacts(request.device);
      const recording = await bindAndroidScreenRecordingRuntime({
        host,
        device: request.device,
        owner,
        signal: request.scope.signal,
      });
      return Object.freeze({
        device: logs.device,
        owner,
        facts,
        operations: Object.freeze({
          ...logs.operations,
          ...createAndroidAppDeploymentOperations({
            host,
            device: request.device,
            signal: request.scope.signal,
          }),
          ...(facts.operations.appState.available
            ? {
                appState: async () =>
                  await readAndroidAppState(
                    host.appState.android,
                    request.device,
                    request.scope.signal,
                  ),
              }
            : {}),
          networkDump: async (input: NetworkDumpInput) =>
            await dumpAndroidNetworkTraffic(host, request.device, input, request.scope.signal),
          ...recording,
          ...(facts.operations.captureSnapshot.available
            ? bindLocalSnapshotInteractor({
                device: request.device,
                signal: request.scope.signal,
                resolveInteractor: host.localInteractors.resolve,
              })
            : {}),
          ensureReady: async (input: EnsureReadyInput) =>
            await ensureAndroidReady(
              host,
              request.device,
              { ...input, headless: false },
              request.scope.signal,
            ),
          bootTarget: async (input: EnsureReadyInput) =>
            await ensureAndroidReady(
              host,
              request.device,
              { ...input, headless: false },
              request.scope.signal,
            ),
          ...(facts.operations.bootTargetHeadless.available
            ? {
                bootTargetHeadless: async (input: EnsureReadyInput) =>
                  await ensureAndroidReady(
                    host,
                    request.device,
                    { ...input, headless: true },
                    request.scope.signal,
                  ),
              }
            : {}),
          listApps: async (input: { device: DeviceInfo; filter: 'all' | 'user-installed' }) =>
            await host.appInventory.android.listApps(
              input.device,
              input.filter,
              request.scope.signal,
            ),
          ...availableApplicationLifecycleOperations(
            bindAndroidApplicationLifecycle({
              host,
              device: request.device,
              signal: request.scope.signal,
            }),
            facts.operations,
          ),
          ...(facts.operations.shutdownTarget.available
            ? {
                shutdownTarget: async () =>
                  await host.deviceShutdown.android.shutdownTarget(
                    request.device,
                    request.scope.signal,
                  ),
              }
            : {}),
        }),
        [Symbol.asyncDispose]: async () => await logs[Symbol.asyncDispose](),
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => await appLogs.shutdown(),
  });
}
