import { isDaemonHandlerFile } from './daemon-layers.ts';
import { DAEMON_SOURCE_ROOT } from './tracked-sources.ts';

/** The handler surface as a shape rule: any `<layer>/handlers/` folder, owning layer agnostic. */
const DAEMON_HANDLER_TARGET_SHAPES = [isDaemonHandlerFile] as const;

type FacadeDeclaration = Readonly<{
  root: string;
  exports: readonly string[];
}>;

export type LogicalModulePolicy = Readonly<{
  name: string;
  roots: readonly string[];
  forbiddenTargetRoots: readonly string[];
  internalForbiddenTargetRoots?: readonly string[];
  /**
   * Shape-based forbidden targets, paired with (never replacing) the path-root arrays: e.g.
   * `isDaemonHandlerFile` guards the handler surface wherever a `<layer>/handlers/` folder lives,
   * so a handler folder under a layer nobody listed is still off-limits.
   */
  forbiddenTargetShapes?: readonly ((file: string) => boolean)[];
  internalForbiddenTargetShapes?: readonly ((file: string) => boolean)[];
  facades?: readonly FacadeDeclaration[];
}>;

const DAEMON_SESSION_LIFECYCLE_FACADES = [
  {
    root: 'packages/daemon/src/sessions/session-lifecycle/internal/session-close.ts',
    exports: ['SessionCloseCommandInput', 'handleSessionCloseCommands'],
  },
  {
    root: 'packages/daemon/src/sessions/session-lifecycle/internal/inventory.ts',
    exports: ['SessionInventoryCommandInput', 'handleSessionInventoryCommands'],
  },
  {
    root: 'packages/daemon/src/sessions/session-lifecycle/internal/session-open.ts',
    exports: ['SessionOpenCommandInput', 'handleSessionOpenCommands'],
  },
] as const;

const DAEMON_SESSION_OBSERVABILITY_FACADES = [
  {
    root: 'packages/daemon/src/sessions/session-observability/internal/session-observability.ts',
    exports: ['SessionObservabilityCommandInput', 'handleSessionObservabilityCommands'],
  },
] as const;

export const SESSION_LIFECYCLE_RETIRED_HANDLER_PATHS = [
  'packages/daemon/src/sessions/session-lifecycle/index.ts',
  'packages/daemon/src/handlers/session-device-utils.ts',
  'packages/daemon/src/handlers/session-runtime-admission.ts',
  'packages/daemon/src/handlers/session-open.ts',
  'packages/daemon/src/handlers/session-open-prepare.ts',
  'packages/daemon/src/handlers/session-open-execution.ts',
  'packages/daemon/src/handlers/session-open-foreground.ts',
  'packages/daemon/src/handlers/session-open-surface.ts',
  'packages/daemon/src/handlers/session-startup-metrics.ts',
] as const;

export const INTERACTION_RETIRED_HANDLER_PATHS = [
  'packages/daemon/src/handlers/find.ts',
  'packages/daemon/src/handlers/find-match-ranking.ts',
  'packages/daemon/src/handlers/find-match-resolution.ts',
  'packages/daemon/src/handlers/find-target-capture.ts',
  'packages/daemon/src/handlers/interaction.ts',
  'packages/daemon/src/handlers/interaction-android-escape.ts',
  'packages/daemon/src/handlers/interaction-gesture.ts',
  'packages/daemon/src/handlers/interaction-gesture-response.ts',
  'packages/daemon/src/handlers/interaction-ios-tap-outcome.ts',
  'packages/daemon/src/handlers/interaction-targeting.ts',
  'packages/daemon/src/handlers/interaction-touch.ts',
  'packages/daemon/src/handlers/interaction-touch-android-freshness.ts',
  'packages/daemon/src/handlers/interaction-touch-android-readiness.ts',
  'packages/daemon/src/handlers/interaction-touch-direct-ios-eligibility.ts',
  'packages/daemon/src/handlers/interaction-touch-direct-ios.ts',
  'packages/daemon/src/handlers/interaction-touch-fill.ts',
  'packages/daemon/src/handlers/interaction-touch-payload.ts',
  'packages/daemon/src/handlers/interaction-touch-policy.ts',
  'packages/daemon/src/handlers/interaction-touch-prepare.ts',
  'packages/daemon/src/handlers/interaction-touch-press-admission.ts',
  'packages/daemon/src/handlers/interaction-touch-press.ts',
  'packages/daemon/src/handlers/interaction-touch-reference-frame.ts',
  'packages/daemon/src/handlers/interaction-touch-response.ts',
  'packages/daemon/src/handlers/interaction-touch-runtime.ts',
  'packages/daemon/src/handlers/interaction-touch-targets.ts',
  'packages/daemon/src/handlers/system-surface-disclosure.ts',
] as const;

