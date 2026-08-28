export type LogicalModulePolicy = Readonly<{
  name: string;
  roots: readonly string[];
  forbiddenTargetRoots: readonly string[];
}>;

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
] as const satisfies readonly LogicalModulePolicy[];

export const ARCHITECTURE_OWNERSHIP = {
  logicalModules: LOGICAL_MODULE_POLICIES,
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
