import type {
  AppDeploymentInput,
  AppDeploymentResult,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
} from '@agent-device/contracts/app-deployment-runtime';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindDirectApplicationLifecycle,
  bindProviderApplicationLifecycleInteractor,
} from '@agent-device/contracts/application-lifecycle-interaction';
import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import type { ProviderDeviceInstallResult } from '@agent-device/contracts/device';
import {
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import {
  type DeviceBinding,
  providerRuntimeOwner,
  type RuntimeFacts,
  type RuntimeOperationFact,
  type RuntimeOperationUnavailability,
  sameRuntimeOwner,
  unavailableFact,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import { createUnavailablePlatformRuntimeFacts } from '@agent-device/contracts/platform-runtime-unavailable';
import {
  bindProviderScreenshotInteractor,
  screenshotRuntimeOperationFacts,
} from '@agent-device/contracts/screenshot-runtime';
import {
  bindProviderScrollInteractor,
  scrollRuntimeOperationFacts,
} from '@agent-device/contracts/scroll-runtime';
import {
  bindProviderSnapshotInteractor,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import { systemButtonRuntimeOperationFacts } from '@agent-device/contracts/system-button-runtime';
import {
  bindProviderTouchInteractor,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';
import {
  bindProviderTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { setTimeout as sleep } from 'node:timers/promises';
import { isSupportedNomacDevice, NOMAC_PROVIDER } from './device.ts';

const available = Object.freeze({ available: true } as const);
const unsupported = (message: string) => unavailableFact('unsupported-provider-mode', message);

/** Every operation's verdict when the device names no live NoMac phone. */
const liveSessionUnavailable = unavailableFact(
  'owner-capability-missing',
  'NoMac requires a live phone for this device; open it again to start one.',
);

// What a live NoMac phone does not serve through agent-device, each with where to go instead.
const GAPS = {
  appLog: unsupported(
    "NoMac does not stream app logs to agent-device; simulator-use's app_logs reads them on the phone.",
  ),
  apps: unsupported('NoMac does not list installed apps; open an app by its bundle id.'),
  appState: unsupported('NoMac does not report the foreground app.'),
  network: unsupported(
    "NoMac does not capture network traffic for agent-device; `simulator-use cloud tunnel` lists a local backend's requests.",
  ),
  screenRecording: unsupported(
    'NoMac records every session as its replay; it is not started from agent-device.',
  ),
  viewport: unsupported('NoMac phones keep their screen size.'),
  gesture: unsupported(
    'NoMac does not run portable gesture plans yet; tap, long press, scroll and type are available.',
  ),
  elementText: unsupported('NoMac-owned devices read element text from the captured tree only.'),
  orientation: unsupported('NoMac phones stay in portrait for now.'),
  fold: unsupported('NoMac phones have no hinge.'),
  telephony: unsupported('NoMac phones have no telephony.'),
  tvRemote: unsupported('NoMac phones have no TV remote.'),
  keyboard: unsupported(
    'NoMac does not expose keyboard actions; type, fill and back are available.',
  ),
  clipboard: unsupported('NoMac does not expose the pasteboard.'),
  systemButton: unsupported('NoMac phones press home only.'),
  settings: unsupported(
    "agent-device's settings are not mapped to NoMac yet; NoMac's own app_control sets appearance, permissions, location and text size.",
  ),
  alert: unsupported(
    "NoMac answers the phone's prompts itself (permissions granted, first-launch prompts answered).",
  ),
  audioProbe: unsupported('NoMac does not expose the audio probe.'),
  perf: unsupported('NoMac does not expose performance captures.'),
  shutdown: unsupported('NoMac owns the phone lifecycle; closing the lease stops it.'),
  customSnapshotActions: unsupported(
    'Custom snapshot actions need the Apple runner, which NoMac phones do not expose.',
  ),
  pushNotification: unsupported('Push notifications are unavailable for NoMac phones.'),
  uninstall: unsupported(
    'App uninstall is unavailable for NoMac phones; a new phone starts clean.',
  ),
  headless: unsupported('Headless boot is unavailable for provider-owned devices.'),
  runtimeHints: unsupported('Runtime hints are not applied to provider-owned devices.'),
  appleRunner: unsupported('Apple runner preparation is unavailable for NoMac phones.'),
  portReverse: unsupported(
    "NoMac phones reach a local port through `simulator-use cloud tunnel`, on a port of the phone's own.",
  ),
} satisfies Record<string, RuntimeOperationUnavailability>;

export type NomacPlatformRuntimeOwnerOptions = Readonly<{
  host: PlatformRuntimeHost;
  runtimeInstance: string;
  ownsDevice(device: DeviceInfo): boolean;
  hasLiveSession(device: DeviceInfo): boolean;
  getInteractor(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
  installApp(
    device: DeviceInfo,
    appPath: string,
    appHint: string | undefined,
    signal: AbortSignal,
  ): Promise<ProviderDeviceInstallResult | undefined>;
}>;

function lifecycleFacts(cell: RuntimeOperationFact) {
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: cell,
    prepareApplicationOpen: cell,
    openApplication: cell,
    applyRuntimeHints: GAPS.runtimeHints,
    clearRuntimeHints: GAPS.runtimeHints,
    closeApplication: cell,
    finalizeApplicationClose: cell,
    prepareAppleRunner: GAPS.appleRunner,
    configureProviderPortReverse: GAPS.portReverse,
  });
}

/** What a NoMac phone serves: everything through its one interactor, or nothing without a live phone. */
function nomacRuntimeFacts(
  owner: ReturnType<typeof providerRuntimeOwner>,
  device: DeviceInfo,
  live: boolean,
): RuntimeFacts<PlatformRuntimeOperations> {
  const cell: RuntimeOperationFact =
    live && isSupportedNomacDevice(device) ? available : liveSessionUnavailable;
  const gap = (fact: RuntimeOperationUnavailability) =>
    cell.available ? fact : liveSessionUnavailable;
  const base = createUnavailablePlatformRuntimeFacts(device, owner, {
    appLog: gap(GAPS.appLog),
    apps: gap(GAPS.apps),
    appState: gap(GAPS.appState),
    network: gap(GAPS.network),
    screenRecording: gap(GAPS.screenRecording),
    screenshot: liveSessionUnavailable,
    snapshot: liveSessionUnavailable,
    viewport: gap(GAPS.viewport),
    focus: liveSessionUnavailable,
    gesture: gap(GAPS.gesture),
    scroll: liveSessionUnavailable,
    typeText: liveSessionUnavailable,
    touch: gap(unsupported('NoMac taps, long-presses and fills at points.')),
    elementText: gap(GAPS.elementText),
    back: liveSessionUnavailable,
    orientation: gap(GAPS.orientation),
    fold: GAPS.fold,
    telephony: GAPS.telephony,
    tvRemote: GAPS.tvRemote,
    keyboard: gap(GAPS.keyboard),
    clipboard: gap(GAPS.clipboard),
    systemButton: gap(GAPS.systemButton),
    triggerAppEvent: liveSessionUnavailable,
    settings: gap(GAPS.settings),
    readAlert: gap(GAPS.alert),
    awaitAlert: gap(GAPS.alert),
    acceptAlert: gap(GAPS.alert),
    dismissAlert: gap(GAPS.alert),
    audioProbeCapture: gap(GAPS.audioProbe),
    audioProbeQuery: gap(GAPS.audioProbe),
    perf: gap(GAPS.perf),
    readiness: liveSessionUnavailable,
    shutdown: gap(GAPS.shutdown),
    lifecycle: lifecycleFacts(cell),
  });
  return Object.freeze({
    device: base.device,
    operations: Object.freeze({
      ...base.operations,
      ...snapshotRuntimeOperationFacts({
        capture: cell,
        customActions: gap(GAPS.customSnapshotActions),
        withoutActiveApp: cell,
      }),
      ...screenshotRuntimeOperationFacts({ capture: cell }),
      ...focusRuntimeOperationFacts({ focus: cell }),
      ...typeTextRuntimeOperationFacts({ type: cell }),
      ...touchRuntimeOperationFacts({
        unsupported: gap(unsupported('NoMac taps, long-presses and fills at points.')),
        tap: cell,
        longPress: cell,
        fill: cell,
      }),
      ...scrollRuntimeOperationFacts({ scroll: cell }),
      ...backRuntimeOperationFacts({ back: cell }),
      // An app event is a deep link, which the phone opens as it opens `open <url>`.
      ...appEventRuntimeOperationFacts({ triggerAppEvent: cell }),
      ...systemButtonRuntimeOperationFacts({ unsupported: gap(GAPS.systemButton), home: cell }),
      ensureReady: cell,
      bootTarget: cell,
      bootTargetHeadless: gap(GAPS.headless),
      deployApp: cell,
      materializeAppSource: cell,
      deployMaterializedApp: cell,
      sendPushNotification: gap(GAPS.pushNotification),
      uninstallApp: gap(GAPS.uninstall),
    }),
  });
}

export function createNomacPlatformRuntimeOwner(
  options: NomacPlatformRuntimeOwnerOptions,
): PlatformRuntimeOwner {
  const owner = providerRuntimeOwner(NOMAC_PROVIDER, options.runtimeInstance);
  const ownsDevice = (device: DeviceInfo) =>
    isSupportedNomacDevice(device) && options.ownsDevice(device);
  const live = (device: DeviceInfo) => ownsDevice(device) && options.hasLiveSession(device);
  return Object.freeze({
    owner,
    ownsDevice,
    inspectFacts: async (device) => nomacRuntimeFacts(owner, device, live(device)),
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError('UNSUPPORTED_OPERATION', 'NoMac runtime owner identity does not match');
      }
      if (!isSupportedNomacDevice(request.device)) {
        throw new AppError('UNSUPPORTED_PLATFORM', 'NoMac serves iOS simulators it started');
      }
      if (!live(request.device)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'The NoMac phone for this device is no longer live',
          {
            reason: 'provider-session-unavailable',
          },
        );
      }
      return bindNomacPhone(options, owner, request.device, request.scope.signal);
    },
    shutdown: async () => undefined,
  });
}

function bindNomacPhone(
  options: NomacPlatformRuntimeOwnerOptions,
  owner: ReturnType<typeof providerRuntimeOwner>,
  device: DeviceInfo,
  signal: AbortSignal,
): DeviceBinding<PlatformRuntimeOperations> {
  const facts = nomacRuntimeFacts(owner, device, true);
  const resolveInteractor = (runner: RunnerContext) => options.getInteractor(device, runner);
  const install = async (
    appPath: string,
    appHint: string | undefined,
  ): Promise<AppDeploymentResult> => {
    const result = await options.installApp(device, appPath, appHint, signal);
    if (!result)
      throw new AppError(
        'UNSUPPORTED_OPERATION',
        'The NoMac phone for this device is no longer live.',
      );
    return result;
  };
  const operations = {
    ensureReady: async () => ({ ...device, booted: true }),
    bootTarget: async () => ({ ...device, booted: true }),
    ...availableApplicationLifecycleOperations(
      bindDirectApplicationLifecycle({
        owner: 'NoMac',
        openTargetIdentity: 'bundle-id',
        closeBeforeRelaunch: true,
        binding: bindProviderApplicationLifecycleInteractor({ device, signal, resolveInteractor }),
      }),
      lifecycleFacts(available),
    ),
    ...bindProviderSnapshotInteractor({
      device,
      signal,
      resolveInteractor,
      presentIosAcquisition: options.host.snapshot.presentIosAcquisition,
    }),
    ...bindProviderScreenshotInteractor({ device, signal, resolveInteractor }),
    ...bindProviderFocusInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTypeTextInteractor({ device, signal, resolveInteractor }),
    ...bindProviderTouchInteractor({
      device,
      signal,
      resolveInteractor,
      facts: facts.operations,
      pause: async (milliseconds) => await sleep(milliseconds, undefined, { signal }),
    }),
    ...bindProviderScrollInteractor({ device, signal, resolveInteractor }),
    ...bindAdmittedProviderInteractorOperations({
      device,
      signal,
      resolveInteractor,
      facts: facts.operations,
    }),
    deployApp: async (input: AppDeploymentInput) => await install(input.appPath, input.app),
    materializeAppSource: async (input: MaterializeAppSourceInput) =>
      await options.host.appleDeployment.prepareArtifact(input, { signal }),
    deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
      await install(input.artifact.installablePath, input.artifact.bundleId),
  } satisfies DeviceBinding<PlatformRuntimeOperations>['operations'];
  return Object.freeze({
    device,
    owner,
    facts,
    operations: Object.freeze(operations),
    [Symbol.asyncDispose]: async () => undefined,
  });
}
