import { resolveWaitBudgetMs } from '../wait-positionals.ts';
import {
  alertRefFrameEffect,
  alertRecordingEffect,
  settingsRecordingEffect,
  settingsRefFrameEffect,
  NO_PLATFORM_EXECUTION,
} from '../descriptor-request-policy.ts';
import {
  DEFAULT_TIMEOUT_POLICY,
  FOLD_TIMEOUT_POLICY,
  INSTALL_SOURCE_REQUEST_TIMEOUT_MS,
} from '../timeout-policy.ts';
import {
  FILL_INTERACTION_RESPONSE_DATA_TRANSFORM,
  GENERIC_MUTATING_COMMAND_TRAITS,
  TARGETED_TOUCH_INTERACTION_TRAITS,
  TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM,
  isRecordingStartRequest,
  ownerFilesEnabled,
  postActionObservation,
  type RawCommandDescriptor,
} from '../descriptor-traits.ts';
import {
  PRESERVE_DAEMON_TIMEOUT_POLICY,
  SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY,
  postActionObservationTimeoutPolicy,
} from '../descriptor-timeout-policies.ts';
import { readyMaterializeAndDeployAppUse } from '@agent-device/contracts/app-deployment-runtime-plan';
import {
  alertRuntimePlanUses,
  actionButtonRuntimeUse,
  foldRuntimeUse,
  telephonyRuntimeUse,
  appSwitcherRuntimeUse,
  backRuntimeUse,
  clickRuntimeUses,
  fillRuntimeUses,
  focusRuntimeUse,
  gestureRuntimePlanUses,
  hardwareButtonRuntimePlanUses,
  homeRuntimeUse,
  hoverRuntimeUses,
  longPressRuntimeUses,
  orientationRuntimePlanUses,
  pressRuntimeUses,
  screenshotRuntimePlanUses,
  scrollRuntimePlanUses,
  selectorCaptureRuntimePlanUses,
  selectorTextCaptureRuntimePlanUses,
  settingsRuntimePlanUses,
  swipeRuntimePlanUses,
  tapPointUse,
  tvRemoteRuntimeUse,
  typeTextRuntimeUse,
  viewportRuntimeUse,
  waitSelectorCaptureRuntimePlanUses,
} from '@agent-device/contracts/platform-runtime-operations';
import { screenRecordingRuntimePlanUses } from '@agent-device/contracts/screen-recording-runtime-plan';

