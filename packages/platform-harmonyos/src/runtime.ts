import type {
  DeviceBinding,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
  bindLocalScreenshotInteractor,
  bindLocalSnapshotInteractor,
  localRuntimeOwner,
  screenshotRuntimeOperationFacts,
  snapshotRuntimeOperationFacts,
  viewportRuntimeOperationFacts,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createHarmonyAppLogRuntime } from './logs/runtime.ts';
import {
  createHarmonyScreenRecordingOperations,
  harmonyScreenRecordingFacts,
} from './recording/runtime.ts';
import { readHarmonyAppState } from './app-state.ts';
import { bindHarmonyApplicationLifecycle } from './lifecycle.ts';
import {
  createHarmonyAppDeploymentOperations,
  harmonyAppDeploymentFacts,
} from './deployment/runtime.ts';

const owner = localRuntimeOwner('harmonyos');
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
} as const);
const appStateUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'HarmonyOS appstate is supported only for HarmonyOS emulators and devices.',
} as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Apple runner preparation is supported only for Apple targets.',
} as const);

const lifecycleAvailable = Object.freeze({ available: true } as const);
const openTargetKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'open is supported only for HarmonyOS emulators and devices.',
} as const);
const closeTargetKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'close is supported only for HarmonyOS emulators and devices.',
} as const);
const portReverseUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Port reverse is supported only by an owning provider runtime.',
} as const);
const snapshotKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'snapshot is supported only for HarmonyOS emulators and devices.',
} as const);
const screenshotKindUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: 'screenshot is supported only for HarmonyOS emulators and devices.',
} as const);
const snapshotCustomActionsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Re-run without --actions, or target an iOS simulator.',
} as const);
const viewportUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'viewport resizes web targets only (--platform web).',
} as const);

function harmonyLifecycleFacts(device: DeviceInfo) {
  const openTarget = harmonyOpenTargetFact(device);
  const closeTarget = harmonyCloseTargetFact(device);
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: openTarget,
    prepareApplicationOpen: openTarget,
    openApplication: openTarget,
    applyRuntimeHints: unavailable,
    clearRuntimeHints: unavailable,
    closeApplication: closeTarget,
    finalizeApplicationClose: closeTarget,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: portReverseUnavailable,
  });
}

function harmonyOpenTargetFact(device: DeviceInfo) {
  return device.kind === 'emulator' || device.kind === 'device'
    ? lifecycleAvailable
    : openTargetKindUnavailable;
}

function harmonyCloseTargetFact(device: DeviceInfo) {
  return device.kind === 'emulator' || device.kind === 'device'
    ? lifecycleAvailable
    : closeTargetKindUnavailable;
}

export function createHarmonyPlatformRuntime(host: PlatformRuntimeHost): PlatformRuntimeOwner {
  const appLogs = createHarmonyAppLogRuntime(host);
  const inspectFacts = async (device: Parameters<typeof appLogs.inspectFacts>[0]) => {
    const logs = await appLogs.inspectFacts(device);
    const deployment = harmonyAppDeploymentFacts(device);
    const recordingFacts = harmonyScreenRecordingFacts(device);
    return Object.freeze({
      device: logs.device,
      operations: {
        ...logs.operations,
        ...deployment,
        appState: device.kind === 'simulator' ? appStateUnavailable : available,
        networkDump: unavailable,
        screenRecordingStart: recordingFacts,
        screenRecordingReattach: recordingFacts,
        screenRecordingCleanup: recordingFacts,
        ...snapshotRuntimeOperationFacts({
          capture:
            device.kind === 'emulator' || device.kind === 'device'
              ? available
              : snapshotKindUnavailable,
          customActions: snapshotCustomActionsUnavailable,
          withoutActiveApp:
            device.kind === 'emulator' || device.kind === 'device'
              ? available
              : snapshotKindUnavailable,
        }),
        ...screenshotRuntimeOperationFacts({
          capture:
            device.kind === 'emulator' || device.kind === 'device'
              ? available
              : screenshotKindUnavailable,
        }),
        ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
        ensureReady: available,
        bootTarget: unavailable,
        bootTargetHeadless: unavailable,
        listApps: available,
        ...harmonyLifecycleFacts(device),
        shutdownTarget: unavailable,
      },
    });
  };
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === 'harmonyos',
    inspectFacts,
    bind: async (request) => {
      const logs = await appLogs.bind(request);
      const facts = await inspectFacts(request.device);
      const recordingFacts = facts.operations.screenRecordingStart;
      return Object.freeze({
        device: logs.device,
        owner,
        facts,
        operations: Object.freeze({
          ...logs.operations,
          ...createHarmonyAppDeploymentOperations({
            commands: host.commands,
            device: request.device,
            signal: request.scope.signal,
          }),
          ...(facts.operations.appState.available
            ? {
                appState: async () =>
                  await readHarmonyAppState(
                    host.appState.harmonyos,
                    request.device,
                    request.scope.signal,
                  ),
              }
            : {}),
          ensureReady: async () => ({ ...request.device, booted: true }),
          ...(recordingFacts.available
            ? createHarmonyScreenRecordingOperations({
                host,
                device: request.device,
                owner,
                signal: request.scope.signal,
              })
            : {}),
          ...(facts.operations.captureSnapshot.available
            ? bindLocalSnapshotInteractor({
                device: request.device,
                signal: request.scope.signal,
                resolveInteractor: host.localInteractors.resolve,
              })
            : {}),
          ...(facts.operations.captureScreenshot.available
            ? bindLocalScreenshotInteractor({
                device: request.device,
                signal: request.scope.signal,
                resolveInteractor: host.localInteractors.resolve,
              })
            : {}),
          listApps: async (input: { device: DeviceInfo; filter: 'all' | 'user-installed' }) =>
            await host.appInventory.harmonyos.listApps(
              input.device,
              input.filter,
              request.scope.signal,
            ),
          ...availableApplicationLifecycleOperations(
            bindHarmonyApplicationLifecycle({
              host: host.localInteractors,
              device: request.device,
              signal: request.scope.signal,
            }),
            facts.operations,
          ),
        }),
        [Symbol.asyncDispose]: async () => await logs[Symbol.asyncDispose](),
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => await appLogs.shutdown(),
  });
}
