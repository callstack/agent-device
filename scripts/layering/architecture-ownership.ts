type FacadeDeclaration = Readonly<{
  root: string;
  exports: readonly string[];
}>;

export type LogicalModulePolicy = Readonly<{
  name: string;
  roots: readonly string[];
  forbiddenTargetRoots: readonly string[];
  internalForbiddenTargetRoots?: readonly string[];
  facade?: FacadeDeclaration;
}>;

const DAEMON_REPLAY_FACADE = {
  root: 'src/daemon/replay/index.ts',
  exports: ['ReplaySession', 'ReplayTestVideoOwner', 'runReplayCommand', 'runReplayTestCommand'],
} as const;

const DAEMON_SESSION_LIFECYCLE_FACADE = {
  root: 'src/daemon/session-lifecycle/index.ts',
  exports: [
    'SessionCloseCommandInput',
    'SessionInventoryCommandInput',
    'SessionOpenCommandInput',
    'handleSessionCloseCommands',
    'handleSessionInventoryCommands',
    'handleSessionOpenCommands',
  ],
} as const;

const DAEMON_SESSION_OBSERVABILITY_FACADE = {
  root: 'src/daemon/session-observability/index.ts',
  exports: ['SessionObservabilityCommandInput', 'handleSessionObservabilityCommands'],
} as const;

export const SESSION_LIFECYCLE_RETIRED_HANDLER_PATHS = [
  'src/daemon/handlers/session-device-utils.ts',
  'src/daemon/handlers/session-runtime-admission.ts',
  'src/daemon/handlers/session-open.ts',
  'src/daemon/handlers/session-open-prepare.ts',
  'src/daemon/handlers/session-open-execution.ts',
  'src/daemon/handlers/session-open-foreground.ts',
  'src/daemon/handlers/session-open-surface.ts',
  'src/daemon/handlers/session-startup-metrics.ts',
] as const;

export const INTERACTION_RETIRED_HANDLER_PATHS = [
  'src/daemon/handlers/find.ts',
  'src/daemon/handlers/find-match-ranking.ts',
  'src/daemon/handlers/find-match-resolution.ts',
  'src/daemon/handlers/find-target-capture.ts',
  'src/daemon/handlers/interaction.ts',
  'src/daemon/handlers/interaction-android-escape.ts',
  'src/daemon/handlers/interaction-gesture.ts',
  'src/daemon/handlers/interaction-gesture-response.ts',
  'src/daemon/handlers/interaction-ios-tap-outcome.ts',
  'src/daemon/handlers/interaction-targeting.ts',
  'src/daemon/handlers/interaction-touch.ts',
  'src/daemon/handlers/interaction-touch-android-freshness.ts',
  'src/daemon/handlers/interaction-touch-android-readiness.ts',
  'src/daemon/handlers/interaction-touch-direct-ios-eligibility.ts',
  'src/daemon/handlers/interaction-touch-direct-ios.ts',
  'src/daemon/handlers/interaction-touch-fill.ts',
  'src/daemon/handlers/interaction-touch-payload.ts',
  'src/daemon/handlers/interaction-touch-policy.ts',
  'src/daemon/handlers/interaction-touch-prepare.ts',
  'src/daemon/handlers/interaction-touch-press-admission.ts',
  'src/daemon/handlers/interaction-touch-press.ts',
  'src/daemon/handlers/interaction-touch-reference-frame.ts',
  'src/daemon/handlers/interaction-touch-response.ts',
  'src/daemon/handlers/interaction-touch-runtime.ts',
  'src/daemon/handlers/interaction-touch-targets.ts',
  'src/daemon/handlers/system-surface-disclosure.ts',
] as const;

const DAEMON_INTERACTION_FACADE = {
  root: 'src/daemon/interaction/index.ts',
  exports: [
    'FindRouteInput',
    'InteractionRouteInput',
    'captureSnapshotForSession',
    'createInteractionRuntime',
    'finalizeTouchInteraction',
    'handleFindCommands',
    'handleInteractionCommands',
    'readSettleRequest',
    'refMutationAdmissionResponse',
    'settleFlagGuardResponse',
  ],
} as const;

export const SESSION_OBSERVABILITY_RETIRED_HANDLER_PATHS = [
  'src/daemon/handlers/session-observability.ts',
  'src/daemon/handlers/session-perf-runtime.ts',
  'src/daemon/handlers/session-network.ts',
  'src/daemon/handlers/session-audio.ts',
] as const;

export const SNAPSHOT_EXECUTION_RETIRED_HANDLER_PATHS = [
  'src/daemon/handlers/snapshot-capture.ts',
  'src/daemon/handlers/snapshot-interactor-capture.ts',
  'src/daemon/handlers/snapshot-session.ts',
] as const;

