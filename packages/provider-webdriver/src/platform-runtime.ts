import type {
  AppDeploymentInput,
  DeployMaterializedAppInput,
  MaterializeAppSourceInput,
  MaterializedAppSource,
} from '@agent-device/contracts/app-deployment-runtime';
import {
  applicationLifecycleOperationFacts,
  availableApplicationLifecycleOperations,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import {
  bindProviderFocusInteractor,
  focusRuntimeOperationFacts,
} from '@agent-device/contracts/focus-runtime';
import { PHYSICAL_IOS_MULTI_TOUCH_UNSUPPORTED_HINT } from '@agent-device/contracts/gesture-admission';
import {
  bindProviderGestureInteractor,
  gestureRuntimeOperationFacts,
} from '@agent-device/contracts/gesture-runtime';
import {
  bindProviderScrollInteractor,
  scrollRuntimeOperationFacts,
} from '@agent-device/contracts/scroll-runtime';
import { homeRuntimeOperationFacts } from '@agent-device/contracts/home-runtime';
import { bindAdmittedProviderInteractorOperations } from '@agent-device/contracts/interactor-operation-catalog';
import { appEventRuntimeOperationFacts } from '@agent-device/contracts/app-event-runtime';
import { alertRuntimeOperationFacts } from '@agent-device/contracts/alert-runtime';
import { settingsRuntimeOperationFacts } from '@agent-device/contracts/settings-runtime';
import { appSwitcherRuntimeOperationFacts } from '@agent-device/contracts/app-switcher-runtime';
import { clipboardRuntimeOperationFacts } from '@agent-device/contracts/clipboard-runtime';
import { keyboardRuntimeOperationFacts } from '@agent-device/contracts/keyboard-runtime';
import { orientationRuntimeOperationFacts } from '@agent-device/contracts/orientation-runtime';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import {
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOperationFact,
  type RuntimeOperationUnavailability,
  type RuntimeOwnerRef,
  sameRuntimeOwner,
  whenAdmitted,
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
  bindProviderSnapshotInteractor,
  snapshotRuntimeOperationFacts,
} from '@agent-device/contracts/snapshot-runtime';
import {
  bindProviderTypeTextInteractor,
  typeTextRuntimeOperationFacts,
} from '@agent-device/contracts/type-text-runtime';
import {
  bindProviderTouchInteractor,
  touchRuntimeOperationFacts,
} from '@agent-device/contracts/touch-runtime';
import { viewportRuntimeOperationFacts } from '@agent-device/contracts/viewport-runtime';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import { readRecentNetworkTrafficFromText } from '@agent-device/capture-kit';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { WebDriverDeploymentRuntime } from './runtime-deployment.ts';
import { bindWebDriverApplicationLifecycle } from './lifecycle.ts';
import {
  capabilitySupported,
  unsupportedCapabilityMessage,
  type CloudWebDriverOperation,
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';

type WebDriverPlatformDeploymentRuntime = Pick<
  WebDriverDeploymentRuntime,
  'fact' | 'deployApp' | 'deployMaterializedApp'
>;

const available = Object.freeze({ available: true } as const);
const appLogUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
} as const);
const recordingUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose screen recording.',
} as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Headless boot is unavailable for provider-owned devices.',
} as const);
const appsUnavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing' as const,
  hint: 'WebDriver provider runtimes do not expose app inventory.',
});
const deploymentUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose app deployment.',
} as const);
const pushUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Push notifications are unavailable for WebDriver provider-owned devices.',
} as const);
const inactiveSession = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'The WebDriver provider session is no longer active for this device.',
} as const);
const snapshotUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose snapshot capture for this device.',
} as const);
const screenshotUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose screenshot capture for this device.',
} as const);
const snapshotCustomActionsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose iOS simulator custom snapshot actions.',
} as const);
const viewportUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose viewport resizing.',
} as const);

/**
 * A point read is a local-tool operation (adb uiautomator, the XCUITest runner, the macOS
 * helper). A WebDriver owner's transport carries none of them, so the owner reports no live
 * read and `get` answers from the captured tree; provider ownership never borrows the local
 * family read.
 */
const focusUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose focus for this device.',
} as const);
const typeUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose text entry for this device.',
} as const);
const gestureUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose gestures for this device.',
} as const);
const scrollUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose scrolling for this device.',
} as const);
const physicalIosMultiTouchUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind',
  hint: PHYSICAL_IOS_MULTI_TOUCH_UNSUPPORTED_HINT,
} as const);
const elementTextUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes read element text from the captured tree only.',
} as const);
const backUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose back for this device.',
} as const);
const homeUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose home for this device.',
} as const);
const orientationUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose orientation for this device.',
} as const);
/** The WebDriver interactor's own `tvRemote` always throws unsupported (no capability declares
 * it), so this cell is unavailable unconditionally rather than gated by interactor reachability. */
const tvRemoteUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose tv-remote.',
} as const);
/**
 * The retired leaf never routed `keyboard` through provider resolution at all — it dispatched
 * directly by device platform, bypassing the interactor/provider seam entirely. Restating that as
 * a fact means declaring it honestly unavailable here rather than guessing at untested provider
 * behavior; see the unit record for the narrowing this states explicitly.
 */
const keyboardUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose keyboard actions.',
} as const);

/**
 * The interactor's own `readClipboard`/`writeClipboard` call `requireSupport('clipboard.read')` /
 * `('clipboard.write')`, so a provider whose declared capability map refuses the extension still
 * refuses at call time. This cell states the seam the same way `back`/`home` do: what the fact
 * answers is whether this runtime has a reachable interactor to ask at all.
 */
const clipboardUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose clipboard access for this device.',
} as const);

/**
 * `appSwitcher` calls `requireSupport('appSwitcher')` inside the interactor, so a provider whose
 * declared capability map refuses the button still refuses at call time. This cell states the
 * seam the same way `back`/`home` do: whether this runtime has a reachable interactor to ask.
 */
const appSwitcherUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose the app switcher for this device.',
} as const);

/**
 * The WebDriver interactor's own `setSetting` always throws unsupported (its capability map
 * declares `settings: unsupported`), so this cell is unavailable unconditionally rather than
 * gated by interactor reachability — the same shape `tvRemote` takes.
 */
/**
 * Same shape as `settings`: the WebDriver interactor's own alert legs always throw unsupported
 * (its capability map declares `alert: unsupported`), so this cell is unavailable unconditionally
 * rather than gated by interactor reachability.
 */
const alertUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose native alert handling.',
} as const);

const settingsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose device settings.',
} as const);

const appEventUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose app-event delivery for this device.',
} as const);

const appStateUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose a foreground app-state operation.',
} as const);
const audioProbeUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'This WebDriver provider runtime does not expose the audio probe.',
} as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Apple runner preparation is unavailable for WebDriver-owned devices.',
} as const);
const openTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver open is supported only for its owned iOS or Android mobile-device sessions.',
} as const);
const closeTargetUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver close is supported only for its owned iOS or Android mobile-device sessions.',
} as const);
const runtimeHintsUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Runtime hints are not applied to provider-owned devices.',
} as const);
const portReverseUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'WebDriver provider runtimes do not expose port reverse.',
} as const);

function webDriverLifecycleFacts(device: DeviceInfo) {
  const selectedMobileDevice =
    (device.platform === 'android' && device.kind === 'device' && device.target === 'mobile') ||
    (device.platform === 'apple' &&
      device.kind === 'device' &&
      device.target === 'mobile' &&
      device.appleOs === 'ios');
  const target = selectedMobileDevice ? available : openTargetUnavailable;
  const close = selectedMobileDevice ? available : closeTargetUnavailable;
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: target,
    prepareApplicationOpen: target,
    openApplication: target,
    applyRuntimeHints: runtimeHintsUnavailable,
    clearRuntimeHints: runtimeHintsUnavailable,
    closeApplication: close,
    finalizeApplicationClose: close,
    prepareAppleRunner: prepareUnavailable,
    configureProviderPortReverse: portReverseUnavailable,
  });
}
/** How this provider instance was configured: identity, session liveness, and declared capture. */
export type WebDriverPlatformRuntimeOptions = Readonly<{
  host: PlatformRuntimeHost;
  owner: Extract<RuntimeOwnerRef, { kind: 'provider-runtime' }>;
  ownsDevice(device: DeviceInfo): boolean;
  isSessionActive?(device: DeviceInfo): boolean;
  deployment?: WebDriverPlatformDeploymentRuntime;
  /**
   * The provider's declared capability map — the same one `webdriver-interactor.ts` refuses
   * against at call time. Fact generation reads it so an operation this provider declares
   * unsupported is stated unavailable up front instead of admitted and then thrown out of
   * (ADR 0019 §2: no stubs that throw `unsupported` after binding).
   */
  capabilities: CloudWebDriverProviderCapabilities;
  screenshotAvailable?: boolean;
  snapshotAvailable?: boolean;
  getInteractor?(device: DeviceInfo, runner?: RunnerContext): Interactor | undefined;
}>;