const DAEMON_INTERACTION_FACADE = {
  root: 'packages/daemon/src/execution/interaction/index.ts',
  exports: [
    'FindRouteInput',
    'InteractionRouteInput',
    'bindInteractionSession',
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
  'packages/daemon/src/sessions/session-observability/index.ts',
  'packages/daemon/src/handlers/session-observability.ts',
  'packages/daemon/src/handlers/session-perf-runtime.ts',
  'packages/daemon/src/handlers/session-network.ts',
  'packages/daemon/src/handlers/session-audio.ts',
] as const;

export const SNAPSHOT_EXECUTION_RETIRED_HANDLER_PATHS = [
  'packages/daemon/src/handlers/snapshot-capture.ts',
  'packages/daemon/src/handlers/snapshot-interactor-capture.ts',
  'packages/daemon/src/handlers/snapshot-session.ts',
] as const;

/** The CLI, typed client, remote transports and daemon client: code that reaches the daemon over the network. */
export const CLIENT_SIDE_POLICY_NAME = 'client-side';

export const LOGICAL_MODULE_POLICIES = [
  {
    name: CLIENT_SIDE_POLICY_NAME,
    roots: ['src/cli.ts', 'src/cli/', 'src/client/', 'packages/remote/src/', 'src/daemon-client/'],
    forbiddenTargetRoots: [DAEMON_SOURCE_ROOT],
  },
  {
    name: 'ad-replay',
    roots: ['packages/ad-replay/src/'],
    forbiddenTargetRoots: [
      DAEMON_SOURCE_ROOT,
      'src/providers/',
      'src/compat/',
      'packages/maestro/',
      'packages/replay-port/',
    ],
  },
  {
    name: 'maestro',
    roots: ['packages/maestro/src/'],
    forbiddenTargetRoots: [
      DAEMON_SOURCE_ROOT,
      'src/providers/',
      'packages/ad-replay/',
      'packages/replay-port/',
    ],
  },
  {
    name: 'replay-test',
    roots: ['packages/replay-test/src/'],
    forbiddenTargetRoots: [
      DAEMON_SOURCE_ROOT,
      'src/providers/',
      'src/request/',
      'src/compat/',
      'packages/maestro/',
      'packages/ad-replay/',
      'packages/replay-port/',
    ],
  },
  {
    name: 'replay-port',
    roots: ['packages/replay-port/src/'],
    forbiddenTargetRoots: [DAEMON_SOURCE_ROOT, 'src/providers/', 'src/compat/'],
  },
  {
    name: 'daemon-session-lifecycle',
    roots: ['packages/daemon/src/sessions/session-lifecycle/'],
    forbiddenTargetRoots: [],
    forbiddenTargetShapes: DAEMON_HANDLER_TARGET_SHAPES,
    facades: DAEMON_SESSION_LIFECYCLE_FACADES,
  },
  {
    name: 'daemon-interaction',
    roots: ['packages/daemon/src/execution/interaction/'],
    forbiddenTargetRoots: [],
    internalForbiddenTargetShapes: DAEMON_HANDLER_TARGET_SHAPES,
    facades: [DAEMON_INTERACTION_FACADE],
  },
  {
    name: 'daemon-session-observability',
    roots: ['packages/daemon/src/sessions/session-observability/'],
    forbiddenTargetShapes: DAEMON_HANDLER_TARGET_SHAPES,
    facades: DAEMON_SESSION_OBSERVABILITY_FACADES,
  },
] as const satisfies readonly LogicalModulePolicy[];

export const ARCHITECTURE_OWNERSHIP = {
  logicalModules: LOGICAL_MODULE_POLICIES,
  facades: LOGICAL_MODULE_POLICIES.flatMap((module) =>
    (module.facades ?? []).map((facade) => ({ name: module.name, ...facade })),
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
      root: 'packages/daemon/src/core/request-runtime-binding.ts',
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
      root: 'packages/daemon/src/core/session-script-publication-capability.ts',
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
      root: 'packages/daemon/src/core/session-state.ts',
      exports: ['SessionState'],
    },
    {
      name: 'session-store-authority',
      kind: 'live-state-authority',
      root: 'packages/daemon/src/core/session-store.ts',
      exports: ['SessionStore'],
    },
  ],
  executablePolicies: [
    {
      name: 'snapshot-policy',
      kind: 'executable-policy',
      roots: ['packages/capture-kit/src/snapshot/'],
      forbiddenTargetRoots: [DAEMON_SOURCE_ROOT],
    },
  ],
} as const;

export function matchesDeclaredRoot(file: string, root: string): boolean {
  return root.endsWith('/') ? file.startsWith(root) : file === root;
}