export const LOGICAL_MODULE_POLICIES = [
  {
    name: 'ad-replay',
    roots: ['packages/ad-replay/src/'],
    forbiddenTargetRoots: ['src/daemon/', 'src/providers/', 'src/compat/', 'packages/maestro/'],
  },
  {
    name: 'maestro',
    roots: ['packages/maestro/src/'],
    forbiddenTargetRoots: ['src/daemon/', 'src/providers/', 'packages/ad-replay/'],
  },
  {
    name: 'replay-test',
    roots: ['packages/replay-test/src/'],
    forbiddenTargetRoots: [
      'src/daemon/',
      'src/providers/',
      'src/request/',
      'src/compat/',
      'packages/maestro/',
      'packages/ad-replay/',
    ],
  },
  {
    name: 'daemon-replay',
    roots: ['src/daemon/replay/'],
    forbiddenTargetRoots: [
      'src/daemon/handlers/record-runtime.ts',
      'src/daemon/session-store.ts',
      'src/daemon/session-lifecycle/',
    ],
    facade: DAEMON_REPLAY_FACADE,
  },
  {
    name: 'daemon-session-lifecycle',
    roots: ['src/daemon/session-lifecycle/'],
    forbiddenTargetRoots: ['src/daemon/handlers/'],
    facade: DAEMON_SESSION_LIFECYCLE_FACADE,
  },
  {
    name: 'daemon-interaction',
    roots: ['src/daemon/interaction/'],
    forbiddenTargetRoots: [],
    internalForbiddenTargetRoots: ['src/daemon/handlers/'],
    facade: DAEMON_INTERACTION_FACADE,
  },
  {
    name: 'daemon-session-observability',
    roots: ['src/daemon/session-observability/'],
    forbiddenTargetRoots: ['src/daemon/handlers/'],
    facade: DAEMON_SESSION_OBSERVABILITY_FACADE,
  },
] as const satisfies readonly LogicalModulePolicy[];

export const ARCHITECTURE_OWNERSHIP = {
  logicalModules: LOGICAL_MODULE_POLICIES,
  facades: LOGICAL_MODULE_POLICIES.flatMap((module) =>
    module.facade ? [{ name: module.name, ...module.facade }] : [],
  ),
  vocabulary: [
    {
      name: 'client-contract',
      kind: 'vocabulary',
      roots: ['packages/contracts/src/facades/client.ts'],
    },
    {
      name: 'capture-contract',
      kind: 'vocabulary',
      roots: ['packages/contracts/src/facades/capture.ts'],
    },
    {
      name: 'replay-contract',
      kind: 'vocabulary',
      roots: ['packages/contracts/src/facades/replay.ts'],
    },
    {
      name: 'progress-contract',
      kind: 'vocabulary',
      roots: ['packages/contracts/src/facades/progress.ts'],
    },
  ],
  capabilities: [
    {
      name: 'request-runtime-binding',
      kind: 'capability',
      root: 'src/daemon/request-runtime-binding.ts',
      exports: [
        'BindDeviceRuntime',
        'BindExactDeviceRuntime',
        'BoundDeviceIdentity',
        'InspectDeviceRuntimeFacts',
        'RequestRuntimeBindings',
        'RuntimeAdmissionBindings',
        'createRequestRuntimeBindings',
        'ensureBoundDeviceReady',
      ],
    },
    {
      name: 'session-script-publication',
      kind: 'capability',
      root: 'src/daemon/session-script-publication-capability.ts',
      exports: [
        'abortAuthoringOnSecondOpen',
        'applyRecordedSaveScriptFlags',
        'armAuthoringOnOpen',
        'effectiveWriteForce',
        'isAuthoringArmedSession',
        'isSessionRecording',
        'isSessionScriptPublished',
        'markActivePublicationDone',
        'markCloseGeneratedPublicationDone',
        'retargetActivePublication',
      ],
    },
  ],
  liveState: [
    {
      name: 'session-state-shape',
      kind: 'live-state-shape',
      root: 'src/daemon/types.ts',
      exports: ['SessionState'],
    },
    {
      name: 'session-store-authority',
      kind: 'live-state-authority',
      root: 'src/daemon/session-store.ts',
      exports: ['SessionStore'],
    },
  ],
  executablePolicies: [
    {
      name: 'snapshot-policy',
      kind: 'executable-policy',
      roots: ['src/snapshot/'],
      forbiddenTargetRoots: ['src/daemon/'],
    },
  ],
} as const;

export function matchesDeclaredRoot(file: string, root: string): boolean {
  return root.endsWith('/') ? file.startsWith(root) : file === root;
}