export function createWebDriverPlatformRuntimeOwner(
  options: WebDriverPlatformRuntimeOptions,
): PlatformRuntimeOwner {
  return Object.freeze({
    owner: options.owner,
    ownsDevice: options.ownsDevice,
    inspectFacts: async (device) => webDriverFacts(options, device),
    bind: async (request) => {
      if (
        request.intent.kind === 'exact-owner' &&
        !sameRuntimeOwner(request.intent.owner, options.owner)
      ) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'WebDriver runtime owner identity does not match',
        );
      }
      if (!options.ownsDevice(request.device)) {
        throw new AppError('UNSUPPORTED_PLATFORM', 'WebDriver runtime does not own this device');
      }
      if (!webDriverSessionActive(options, request.device)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'The WebDriver provider session is no longer active for this device.',
        );
      }
      return bindWebDriverPlatformRuntime(options, request.device, request.scope.signal);
    },
    shutdown: async () => undefined,
  });
}

/** The seven interactor-backed operations, each independently gated by its own admitted fact. */
function webDriverInteractionOperations(
  options: WebDriverPlatformRuntimeOptions,
  device: DeviceInfo,
  signal: AbortSignal,
  facts: RuntimeFacts<PlatformRuntimeOperations>,
): Partial<DeviceBinding<PlatformRuntimeOperations>['operations']> {
  const resolver = {
    device,
    signal,
    resolveInteractor: (runner: RunnerContext) => options.getInteractor?.(device, runner),
  };
  return {
    ...(facts.operations.captureSnapshot.available ? bindProviderSnapshotInteractor(resolver) : {}),
    ...(facts.operations.captureScreenshot.available
      ? bindProviderScreenshotInteractor(resolver)
      : {}),
    ...(facts.operations.focusPoint.available ? bindProviderFocusInteractor(resolver) : {}),
    ...(facts.operations.typeText.available ? bindProviderTypeTextInteractor(resolver) : {}),
    ...bindProviderGestureInteractor({ ...resolver, facts: facts.operations }),
    ...(facts.operations.scrollDirection.available ? bindProviderScrollInteractor(resolver) : {}),
    ...bindAdmittedProviderInteractorOperations({
      ...resolver,
      facts: facts.operations,
    }),
    ...whenAdmitted(facts.operations.tapPoint, () =>
      bindProviderTouchInteractor({
        ...resolver,
        facts: facts.operations,
        pause: async (milliseconds) => await options.host.clock.sleep(milliseconds, signal),
      }),
    ),
  };
}

function bindWebDriverPlatformRuntime(
  options: WebDriverPlatformRuntimeOptions,
  device: DeviceInfo,
  signal: AbortSignal,
): DeviceBinding<PlatformRuntimeOperations> {
  const backend = device.platform === 'apple' ? 'ios-device' : 'android';
  const facts = webDriverFacts(options, device);
  const deploy = facts.operations.deployApp;
  const operations: DeviceBinding<PlatformRuntimeOperations>['operations'] = Object.freeze({
    ensureReady: async () => ({ ...device, booted: true }),
    bootTarget: async () => ({ ...device, booted: true }),
    ...availableApplicationLifecycleOperations(
      bindWebDriverApplicationLifecycle({
        device,
        signal,
        getInteractor: (selectedDevice, runner) => options.getInteractor?.(selectedDevice, runner),
      }),
      facts.operations,
    ),
    ...webDriverInteractionOperations(options, device, signal, facts),
    networkDump: async (input) => {
      const recent = await options.host.appLogs.readRecent(input.sessionId, input.maxScanLines);
      const dump = readRecentNetworkTrafficFromText(recent.text, {
        ...input,
        path: recent.path,
        exists: recent.exists,
        lineNumberOffset: recent.skippedLines,
        backend,
      });
      return Object.freeze({
        source: 'app-log' as const,
        backend,
        dump,
        notes: Object.freeze(
          dump.entries.length === 0
            ? ['No HTTP(s) entries were found in recent session app logs.']
            : [],
        ),
      });
    },
    ...(deploy.available && options.deployment
      ? {
          deployApp: async (input: AppDeploymentInput) =>
            await options.deployment!.deployApp(device, input, signal),
          materializeAppSource: async (input: MaterializeAppSourceInput) =>
            await materializeWebDriverSource(options.host, device, input, signal),
          deployMaterializedApp: async (input: DeployMaterializedAppInput) =>
            await options.deployment!.deployMaterializedApp(device, input, signal),
        }
      : {}),
  });
  return Object.freeze({
    device,
    owner: options.owner,
    facts,
    operations,
    [Symbol.asyncDispose]: async () => undefined,
  });
}

