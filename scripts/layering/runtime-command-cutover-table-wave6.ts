import type { MigratedCommandCutover } from './runtime-command-cutover-model.ts';
import {
  audioProbeSessionStateOwnershipViolations,
  doctorHostDiagnosticsViolations,
  retiredDispatchProjectionProof,
} from './runtime-command-cutover-extensions.ts';

/**
 * Wave 6's rows (#1739): the seven named command units that left `platformExecution: legacy` for
 * request-bound runtimes, plus `react-native`.
 *
 * They live beside `runtime-command-cutover-table.ts` rather than inside it because that file had
 * grown past the point where one read covers it. The split is by wave, which is how the tracker
 * retires these rows: a wave's rows are deleted together once this ADR declares its commands'
 * migrations closed, and a whole-file deletion is a cleaner end than excising a run of literals
 * from the middle of a larger table.
 */
export const WAVE_6_COMMAND_CUTOVERS: readonly MigratedCommandCutover[] = [
  {
    rule: 'R55 clipboard-runtime-cutover',
    command: 'clipboard',
    subject: 'device clipboard',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // The dispatch-table arm and its `core/dispatch.ts` handler. The daemon route function was
      // renamed to `handleSessionClipboardCommand` when it moved out of the over-budget
      // `handlers/session.ts`, so this name is now genuinely absent from production rather than
      // shadowed by a surviving namesake.
      routeNames: ['handleClipboardCommand'],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains a legacy clipboard support or hint closure',
    },
    runtimeTypeNames: ['ClipboardRuntimeOperations'],
    operations: { names: ['readClipboard', 'writeClipboard'] },
    singularExecution: {
      // `clipboard` is action-selected (R35's lesson): the session route resolves exactly one of
      // the two operations per request, binds once, and never both together.
      routes: ['resolveBoundClipboardRuntime'],
      operations: ['readClipboard', 'writeClipboard'],
      operationOwners: {
        readClipboard: ['executeClipboardRead'],
        writeClipboard: ['executeClipboardWrite'],
      },
    },
    extensions: [retiredDispatchProjectionProof('clipboard')],
  },
  {
    rule: 'R56 app-switcher-runtime-cutover',
    command: 'app-switcher',
    subject: 'app switcher reveal',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // The dispatch-table arm; `app-switcher` had no dedicated named handler function to retire
      // (its legacy body lived inline in the `DISPATCH_HANDLERS` literal). It also leaves the
      // HarmonyOS overlay that granted it a capability bucket the descriptor never listed.
      staticCommandSets: ['HARMONYOS_SUPPORTED_COMMANDS'],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains a legacy app-switcher support or hint closure',
    },
    runtimeTypeNames: ['AppSwitcherRuntimeOperations'],
    operations: { names: ['appSwitcher'] },
    singularExecution: {
      routes: ['dispatchGenericCommand'],
      operations: ['appSwitcher'],
      operationOwners: { appSwitcher: ['executeAppSwitcher'] },
    },
    extensions: [retiredDispatchProjectionProof('app-switcher')],
  },
  {
    rule: 'R57 trigger-app-event-runtime-cutover',
    command: 'trigger-app-event',
    subject: 'app-event delivery',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // The dispatch-table arm and its `core/dispatch.ts` handler, plus the session route's
      // last capability-gate-then-`dispatchCommand` thunk: with `trigger-app-event` bound, every
      // leaf on that route supplies a bind-and-execute thunk instead. The daemon route function
      // is `handleAppEventCommand` now, so the retired name is genuinely absent rather than
      // shadowed by a surviving namesake.
      routeNames: ['handleTriggerAppEventCommand', 'legacySessionDispatchExecute'],
    },
    runtimeTypeNames: ['AppEventRuntimeOperations'],
    operations: { names: ['triggerAppEvent'] },
    singularExecution: {
      routes: ['resolveBoundAppEventRuntime'],
      operations: ['triggerAppEvent'],
      operationOwners: { triggerAppEvent: ['executeAppEvent'] },
    },
    extensions: [retiredDispatchProjectionProof('trigger-app-event')],
  },
  {
    rule: 'R58 settings-runtime-cutover',
    command: 'settings',
    subject: 'device settings mutation',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // `settings` was the last `DISPATCH_HANDLERS` arm, so this row retires the legacy command
      // dispatcher whole — its table, its three entry points, its name enumerator, and the
      // request-router fallback that reached for it when no runtime route claimed a command.
      // Every one of these names is now absent from production rather than shadowed.
      routeNames: [
        'dispatchCommand',
        'dispatchWithInteractor',
        'dispatchKnownCommand',
        'DISPATCH_HANDLERS',
        'listRegisteredDispatchCommandNames',
        'executeGenericPlatformCommand',
      ],
      // Settings also leaves the HarmonyOS overlay that granted it a bucket membership the
      // descriptor never listed; the set still exists for `perf` and must no longer name it.
      staticCommandSets: ['HARMONYOS_SUPPORTED_COMMANDS'],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains a legacy settings support or hint closure',
    },
    runtimeTypeNames: ['SettingsRuntimeOperations'],
    operations: { names: ['setSetting'] },
    singularExecution: {
      routes: ['handleSettingsCommand'],
      operations: ['setSetting'],
      operationOwners: { setSetting: ['executeSetSetting'] },
    },
    extensions: [retiredDispatchProjectionProof('settings')],
  },
  {
    rule: 'R59 alert-runtime-cutover',
    command: 'alert',
    subject: 'native alert handling',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // `alert` never had a dispatch-table arm: its daemon route called the Apple runner, the
      // macOS helper and the Android alert module directly, and owned their poll and retry
      // windows itself. Those four names are what R59 retires, and with the Apple closure gone
      // the per-AppleOS capability table lost its last reader and went too.
      routeNames: [
        'handleNativeAlertCommand',
        'waitForNativeAlert',
        'handleNativeAlertAction',
        'supportsAlertSurface',
      ],
      modulePaths: ['src/platforms/apple/capabilities.ts'],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts'],
      message: 'Apple plugin retains a legacy alert support or hint closure',
    },
    runtimeTypeNames: ['AlertRuntimeOperations'],
    operations: { names: ['readAlert', 'awaitAlert', 'acceptAlert', 'dismissAlert'] },
    singularExecution: {
      // Action-selected (R35's lesson): the snapshot route resolves exactly one of the four legs
      // per request, binds once, and never two together.
      routes: ['resolveBoundAlertRuntime'],
      operations: ['readAlert', 'awaitAlert', 'acceptAlert', 'dismissAlert'],
      operationOwners: {
        readAlert: ['executeReadAlert'],
        awaitAlert: ['executeAwaitAlert'],
        acceptAlert: ['executeAcceptAlert'],
        dismissAlert: ['executeDismissAlert'],
      },
    },
    extensions: [retiredDispatchProjectionProof('alert')],
  },
  {
    rule: 'R61 react-native-runtime-cutover',
    command: 'react-native',
    subject: 'React Native overlay dismissal',
    tier: 'request-scoped',
    execution: 'device-runtime',
    legacyRetirement: {
      // The command's device work moved onto a bound `tapPoint` with R48; what R61 retires is the
      // capability gate that still stood in front of it (proved by this table's own admission
      // check) and the resolve-then-execute shape that gate implied. The dismissal function was
      // renamed to `executeReactNativeOverlayDismiss` to record that: it no longer resolves
      // anything, so the old name is genuinely absent rather than shadowed by a namesake.
      routeNames: ['dismissReactNativeOverlayTarget'],
    },
    runtimeTypeNames: ['BoundTouchRuntime'],
    operations: { names: ['tapPoint'] },
    singularExecution: {
      // Admission happens once, before the observing capture; the dismissal reuses that binding
      // rather than admitting a second time after the overlay is known.
      routes: ['executeReactNativeOverlayDismiss'],
      operations: ['tapPoint'],
      operationOwners: { tapPoint: ['createTapTouchExecutor'] },
    },
    extensions: [retiredDispatchProjectionProof('react-native')],
  },
  {
    rule: 'R60 audio-runtime-cutover',
    command: 'audio',
    subject: 'audio probe',
    tier: 'durable-resource',
    execution: 'device-runtime',
    legacyRetirement: {
      // The hand-rolled probe lifecycle (raw child + status polling on SessionState), the
      // dynamic host-backend resolver, and the `WEB_QUERY_COMMANDS` capability graft that gave
      // web its bucket outside the descriptor.
      modulePaths: [
        'src/daemon/audio-probe.ts',
        'src/platforms/audio-probe-backend.ts',
        'src/platforms/apple/os/macos/audio-probe.ts',
      ],
      importPatterns: [
        /(?:^|\/)daemon\/audio-probe(?:\.[cm]?[jt]s)?$/,
        /(?:^|\/)platforms\/audio-probe-backend(?:\.[cm]?[jt]s)?$/,
        /(?:^|\/)macos\/audio-probe(?:\.[cm]?[jt]s)?$/,
      ],
      routeNames: [
        'runHostSystemAudioProbeCommand',
        'stopSessionAudioProbe',
        'resolveHostAudioProbeBackend',
        'HostAudioProbeBackend',
        'macOsScreenCaptureKitAudioProbeBackend',
        'WEB_QUERY_COMMANDS',
        'addWebCommandCapabilities',
      ],
    },
    admissionMember: {
      forms: ['computed-property'],
      files: ['src/platforms/apple/plugin.ts', 'src/core/interactors/register-builtins.ts'],
      message: 'A plugin retains a legacy audio support or hint closure',
    },
    runtimeTypeNames: ['AudioProbeRuntimeOperations', 'AudioProbeLiveHandle'],
    operations: {
      names: ['audioProbeStart', 'audioProbeReattach', 'audioProbeCleanup', 'audioProbeQuery'],
    },
    singularExecution: {
      // Action-selected (R35's lesson): facts pick the capture or query path, the plan picks the
      // use, and the handler binds exactly once; status/stop operate the adopted live handle.
      routes: ['handleAudioCommand'],
      operations: ['audioProbeStart', 'audioProbeReattach', 'audioProbeCleanup', 'audioProbeQuery'],
      operationOwners: {
        audioProbeStart: ['startAudioProbe'],
        audioProbeQuery: ['handleAudioCommandUnsafe'],
        audioProbeReattach: ['createAudioProbeRecoveryControl'],
        audioProbeCleanup: ['createAudioProbeRecoveryControl'],
      },
    },
    lifecycleProof: audioProbeSessionStateOwnershipViolations,
  },
  {
    rule: 'R62 doctor-host-cutover',
    command: 'doctor',
    subject: 'host diagnostics',
    tier: 'request-scoped',
    execution: 'host',
    legacyRetirement: {
      // The three daemon modules that owned platform probe bodies (and their platform imports),
      // plus the retired append helpers. The probes moved to their owning families behind the
      // neutral host-diagnostics surface; the daemon keeps only orchestration.
      modulePaths: [
        'src/daemon/handlers/session-doctor-toolchain.ts',
        'src/daemon/handlers/session-doctor-android.ts',
        'src/daemon/handlers/session-doctor-web.ts',
      ],
      importPatterns: [
        /(?:^|\/)handlers\/session-doctor-toolchain(?:\.[cm]?[jt]s)?$/,
        /(?:^|\/)handlers\/session-doctor-android(?:\.[cm]?[jt]s)?$/,
        /(?:^|\/)handlers\/session-doctor-web(?:\.[cm]?[jt]s)?$/,
      ],
      routeNames: [
        'appendToolchainChecks',
        'appendAndroidChecks',
        'appendWebBrowserLifecycleCheck',
        'appendIosRunnerWarmupCheck',
      ],
    },
    singularExecution: { gatewayProof: doctorHostDiagnosticsViolations },
  },
];
