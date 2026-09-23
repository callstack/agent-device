import {
  clipboardRecordingEffect,
  GENERIC_MUTATING_COMMAND_TRAITS,
  keyboardRecordingEffect,
  keyboardRefFrameEffect,
  ownerFilesEnabled,
  postActionObservation,
  postActionObservationTimeoutPolicy,
  type RawCommandDescriptor,
} from '../descriptor-traits.ts';
import {
  actionButtonRuntimeUse,
  appStateRuntimeUses,
  appSwitcherRuntimeUse,
  backRuntimeUse,
  clipboardRuntimePlanUses,
  foldRuntimeUse,
  homeRuntimeUse,
  keyboardRuntimePlanUses,
  orientationRuntimeUse,
  tvRemoteRuntimeUse,
} from '@agent-device/contracts/platform-runtime-operations';
import { DEFAULT_TIMEOUT_POLICY, FOLD_TIMEOUT_POLICY } from '../timeout-policy.ts';

/**
 * The system family (`src/commands/system/**`): inputs delivered to the platform rather than to
 * an element in the app's UI tree — system buttons, home/back, keyboard, clipboard, orientation.
 */
export const SYSTEM_COMMAND_DESCRIPTORS = [
  {
    name: 'appstate',
    deviceClaimPolicy: 'observe',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public', key: 'appState' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'state',
    },
    platformExecution: { kind: 'device-runtime', uses: appStateRuntimeUses },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
  },
  {
    name: 'clipboard',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R55 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // whichever action-selected fact (`readClipboard`/`writeClipboard`) the parsed subcommand
    // names, and the only execution is that one bound operation (ADR 0019 §9).
    recordsSessionAction: true,
    recordingEffect: clipboardRecordingEffect,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: clipboardRuntimePlanUses },
  },
  {
    name: 'keyboard',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R46 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // whichever action-selected fact (`keyboardStatus`/`keyboardDismiss`/`keyboardEnter`) the
    // parsed action names, and the only execution is that one bound operation (ADR 0019 §9).
    recordsSessionAction: true,
    recordingEffect: keyboardRecordingEffect,
    daemon: {
      route: 'session',
      refFrameEffect: keyboardRefFrameEffect,
      androidBlockingDialogGuard: true,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: keyboardRuntimePlanUses },
  },
  // -- generic (route: generic) --
  {
    name: 'back',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
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
    name: 'home',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R43 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `home` fact, and the only execution is the bound operation.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    platformExecution: { kind: 'device-runtime', uses: [homeRuntimeUse] },
  },
  {
    name: 'tv-remote',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public', key: 'tvRemote' },
    frameworkTier: 'extended',
    // R45 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `tvRemote` fact, and the only execution is the bound operation.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    platformExecution: { kind: 'device-runtime', uses: [tvRemoteRuntimeUse] },
  },
  {
    name: 'orientation',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R44 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `setOrientation` fact, and the only execution is the bound operation.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    platformExecution: { kind: 'device-runtime', uses: [orientationRuntimeUse] },
  },
  {
    name: 'fold',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
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
    name: 'app-switcher',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
    catalog: { group: 'public', key: 'appSwitcher' },
    frameworkTier: 'extended',
    // R56 retires this command's capability bucket, its `dispatch` leaf, and its HarmonyOS
    // overlay membership together: admission is the owner's `appSwitcher` fact, and the only
    // execution is that one bound operation (ADR 0019 §9).
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    // ADR 0014: app-switcher previously reached the generic daemon leaf via the
    // registry's generic fallback with no daemon facet, so it could not be
    // classified. Add the facet (route unchanged) so its device mutation is
    // covered by the completeness gate; this is the escape hatch the ADR calls
    // out, not a new specialized route.
    daemon: { route: 'generic', refFrameEffect: 'may-invalidate' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: [appSwitcherRuntimeUse] },
  },
  {
    name: 'action-button',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/system/index.ts'] as const } : {}),
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
] as const satisfies readonly RawCommandDescriptor[];
