import {
  keyboardRefFrameEffect,
  keyboardRecordingEffect,
  clipboardRecordingEffect,
  NO_PLATFORM_EXECUTION,
  resolvePlainCloseLeaseAdmissionExemption,
} from '../descriptor-request-policy.ts';
import {
  COMPOSITE_TIMEOUT_POLICIES,
  DEFAULT_TIMEOUT_POLICY,
  INSTALL_SOURCE_REQUEST_TIMEOUT_MS,
  PREPARE_REQUEST_TIMEOUT_MS,
} from '../timeout-policy.ts';
import {
  REQUEST_EXECUTION_EXEMPT,
  allowAnyDeviceSessionless,
  isShardedTestRequest,
  ownerFilesEnabled,
  type RawCommandDescriptor,
} from '../descriptor-traits.ts';
import { INSTALL_TIMEOUT_POLICY } from '../descriptor-timeout-policies.ts';
import {
  deployAppUse,
  readyMaterializeAndDeployAppUse,
  readySendPushNotificationUse,
  uninstallAppUse,
} from '@agent-device/contracts/app-deployment-runtime-plan';
import {
  closeApplicationRuntimePlanUses,
  openApplicationRuntimePlanUses,
  prepareAppleRunnerRuntimeUse,
  runtimeCommandRuntimePlanUses,
} from '@agent-device/contracts/application-lifecycle-runtime-plan';
import { appLogRuntimePlanUses } from '@agent-device/contracts/logs-runtime-plan';
import { audioRuntimePlanUses } from '@agent-device/contracts/audio-runtime-plan';
import { networkDumpUse } from '@agent-device/contracts/network-runtime-plan';
import {
  appEventRuntimeUse,
  clipboardRuntimePlanUses,
  gestureViewportRuntimeUse,
  keyboardRuntimePlanUses,
  perfRuntimePlanUses,
} from '@agent-device/contracts/platform-runtime-operations';

const DEPLOY_APP_COMMAND_DESCRIPTOR = {
  deviceClaimPolicy: 'transient-exclusive',
  ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/install.ts'] as const } : {}),
  catalog: { group: 'public' },
  frameworkTier: 'extended',
  recordsSessionAction: true,
  recordingEffect: 'mutates-app',
  daemon: { route: 'session', refFrameEffect: 'may-invalidate' },
  platformExecution: { kind: 'device-runtime', use: deployAppUse },
  timeoutPolicy: INSTALL_TIMEOUT_POLICY,
  batchable: true,
  compositeResource: 'none',
} as const;