/** A cell this provider serves through its own interactor: reachability is the whole gate. */
function interactorCell(
  reachable: boolean,
  whenUnreachable: RuntimeOperationUnavailability,
): RuntimeOperationFact {
  return reachable ? available : whenUnreachable;
}

/**
 * Reachability AND the provider's own declaration. `webdriver-interactor.ts` refuses at call time
 * through `capabilitySupported`, so admission reads the same predicate and the same map: a
 * provider configured with `capabilityOverrides: { 'clipboard.read': 'unsupported' }` now refuses
 * at admission, where the caller can see it in `capabilities`, instead of binding and throwing.
 *
 * The refusal carries the provider's own note, so the message a caller sees is the one the
 * capability map author wrote.
 */
function declaredCapabilityCell(
  params: Readonly<{
    reachable: boolean;
    capabilities: CloudWebDriverProviderCapabilities;
    operation: CloudWebDriverOperation;
    whenUnreachable: RuntimeOperationUnavailability;
  }>,
): RuntimeOperationFact {
  if (!params.reachable) return params.whenUnreachable;
  if (capabilitySupported(params.capabilities, params.operation)) return available;
  return Object.freeze({
    available: false,
    reason: 'owner-capability-missing',
    hint: unsupportedCapabilityMessage(params.capabilities, params.operation),
  } as const);
}