export const DEVICE_OPERATION_COMMAND_DESCRIPTORS = {
  captureAndSystem: [
    {
      name: 'wait',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/capture/wait.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'core',
      recordsSessionAction: true,
      recordingEffect: 'observes-app',
      // #1349: a wait's landmark may legitimately be absent when the step
      // starts, so identity verification runs inside its polling resolution.
      targetIdentityVerification: 'post-resolution',
      daemon: { route: 'snapshot', refFrameEffect: 'preserve', appLease: 'allowed' },
      // The wait budget travels as a positional, not a flag; parse it the same
      // way the daemon will so the request envelope extends past it (#1075).
      timeoutPolicy: {
        ...PRESERVE_DAEMON_TIMEOUT_POLICY,
        budget: { source: 'positional-parser', parser: resolveWaitBudgetMs },
      },
      batchable: true,
      compositeResource: 'none',
      // A duration wait declares no operation and never binds (`waitObservesDevice`); every
      // observing shape uses the wait-specific capture plan so its conditional native observations
      // cannot affect capture-only or element-text selector commands.
      //
      // ACCEPTED BEHAVIOUR CHANGE (#1875, ruled rather than assumed): binding the family plan means
      // wait asks the owner whether it can observe a device with no app attached, and the families
      // answer differently. On iOS `appBundleId` is the XCUITest attach target, so with none set
      // local Apple refuses `captureSnapshotWithoutActiveApp` and wait now fails immediately naming
      // `open`, where it used to poll to its deadline. It could never have succeeded: the runner's
      // own process foregrounds and displaces the app under test, then answers about its own blank
      // screen — so `wait stable` and `wait @ref` stopped returning a success that was describing
      // the runner, not the app. Android captures the real launcher in that state, its facts say
      // so, and wait proceeds unchanged. Same plan, opposite outcomes, chosen by the owner.
      platformExecution: { kind: 'device-runtime', uses: waitSelectorCaptureRuntimePlanUses },
    },
    {
      name: 'alert',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/capture/alert.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'core',
      // R59 retires this command's capability bucket and its Apple `supportsAlertSurface` closure
      // together: admission is the owner's own alert facts, and the only execution is the one bound
      // leg the parsed subcommand names. The poll and retry windows moved to the owners with it —
      // how long a transient sheet takes to appear is family mechanics, not request policy.
      recordsSessionAction: true,
      recordingEffect: alertRecordingEffect,
      daemon: {
        route: 'snapshot',
        refFrameEffect: alertRefFrameEffect,
      },
      timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: alertRuntimePlanUses },
    },
    {
      name: 'settings',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/capture/settings.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      // R58 retires this command's capability bucket, its `dispatch` leaf, and its HarmonyOS
      // overlay membership together: a request admits one of the owner's two settings facts —
      // `readSetting` for a bare readable setting, `setSetting` for everything else — and executes
      // exactly that one bound operation, which is why the two effects above classify per request.
      // The macOS setting-name gate stays daemon-side — it keys on the requested setting, which is
      // not a device fact.
      recordsSessionAction: true,
      recordingEffect: settingsRecordingEffect,
      daemon: { route: 'snapshot', refFrameEffect: settingsRefFrameEffect },
      timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: settingsRuntimePlanUses },
    },

    // -- specialized routes --
    {
      name: 'react-native',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/react-native/index.ts'] as const }
        : {}),
      catalog: { group: 'public', key: 'reactNative' },
      frameworkTier: 'extended',
      // R61 retires this command's capability bucket: admission is the owner's own `tapPoint` fact,
      // which is the one device operation the command executes. The overlay analysis and its
      // verification capture are daemon policy over an already-migrated snapshot route.
      recordsSessionAction: true,
      recordingEffect: 'mutates-app',
      daemon: { route: 'reactNative', refFrameEffect: 'may-invalidate' },
      timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: [tapPointUse] },
    },
    {
      name: 'record',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? {
            ownerFiles: [
              'packages/command-surface/src/recording/index.ts',
              'packages/command-surface/src/recording/output-schemas.ts',
            ] as const,
          }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      recordsSessionAction: true,
      recordingEffect: 'observes-app',
      daemon: {
        route: 'recordTrace',
        refFrameEffect: 'preserve',
        allowInvalidRecording: true,
        allowSessionlessDefaultDevice: isRecordingStartRequest,
      },
      platformExecution: { kind: 'device-runtime', uses: screenRecordingRuntimePlanUses },
      // A `record stop` export can outlast the request envelope. Resetting the daemon mid-export
      // left its recording manifest open with no owner, and every later `record start` on the
      // device refused until that exact session ran `record stop`.
      timeoutPolicy: PRESERVE_DAEMON_TIMEOUT_POLICY,
      batchable: true,
      compositeResource: 'operation',
    },
    {
      name: 'trace',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? {
            ownerFiles: [
              'packages/command-surface/src/recording/index.ts',
              'packages/command-surface/src/recording/output-schemas.ts',
            ] as const,
          }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      recordsSessionAction: true,
      recordingEffect: 'observes-app',
      daemon: { route: 'recordTrace', refFrameEffect: 'preserve' },
      timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
      batchable: true,
      compositeResource: 'operation',
      platformExecution: NO_PLATFORM_EXECUTION,
    },
  ],
  interactionAndHardware: [
    // -- interaction (route: interaction) --
    // Interaction commands resolve their target through the same platform accessibility
    // capture as snapshot, so a hung capture is their dominant timeout mode. Resetting the
    // daemon here destroyed every app session the daemon owned while the app itself was
    // still healthy (#1105): keep the daemon (and sessions) alive like snapshot/wait/find,
    // and rely on request cancellation + the per-request runner recycle budget to abort the
    // stuck Apple runner work.
    {
      name: 'click',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      targetIdentityVerification: 'pre-dispatch',
      catalog: { group: 'public' },
      frameworkTier: 'core',
      recordsSessionAction: true,
      recordingEffect: 'mutates-app',
      daemon: {
        route: 'interaction',
        refFrameEffect: 'may-invalidate',
        androidBlockingDialogGuard: true,
        appLease: 'allowed',
      },
      timeoutPolicy: postActionObservationTimeoutPolicy('click', PRESERVE_DAEMON_TIMEOUT_POLICY),
      postActionObservation: postActionObservation('click'),
      responseDataTransform: TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM,
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: clickRuntimeUses },
    },
    {
      name: 'fill',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      ...TARGETED_TOUCH_INTERACTION_TRAITS,
      daemon: { ...TARGETED_TOUCH_INTERACTION_TRAITS.daemon, appLease: 'allowed' },
      frameworkTier: 'core',
      timeoutPolicy: postActionObservationTimeoutPolicy('fill', PRESERVE_DAEMON_TIMEOUT_POLICY),
      postActionObservation: postActionObservation('fill'),
      responseDataTransform: FILL_INTERACTION_RESPONSE_DATA_TRANSFORM,
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: fillRuntimeUses },
    },
    {
      name: 'longpress',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      ...TARGETED_TOUCH_INTERACTION_TRAITS,
      catalog: { group: 'public', key: 'longPress' },
      frameworkTier: 'extended',
      timeoutPolicy: {
        ...SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY,
        // Android cold-helper worst case at the maximum hold plus the daemon-result margin, applied
        // to every platform. Proven by the ledger test:
        // test/integration/provider-scenarios/android-longpress-ledger.test.ts.
        envelopeMs: 320_000,
      },
      postActionObservation: postActionObservation('longpress'),
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: longPressRuntimeUses },
    },
    {
      name: 'hover',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      targetIdentityVerification: 'pre-dispatch',
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      recordsSessionAction: true,
      recordingEffect: 'mutates-app',
      daemon: {
        route: 'interaction',
        refFrameEffect: 'may-invalidate',
      },
      timeoutPolicy: postActionObservationTimeoutPolicy('hover', PRESERVE_DAEMON_TIMEOUT_POLICY),
      postActionObservation: postActionObservation('hover'),
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: hoverRuntimeUses },
    },
    {
      name: 'press',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      ...TARGETED_TOUCH_INTERACTION_TRAITS,
      daemon: { ...TARGETED_TOUCH_INTERACTION_TRAITS.daemon, appLease: 'allowed' },
      frameworkTier: 'core',
      timeoutPolicy: postActionObservationTimeoutPolicy('press', PRESERVE_DAEMON_TIMEOUT_POLICY),
      postActionObservation: postActionObservation('press'),
      responseDataTransform: TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM,
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: pressRuntimeUses },
    },
    {
      name: 'type',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'core',
      recordsSessionAction: true,
      recordingEffect: 'mutates-app',
      daemon: {
        route: 'interaction',
        refFrameEffect: 'may-invalidate',
        androidBlockingDialogGuard: true,
        appLease: 'allowed',
      },
      timeoutPolicy: postActionObservationTimeoutPolicy('type', PRESERVE_DAEMON_TIMEOUT_POLICY),
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: [typeTextRuntimeUse] },
    },
    {
      name: 'get',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      targetIdentityVerification: 'pre-dispatch',
      catalog: { group: 'public' },
      frameworkTier: 'core',
      recordsSessionAction: true,
      recordingEffect: 'observes-app',
      daemon: { route: 'interaction', refFrameEffect: 'preserve', appLease: 'allowed' },
      timeoutPolicy: postActionObservationTimeoutPolicy('get', PRESERVE_DAEMON_TIMEOUT_POLICY),
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: selectorTextCaptureRuntimePlanUses },
    },
    {
      name: 'is',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      targetIdentityVerification: 'pre-dispatch',
      catalog: { group: 'public' },
      frameworkTier: 'core',
      recordsSessionAction: true,
      recordingEffect: 'observes-app',
      daemon: { route: 'interaction', refFrameEffect: 'preserve', appLease: 'allowed' },
      timeoutPolicy: postActionObservationTimeoutPolicy('is', PRESERVE_DAEMON_TIMEOUT_POLICY),
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: selectorCaptureRuntimePlanUses },
    },

    // -- generic (route: generic) --
    {
      name: 'back',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/system/index.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'core',
      // R42 retires this command's capability bucket and its `dispatch` leaf together: admission is
      // the owner's `back` fact, and the only execution is the bound operation — the postActionObservation
      // timeout trait it kept is admission-independent, like `type` kept its dialog guard.
      ...GENERIC_MUTATING_COMMAND_TRAITS,
      timeoutPolicy: postActionObservationTimeoutPolicy('back', DEFAULT_TIMEOUT_POLICY),
      postActionObservation: postActionObservation('back'),
      platformExecution: { kind: 'device-runtime', uses: [backRuntimeUse] },
    },
    {
      name: 'gesture',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      recordsSessionAction: true,
      recordingEffect: 'mutates-app',
      targetIdentityVerification: 'pre-dispatch',
      daemon: {
        route: 'interaction',
        refFrameEffect: 'may-invalidate',
        androidBlockingDialogGuard: true,
      },
      // R52 retires this command's capability bucket: admission is the owner's gesture-tier facts,
      // which the retired `requireGestureSupported` used to decide inside the daemon. The declared
      // uses are the four tiers one gesture input can select between (ADR 0019 §9).
      timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: gestureRuntimePlanUses },
    },
    {
      name: 'home',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/system/index.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      // R43 retires this command's capability bucket and its `dispatch` leaf together: admission is
      // the owner's `home` fact, and the only execution is the bound operation.
      ...GENERIC_MUTATING_COMMAND_TRAITS,
      platformExecution: { kind: 'device-runtime', uses: [homeRuntimeUse] },
    },
    {
      name: 'tv-remote',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/system/index.ts'] as const }
        : {}),
      catalog: { group: 'public', key: 'tvRemote' },
      frameworkTier: 'extended',
      // R45 retires this command's capability bucket and its `dispatch` leaf together: admission is
      // the owner's `tvRemote` fact, and the only execution is the bound operation.
      ...GENERIC_MUTATING_COMMAND_TRAITS,
      platformExecution: { kind: 'device-runtime', uses: [tvRemoteRuntimeUse] },
    },
    {
      name: 'orientation',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/system/index.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      // R44 retires this command's capability bucket and its `dispatch` leaf together: admission is
      // the owner's `setOrientation` fact (`unlockOrientation` for `auto`); only that operation runs.
      ...GENERIC_MUTATING_COMMAND_TRAITS,
      platformExecution: { kind: 'device-runtime', uses: orientationRuntimePlanUses },
    },
    {
      name: 'fold',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/system/index.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      // Admission is the owner's `setFoldPose` fact, the same ADR 0019 §9 shape as `orientation`.
      // A pose change moves the app to a different panel with a different point size, so the
      // generic mutating traits' ref-frame invalidation is load-bearing here (ADR 0025).
      ...GENERIC_MUTATING_COMMAND_TRAITS,
      timeoutPolicy: FOLD_TIMEOUT_POLICY,
      platformExecution: { kind: 'device-runtime', uses: [foldRuntimeUse] },
    },
    {
      name: 'telephony',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/system/index.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      // Admission is the owner's `sendTelephonyEvent` fact. The event goes to the emulator console
      // rather than the screen, so no blocking-dialog guard applies; the call screen or message
      // notification it raises can still cover the app, so refs may be invalidated.
      ...GENERIC_MUTATING_COMMAND_TRAITS,
      daemon: { ...GENERIC_MUTATING_COMMAND_TRAITS.daemon, androidBlockingDialogGuard: false },
      platformExecution: { kind: 'device-runtime', uses: [telephonyRuntimeUse] },
    },
    {
      name: 'scroll',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/daemon/src/execution/scroll-runtime.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'core',
      // R53 retires this command's capability bucket and its `dispatch` leaf together: admission is
      // the owner's `scrollDirection` fact, and the only execution is the bound operation. `scroll`
      // was the last holder of the legacy `dispatch`/`capability` pair, which retires with it.
      ...GENERIC_MUTATING_COMMAND_TRAITS,
      daemon: { ...GENERIC_MUTATING_COMMAND_TRAITS.daemon, appLease: 'allowed' },
      timeoutPolicy: postActionObservationTimeoutPolicy('scroll', DEFAULT_TIMEOUT_POLICY),
      postActionObservation: postActionObservation('scroll'),
      platformExecution: { kind: 'device-runtime', uses: scrollRuntimePlanUses },
    },
    {
      name: 'swipe',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'core',
      recordsSessionAction: true,
      recordingEffect: 'mutates-app',
      daemon: {
        route: 'interaction',
        refFrameEffect: 'may-invalidate',
        androidBlockingDialogGuard: true,
      },
      // R54 retires this command's capability bucket. A swipe always normalizes to a coordinate
      // fling, so it declares only the one-contact plan it can select.
      timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: swipeRuntimePlanUses },
    },
    {
      name: 'focus',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/interaction/index.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      // R40 retires this command's capability bucket and its `dispatch` leaf together: admission is
      // the owner's `focusPoint` fact, and the only execution is the bound operation.
      ...GENERIC_MUTATING_COMMAND_TRAITS,
      daemon: { ...GENERIC_MUTATING_COMMAND_TRAITS.daemon, appLease: 'allowed' },
      platformExecution: { kind: 'device-runtime', uses: [focusRuntimeUse] },
    },
    {
      name: 'screenshot',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? {
            ownerFiles: [
              'packages/command-surface/src/capture/screenshot.ts',
              'packages/daemon/src/execution/screenshot-runtime.ts',
            ] as const,
          }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'core',
      recordsSessionAction: true,
      recordingEffect: 'observes-app',
      daemon: { route: 'generic', refFrameEffect: 'preserve', appLease: 'allowed' },
      timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: screenshotRuntimePlanUses },
    },
    {
      name: 'viewport',
      compositeResource: 'none',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/management/viewport.ts'] as const }
        : {}),
      catalog: { group: 'public' },
      frameworkTier: 'extended',
      recordsSessionAction: true,
      recordingEffect: 'mutates-app',
      daemon: { route: 'generic', refFrameEffect: 'may-invalidate' },
      timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
      batchable: false,
      platformExecution: { kind: 'device-runtime', uses: [viewportRuntimeUse] },
    },
    // -- public extended-tier commands: the generic route, or no daemon facet declared --
    {
      name: 'app-switcher',
      deviceClaimPolicy: 'require-owner',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/system/index.ts'] as const }
        : {}),
      catalog: { group: 'public', key: 'appSwitcher' },
      frameworkTier: 'extended',
      // R56 removed the legacy `dispatch` leaf, capability bucket, and HarmonyOS overlay membership.
      // The daemon route remains `generic`; admission checks the owner's `appSwitcher` fact,
      // and execution uses that one bound operation (ADR 0019 §9).
      recordsSessionAction: true,
      recordingEffect: 'mutates-app',
      // ADR 0014, "Command effects are daemon-owned and completely classified":
      // The `daemon` facet classifies this command's device mutation for the completeness gate.
      // The route remains `generic`.
      daemon: { route: 'generic', refFrameEffect: 'may-invalidate' },
      timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
      batchable: true,
      compositeResource: 'none',
      platformExecution: { kind: 'device-runtime', uses: [appSwitcherRuntimeUse] },
    },
    {
      name: 'action-button',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/system/index.ts'] as const }
        : {}),
      catalog: { group: 'public', key: 'actionButton' },
      frameworkTier: 'extended',
      // Admission is the owner's `actionButton` fact, the same ADR 0019 §9 shape as `home`. The
      // generic mutating traits are load-bearing beyond their shared shape: no post-action
      // observation is declared, because the press is delivered to the system rather than to the
      // session app, and settling would re-capture (and so foreground) the app the press is supposed
      // to leave alone (#2699).
      ...GENERIC_MUTATING_COMMAND_TRAITS,
      platformExecution: { kind: 'device-runtime', uses: [actionButtonRuntimeUse] },
    },
    {
      name: 'hardware-button',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/system/index.ts'] as const }
        : {}),
      catalog: { group: 'public', key: 'hardwareButton' },
      frameworkTier: 'extended',
      // The first positional selects one of the eleven named keys, the way `orientation` selects
      // between setOrientation and unlockOrientation; admission binds exactly that one fact. Like
      // action-button, no post-action observation is declared: the press goes to the system, not
      // the session app, and settling would re-capture the app the press leaves alone (#3848).
      ...GENERIC_MUTATING_COMMAND_TRAITS,
      platformExecution: { kind: 'device-runtime', uses: hardwareButtonRuntimePlanUses },
    },
    {
      name: 'install-from-source',
      deviceClaimPolicy: 'none',
      ...(ownerFilesEnabled
        ? { ownerFiles: ['packages/command-surface/src/management/install.ts'] as const }
        : {}),
      catalog: { group: 'public', key: 'installFromSource' },
      frameworkTier: 'extended',
      recordsSessionAction: true,
      recordingEffect: 'mutates-app',
      platformExecution: { kind: 'device-runtime', use: readyMaterializeAndDeployAppUse },
      timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY, envelopeMs: INSTALL_SOURCE_REQUEST_TIMEOUT_MS },
      batchable: true,
      compositeResource: 'none',
    },
  ],
} as const satisfies Record<string, readonly RawCommandDescriptor[]>;
