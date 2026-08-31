type FacadeDeclaration = Readonly<{
  root: string;
  exports: readonly string[];
}>;

export type LogicalModulePolicy = Readonly<{
  name: string;
  roots: readonly string[];
  forbiddenTargetRoots: readonly string[];
  facade?: FacadeDeclaration;
}>;

const DAEMON_REPLAY_FACADE = {
  root: 'src/daemon/replay/index.ts',
  exports: ['ReplaySession', 'ReplayTestVideoOwner', 'runReplayCommand', 'runReplayTestCommand'],
} as const;

const DAEMON_SESSION_LIFECYCLE_FACADE = {
  root: 'src/daemon/session-lifecycle/index.ts',
  exports: ['SessionInventoryCommandInput', 'handleSessionInventoryCommands'],
} as const;

export const SESSION_LIFECYCLE_RETIRED_HANDLER_PATHS = [
  'src/daemon/handlers/session-device-utils.ts',
  'src/daemon/handlers/session-runtime-admission.ts',
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
      'src/daemon/handlers/session-close.ts',
      'src/daemon/handlers/record-runtime.ts',
      'src/daemon/session-store.ts',
    ],
    facade: DAEMON_REPLAY_FACADE,
  },
  {
    name: 'daemon-session-lifecycle',
    roots: ['src/daemon/session-lifecycle/'],
    forbiddenTargetRoots: ['src/daemon/handlers/'],
    facade: DAEMON_SESSION_LIFECYCLE_FACADE,
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
        'InspectDeviceRuntimeFacts',
        'RequestRuntimeBindings',
        'RuntimeAdmissionBindings',
        'createRequestRuntimeBindings',
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