function webDriverFacts(
  options: Omit<WebDriverPlatformRuntimeOptions, 'host'>,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  if (!webDriverSessionActive(options, device)) {
    return createUnavailablePlatformRuntimeFacts(device, options.owner, {
      appLog: inactiveSession,
      appDeployment: inactiveSession,
      network: inactiveSession,
      screenRecording: inactiveSession,
      screenshot: inactiveSession,
      viewport: inactiveSession,
      focus: inactiveSession,
      gesture: inactiveSession,
      scroll: inactiveSession,
      typeText: inactiveSession,
      touch: inactiveSession,
      elementText: inactiveSession,
      back: inactiveSession,
      home: inactiveSession,
      orientation: inactiveSession,
      tvRemote: inactiveSession,
      keyboardStatus: inactiveSession,
      keyboardDismiss: inactiveSession,
      keyboardEnter: inactiveSession,
      readClipboard: inactiveSession,
      writeClipboard: inactiveSession,
      appSwitcher: inactiveSession,
      triggerAppEvent: inactiveSession,
      setSetting: inactiveSession,
      readAlert: inactiveSession,
      awaitAlert: inactiveSession,
      acceptAlert: inactiveSession,
      dismissAlert: inactiveSession,
      audioProbeCapture: inactiveSession,
      audioProbeQuery: inactiveSession,
      lifecycle: applicationLifecycleOperationFacts({
        resolveOpenTarget: inactiveSession,
        prepareApplicationOpen: inactiveSession,
        openApplication: inactiveSession,
        applyRuntimeHints: inactiveSession,
        clearRuntimeHints: inactiveSession,
        closeApplication: inactiveSession,
        finalizeApplicationClose: inactiveSession,
        prepareAppleRunner: inactiveSession,
        configureProviderPortReverse: inactiveSession,
      }),
    });
  }
  const deployment = options.deployment?.fact(device) ?? deploymentUnavailable;
  const unavailable = createUnavailablePlatformRuntimeFacts(device, options.owner, {
    appLog: appLogUnavailable,
    appDeployment: deploymentUnavailable,
    network: appLogUnavailable,
    screenRecording: recordingUnavailable,
    screenshot: screenshotUnavailable,
    viewport: viewportUnavailable,
    focus: focusUnavailable,
    gesture: gestureUnavailable,
    scroll: scrollUnavailable,
    typeText: typeUnavailable,
    touch: typeUnavailable,
    elementText: elementTextUnavailable,
    back: backUnavailable,
    home: homeUnavailable,
    orientation: orientationUnavailable,
    tvRemote: tvRemoteUnavailable,
    keyboardStatus: keyboardUnavailable,
    keyboardDismiss: keyboardUnavailable,
    keyboardEnter: keyboardUnavailable,
    readClipboard: clipboardUnavailable,
    writeClipboard: clipboardUnavailable,
    appSwitcher: appSwitcherUnavailable,
    triggerAppEvent: appEventUnavailable,
    setSetting: settingsUnavailable,
    readAlert: alertUnavailable,
    awaitAlert: alertUnavailable,
    acceptAlert: alertUnavailable,
    dismissAlert: alertUnavailable,
    audioProbeCapture: audioProbeUnavailable,
    audioProbeQuery: audioProbeUnavailable,
    lifecycle: webDriverLifecycleFacts(device),
  });
  // Both capture cells need the same reachability: an interactor this provider can drive, on a
  // device shape it supports. Each then adds its own declared-capability gate.
  const reachable = options.getInteractor !== undefined && webDriverInteractorDevice(device);
  const snapshotCell =
    reachable && options.snapshotAvailable !== false ? available : snapshotUnavailable;
  const screenshotCell =
    reachable && options.screenshotAvailable !== false ? available : screenshotUnavailable;
  // One binding of the shared predicate, so every keyed operation below reads the same way.
  const declared = (
    operation: CloudWebDriverOperation,
    whenUnreachable: RuntimeOperationUnavailability,
  ) =>
    declaredCapabilityCell({
      reachable,
      capabilities: options.capabilities,
      operation,
      whenUnreachable,
    });
  return Object.freeze({
    device: unavailable.device,
    operations: {
      ...unavailable.operations,
      deployApp: deployment,
      materializeAppSource: deployment,
      deployMaterializedApp: deployment,
      sendPushNotification: pushUnavailable,
      appState: appStateUnavailable,
      networkDump: available,
      ...snapshotRuntimeOperationFacts({
        capture: snapshotCell,
        customActions: snapshotCustomActionsUnavailable,
        withoutActiveApp: snapshotCell,
      }),
      ...screenshotRuntimeOperationFacts({ capture: screenshotCell }),
      // Focus rides the same provider interactor the captures do, so it needs the same
      // reachability and nothing more: this provider drives touch wherever it can drive a capture.
      ...focusRuntimeOperationFacts({ focus: interactorCell(reachable, focusUnavailable) }),
      ...typeTextRuntimeOperationFacts({ type: declared('type', typeUnavailable) }),
      ...touchRuntimeOperationFacts({
        tap: declared('tap', focusUnavailable),
        tapRef: focusUnavailable,
        longPress: declared('longPress', focusUnavailable),
        hover: focusUnavailable,
        hoverRef: focusUnavailable,
        fill: declared('fill', typeUnavailable),
        fillRef: typeUnavailable,
        tapElementSelector: focusUnavailable,
      }),
      // Gestures and scrolling ride the same provider interactor the captures do, so they need the
      // same reachability. The one extra gate is the retired multi-touch policy: this provider only
      // ever owns physical devices, and two-finger synthesis on a physical iOS device was refused
      // before this migration exactly as it is refused here.
      ...gestureRuntimeOperationFacts({
        plan: interactorCell(reachable, gestureUnavailable),
        directionalFling: interactorCell(reachable, gestureUnavailable),
        multiTouch: webDriverMultiTouchCell(device, reachable),
        targetAuthoredDrag: interactorCell(reachable, gestureUnavailable),
        viewport: interactorCell(reachable, gestureUnavailable),
      }),
      ...scrollRuntimeOperationFacts({ scroll: declared('scroll', scrollUnavailable) }),
      // `back`/`home`/`orientation` ride the same reachable interactor; `tvRemote` always throws
      // unsupported in this interactor regardless of reachability (no capability declares it).
      ...backRuntimeOperationFacts({ back: declared('back', backUnavailable) }),
      ...homeRuntimeOperationFacts({ home: declared('home', homeUnavailable) }),
      ...orientationRuntimeOperationFacts({
        orientation: declared('orientation', orientationUnavailable),
      }),
      ...tvRemoteRuntimeOperationFacts({ tvRemote: tvRemoteUnavailable }),
      ...keyboardRuntimeOperationFacts({
        status: keyboardUnavailable,
        dismiss: keyboardUnavailable,
        enter: keyboardUnavailable,
      }),
      // Clipboard rides the same reachable interactor `back`/`home` do; the declared-capability
      // gate stays inside the interactor, where it already lives.
      //
      // R55 cell delta, deliberate: the retired `supportsHostOrSimulatorSurface` closure refused
      // `clipboard` on every provider-owned physical Apple device, because it was a LOCAL-Apple
      // predicate (host helper or simulator) being applied to a device this provider drives over
      // Appium — which does expose the clipboard extension. The refusal moves to where it can be
      // true: the interactor, per session.
      ...clipboardRuntimeOperationFacts({
        read: declared('clipboard.read', clipboardUnavailable),
        write: declared('clipboard.write', clipboardUnavailable),
      }),
      ...appSwitcherRuntimeOperationFacts({
        appSwitcher: declared('appSwitcher', appSwitcherUnavailable),
      }),
      // The deep link opens through the same reachable interactor `open` every lifecycle command
      // drives on this provider.
      ...appEventRuntimeOperationFacts({
        triggerAppEvent: interactorCell(reachable, appEventUnavailable),
      }),
      ...settingsRuntimeOperationFacts({ setSetting: settingsUnavailable }),
      // R59 cell delta, deliberate: the retired `supportsAlertSurface` closure ADMITTED `alert` on
      // a provider-owned physical iOS device (it keyed on `appleOs === 'ios'` alone), and the
      // handler then drove the LOCAL XCTest runner against a device living in someone else's
      // cloud. Nothing this provider owns can serve an alert leg, so it states that up front
      // instead of admitting and failing mid-execution (ADR 0019 §2).
      ...alertRuntimeOperationFacts({
        read: alertUnavailable,
        wait: alertUnavailable,
        accept: alertUnavailable,
        dismiss: alertUnavailable,
      }),
      ...viewportRuntimeOperationFacts({ setViewport: viewportUnavailable }),
      ensureReady: available,
      bootTarget: available,
      bootTargetHeadless: headlessUnavailable,
      listApps: appsUnavailable,
      shutdownTarget: {
        available: false,
        reason: 'unsupported-provider-mode',
        hint: 'WebDriver owns the target lifecycle for provider-owned devices.',
      },
    },
  });
}

