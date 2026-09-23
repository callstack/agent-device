import {
  alertRecordingEffect,
  alertRefFrameEffect,
  ownerFilesEnabled,
  PRESERVE_DAEMON_TIMEOUT_POLICY,
  selectSnapshotStepUses,
  settingsRecordingEffect,
  settingsRefFrameEffect,
  type RawCommandDescriptor,
} from '../descriptor-traits.ts';
import {
  alertRuntimePlanUses,
  screenshotRuntimePlanUses,
  settingsRuntimePlanUses,
  snapshotRuntimePlanUses,
  waitSelectorCaptureRuntimePlanUses,
} from '@agent-device/contracts/platform-runtime-operations';
import { DEFAULT_TIMEOUT_POLICY } from '../timeout-policy.ts';
import { resolveWaitBudgetMs } from '../wait-positionals.ts';

/**
 * The capture family (`src/commands/capture/**`): commands whose result is a reading of the
 * current UI — the snapshot and its diff, the wait that polls it, alert and settings, screenshot.
 */
export const CAPTURE_COMMAND_DESCRIPTORS = [
  // -- snapshot (route: snapshot) --
  {
    name: 'snapshot',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/capture/snapshot.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'snapshot', refFrameEffect: 'preserve' },
    // First Apple snapshot on a device can sit behind runner startup; --timeout
    // widens the envelope, and a timeout must not tear down the daemon.
    timeoutPolicy: { ...PRESERVE_DAEMON_TIMEOUT_POLICY, budget: { source: 'flag' } },
    batchable: true,
    platformExecution: {
      kind: 'device-runtime',
      uses: snapshotRuntimePlanUses,
      selectUses: selectSnapshotStepUses,
    },
  },
  {
    name: 'diff',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/capture/diff.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'snapshot', refFrameEffect: 'preserve' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: {
      kind: 'device-runtime',
      uses: snapshotRuntimePlanUses,
      selectUses: selectSnapshotStepUses,
    },
  },
  {
    name: 'wait',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/capture/wait.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    // #1349: a wait's landmark may legitimately be absent when the step
    // starts, so identity verification runs inside its polling resolution.
    targetIdentityVerification: 'post-resolution',
    daemon: { route: 'snapshot', refFrameEffect: 'preserve' },
    // The wait budget travels as a positional, not a flag; parse it the same
    // way the daemon will so the request envelope extends past it (#1075).
    timeoutPolicy: {
      ...PRESERVE_DAEMON_TIMEOUT_POLICY,
      budget: { source: 'positional-parser', parser: resolveWaitBudgetMs },
    },
    batchable: true,
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
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/capture/alert.ts'] as const } : {}),
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
    platformExecution: { kind: 'device-runtime', uses: alertRuntimePlanUses },
  },
  {
    name: 'settings',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/capture/settings.ts'] as const } : {}),
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
    platformExecution: { kind: 'device-runtime', uses: settingsRuntimePlanUses },
  },
  {
    name: 'screenshot',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled
      ? {
          ownerFiles: [
            'src/commands/capture/screenshot.ts',
            'src/daemon/screenshot-runtime.ts',
          ] as const,
        }
      : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'generic', refFrameEffect: 'preserve' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: screenshotRuntimePlanUses },
  },
] as const satisfies readonly RawCommandDescriptor[];