export const SESSION_OPERATION_COMMAND_DESCRIPTORS = [
  {
    name: 'perf',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/perf/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'observes-app',
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    compositeResource: 'operation',
    platformExecution: { kind: 'device-runtime', uses: perfRuntimePlanUses },
  },
  {
    name: 'logs',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
    },
    platformExecution: { kind: 'device-runtime', uses: appLogRuntimePlanUses },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    compositeResource: 'operation',
  },
  {
    name: 'events',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
      allowInvalidRecording: true,
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    // Wave 6 residue: `events` flushes and reads the session's own event log. It touches no
    // device at all, so it has no platform execution path to migrate.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'network',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
    },
    platformExecution: { kind: 'device-runtime', use: networkDumpUse },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    compositeResource: 'none',
  },
  {
    name: 'audio',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/observability/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'observability',
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    compositeResource: 'operation',
    platformExecution: { kind: 'device-runtime', uses: audioRuntimePlanUses },
  },
  {
    name: 'replay',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/replay/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'delegated',
      sessionKind: 'replay',
      skipSessionlessProviderDevice: isShardedTestRequest,
      saveScriptFlagOwner: true,
    },
    timeoutPolicy: COMPOSITE_TIMEOUT_POLICIES.replay,
    batchable: false,
    // Every native and Maestro action re-enters the daemon request pipeline under the delegated
    // command descriptor. Maestro viewport reads do the same through `runtime gesture-viewport`,
    // so replay owns orchestration but no platform execution of its own.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'test',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/replay/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'delegated',
      sessionKind: 'replay',
      skipSessionlessProviderDevice: isShardedTestRequest,
    },
    // Test runs stream per-scenario progress and are budgeted downstream; no
    // client envelope at all.
    timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY, envelopeMs: 'unbounded' },
    batchable: true,
    compositeResource: 'nested-test',
    // Test is suite orchestration over replay attempts; each attempt delegates its admitted
    // operations, including Maestro viewport acquisition, to their own descriptors.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'runtime',
    compositeResource: 'none',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled
      ? {
          ownerFiles: [
            'packages/daemon/src/sessions/handlers/session-runtime-command.ts',
            'packages/daemon/src/sessions/handlers/session-runtime-port-reverse.ts',
          ] as const,
        }
      : {}),
    catalog: { group: 'internal' },
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'preserve' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: {
      kind: 'device-runtime',
      uses: [...runtimeCommandRuntimePlanUses, gestureViewportRuntimeUse],
    },
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
    compositeResource: 'none',
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
    compositeResource: 'none',
    platformExecution: { kind: 'device-runtime', uses: keyboardRuntimePlanUses },
  },
  {
    name: 'install',
    ...DEPLOY_APP_COMMAND_DESCRIPTOR,
  },
  {
    name: 'reinstall',
    ...DEPLOY_APP_COMMAND_DESCRIPTOR,
  },
  {
    name: 'uninstall',
    ...DEPLOY_APP_COMMAND_DESCRIPTOR,
    platformExecution: { kind: 'device-runtime', use: uninstallAppUse },
  },
  {
    name: 'install_source',
    compositeResource: 'none',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled
      ? {
          ownerFiles: [
            'packages/daemon/src/sessions/handlers/session-app-source-deployment.ts',
          ] as const,
        }
      : {}),
    catalog: {
      group: 'internal',
      key: 'installSource',
      servesPublicCommand: 'install-from-source',
    },
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'session', refFrameEffect: 'may-invalidate' },
    platformExecution: { kind: 'device-runtime', use: readyMaterializeAndDeployAppUse },
    timeoutPolicy: { ...INSTALL_TIMEOUT_POLICY, envelopeMs: INSTALL_SOURCE_REQUEST_TIMEOUT_MS },
    batchable: false,
  },
  {
    name: 'release_materialized_paths',
    compositeResource: 'none',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled
      ? {
          ownerFiles: [
            'packages/daemon/src/sessions/handlers/session-app-source-deployment.ts',
          ] as const,
        }
      : {}),
    catalog: { group: 'internal', key: 'releaseMaterializedPaths' },
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'push',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/push.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'session', refFrameEffect: 'may-invalidate' },
    platformExecution: { kind: 'device-runtime', use: readySendPushNotificationUse },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    compositeResource: 'none',
  },
  {
    name: 'trigger-app-event',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/push.ts'] as const } : {}),
    catalog: { group: 'public', key: 'triggerAppEvent' },
    frameworkTier: 'extended',
    // R57 retires this command's capability bucket and its `dispatch` leaf together: admission is
    // the owner's `triggerAppEvent` fact, and the only execution is that one bound operation. The
    // event name, payload, and URL template stay daemon policy (ADR 0019 §2 — a facet input names
    // no command, request, or CLI flag), so the owner receives a URL to open.
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'session', refFrameEffect: 'may-invalidate' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    compositeResource: 'none',
    platformExecution: { kind: 'device-runtime', uses: [appEventRuntimeUse] },
  },
  {
    name: 'open',
    deviceClaimPolicy: 'acquire-session',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/app.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: {
      route: 'session',
      refFrameEffect: 'may-invalidate',
      allowSessionlessDefaultDevice: allowAnyDeviceSessionless,
      saveScriptFlagOwner: true,
      appLease: 'allowed',
    },
    // --timeout is a startup budget: it reaches the Simulator boot wait (#2324).
    timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY, budget: { source: 'flag', envelope: 'margin' } },
    batchable: true,
    compositeResource: 'session-lifecycle',
    platformExecution: { kind: 'device-runtime', uses: openApplicationRuntimePlanUses },
  },
  {
    name: 'prepare',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/prepare.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'preserve' },
    // Runner warm-up builds are the longest fixed envelope; --timeout is the
    // daemon-side boot + runner budget, so the envelope keeps a margin over it.
    timeoutPolicy: {
      budget: { source: 'flag', envelope: 'margin' },
      envelopeMs: PREPARE_REQUEST_TIMEOUT_MS,
      onTimeout: 'reset-daemon',
    },
    batchable: false,
    mcpExposed: false,
    platformExecution: { kind: 'device-runtime', use: prepareAppleRunnerRuntimeUse },
  },
  {
    name: 'batch',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/batch/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'delegated', appLease: 'allowed' },
    timeoutPolicy: COMPOSITE_TIMEOUT_POLICIES.batch,
    batchable: false,
    // Wave 6 residue: every step runs as its own daemon request under its own descriptor, which
    // is what `refFrameEffect: 'delegated'` already says. `batch` itself reaches no device.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'close',
    deviceClaimPolicy: 'release-session',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/management/app.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'core',
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: {
      route: 'session',
      refFrameEffect: 'may-invalidate',
      allowInvalidRecording: true,
      saveScriptFlagOwner: true,
      sessionlessLeaseAdmissionExemption: resolvePlainCloseLeaseAdmissionExemption,
      appLease: 'allowed',
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    compositeResource: 'session-lifecycle',
    platformExecution: { kind: 'device-runtime', uses: closeApplicationRuntimePlanUses },
  },
] as const satisfies readonly RawCommandDescriptor[];