/** Two-finger synthesis is iOS-simulator only, and this provider owns no simulators. */
function webDriverMultiTouchCell(device: DeviceInfo, reachable: boolean): RuntimeOperationFact {
  if (!reachable) return gestureUnavailable;
  return device.platform === 'apple' ? physicalIosMultiTouchUnavailable : available;
}

/** The device shapes this provider can reach at all through its own WebDriver interactor. */
function webDriverInteractorDevice(device: DeviceInfo): boolean {
  return (
    device.kind === 'device' &&
    device.target === 'mobile' &&
    (device.platform === 'android' || (device.platform === 'apple' && device.appleOs === 'ios'))
  );
}

function webDriverSessionActive(
  options: Readonly<{
    ownsDevice(device: DeviceInfo): boolean;
    isSessionActive?(device: DeviceInfo): boolean;
  }>,
  device: DeviceInfo,
): boolean {
  return options.isSessionActive?.(device) ?? options.ownsDevice(device);
}

async function materializeWebDriverSource(
  host: PlatformRuntimeHost,
  device: DeviceInfo,
  input: MaterializeAppSourceInput,
  signal: AbortSignal,
): Promise<MaterializedAppSource> {
  return device.platform === 'apple'
    ? await host.appleDeployment.prepareArtifact(input, { signal })
    : await host.androidDeployment.prepareArtifact(input, { signal });
}
