import {
  FILL_INTERACTION_RESPONSE_DATA_TRANSFORM,
  findRecordingEffect,
  GENERIC_MUTATING_COMMAND_TRAITS,
  ownerFilesEnabled,
  postActionObservation,
  postActionObservationTimeoutPolicy,
  PRESERVE_DAEMON_TIMEOUT_POLICY,
  selectFindStepUses,
  SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY,
  TARGETED_TOUCH_INTERACTION_TRAITS,
  TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM,
  type RawCommandDescriptor,
} from '../descriptor-traits.ts';
import {
  clickRuntimeUses,
  fillRuntimeUses,
  findRuntimePlanUses,
  focusRuntimeUse,
  gestureRuntimePlanUses,
  hoverRuntimeUses,
  longPressRuntimeUses,
  pressRuntimeUses,
  scrollRuntimePlanUses,
  selectorCaptureRuntimePlanUses,
  selectorTextCaptureRuntimePlanUses,
  swipeRuntimePlanUses,
  typeTextRuntimeUse,
} from '@agent-device/contracts/platform-runtime-operations';
import { DEFAULT_TIMEOUT_POLICY } from '../timeout-policy.ts';

/**
 * The interaction family (`src/commands/interaction/**`): commands that resolve a target or a
 * gesture and act on it, plus `find`/`get`/`is`, which resolve the same target without mutating.
 */
export const INTERACTION_COMMAND_DESCRIPTORS = [
  {
    name: 'find',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: findRecordingEffect,
    daemon: {
      route: 'find',
      refFrameEffect: 'may-invalidate',
    },
    timeoutPolicy: PRESERVE_DAEMON_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: {
      kind: 'device-runtime',
      uses: findRuntimePlanUses,
      selectUses: selectFindStepUses,
    },
  },
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
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    targetIdentityVerification: 'pre-dispatch',
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: {
      route: 'interaction',
      refFrameEffect: 'may-invalidate',
      androidBlockingDialogGuard: true,
    },
    timeoutPolicy: postActionObservationTimeoutPolicy('click', PRESERVE_DAEMON_TIMEOUT_POLICY),
    postActionObservation: postActionObservation('click'),
    responseDataTransform: TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: clickRuntimeUses },
  },
  {
    name: 'fill',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    ...TARGETED_TOUCH_INTERACTION_TRAITS,
    frameworkTier: 'core',
    timeoutPolicy: postActionObservationTimeoutPolicy('fill', PRESERVE_DAEMON_TIMEOUT_POLICY),
    postActionObservation: postActionObservation('fill'),
    responseDataTransform: FILL_INTERACTION_RESPONSE_DATA_TRANSFORM,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: fillRuntimeUses },
  },
  {
    name: 'longpress',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    ...TARGETED_TOUCH_INTERACTION_TRAITS,
    catalog: { group: 'public', key: 'longPress' },
    frameworkTier: 'extended',
    timeoutPolicy: {
      ...SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY,
      // Android's cold path may inspect/install the helper, hand off a running
      // snapshot helper, hold for 120 seconds, then use 15 seconds of helper
      // completion overhead. Keep that complete route inside the envelope.
      envelopeMs: 210_000,
    },
    postActionObservation: postActionObservation('longpress'),
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: longPressRuntimeUses },
  },
  {
    name: 'hover',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
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
    platformExecution: { kind: 'device-runtime', uses: hoverRuntimeUses },
  },
  {
    name: 'press',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    ...TARGETED_TOUCH_INTERACTION_TRAITS,
    frameworkTier: 'core',
    timeoutPolicy: postActionObservationTimeoutPolicy('press', PRESERVE_DAEMON_TIMEOUT_POLICY),
    postActionObservation: postActionObservation('press'),
    responseDataTransform: TOUCH_INTERACTION_RESPONSE_DATA_TRANSFORM,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: pressRuntimeUses },
  },
  {
    name: 'type',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: {
      route: 'interaction',
      refFrameEffect: 'may-invalidate',
      androidBlockingDialogGuard: true,
    },
    timeoutPolicy: postActionObservationTimeoutPolicy('type', PRESERVE_DAEMON_TIMEOUT_POLICY),
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: [typeTextRuntimeUse] },
  },
  {
    name: 'get',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    targetIdentityVerification: 'pre-dispatch',
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'interaction', refFrameEffect: 'preserve' },
    timeoutPolicy: postActionObservationTimeoutPolicy('get', PRESERVE_DAEMON_TIMEOUT_POLICY),
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: selectorTextCaptureRuntimePlanUses },
  },
  {
    name: 'is',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    targetIdentityVerification: 'pre-dispatch',
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: { route: 'interaction', refFrameEffect: 'preserve' },
    timeoutPolicy: postActionObservationTimeoutPolicy('is', PRESERVE_DAEMON_TIMEOUT_POLICY),
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: selectorCaptureRuntimePlanUses },
  },
  {
    name: 'gesture',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
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
    platformExecution: { kind: 'device-runtime', uses: gestureRuntimePlanUses },
  },
  {
    name: 'scroll',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/daemon/scroll-runtime.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    // R53 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `scrollDirection` fact, and the only execution is the bound operation. `scroll`
    // was the last holder of the legacy `dispatch`/`capability` pair, which retires with it.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    timeoutPolicy: postActionObservationTimeoutPolicy('scroll', DEFAULT_TIMEOUT_POLICY),
    postActionObservation: postActionObservation('scroll'),
    platformExecution: { kind: 'device-runtime', uses: scrollRuntimePlanUses },
  },
  {
    name: 'swipe',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
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
    platformExecution: { kind: 'device-runtime', uses: swipeRuntimePlanUses },
  },
  {
    name: 'focus',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/interaction/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    // R40 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `focusPoint` fact, and the only execution is the bound operation.
    ...GENERIC_MUTATING_COMMAND_TRAITS,
    platformExecution: { kind: 'device-runtime', uses: [focusRuntimeUse] },
  },
] as const satisfies readonly RawCommandDescriptor[];
