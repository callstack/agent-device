export const BOUNDARY_FAULTS = [
  'timeout',
  'cancellation',
  'response-framing',
  'process-death',
  'lost-response-after-mutation',
  'filesystem-failure',
  'optional-optimization-failure',
] as const;

export const BOUNDARY_COMMAND_CLASSES = [
  'mutation',
  'read',
  'artifact-producing',
  'session-lifecycle',
] as const;

export type BoundaryFault = (typeof BOUNDARY_FAULTS)[number];
export type BoundaryCommandClass = (typeof BOUNDARY_COMMAND_CLASSES)[number];

export type BoundaryInvariant =
  | 'bounded-deadline'
  | 'no-mutation-replay'
  | 'typed-error-identity'
  | 'request-scoped-cancellation'
  | 'request-signal-cleanup'
  | 'atomic-publication'
  | 'publication-residue-free'
  | 'claim-or-lease-state'
  | 'best-effort-degradation';

export type BoundaryCoverage =
  | Readonly<{
      kind: 'covered';
      evidence: readonly [string, ...string[]];
      invariants: readonly [BoundaryInvariant, ...BoundaryInvariant[]];
    }>
  | Readonly<{
      kind: 'not-applicable';
      reason: string;
    }>;

export type BoundaryFaultMatrix = {
  readonly [fault in BoundaryFault]: {
    readonly [commandClass in BoundaryCommandClass]: BoundaryCoverage;
  };
};

/**
 * The boundary-fault contract is deliberately nested by both axes. Adding a
 * fault or command class makes this declaration fail to typecheck until every
 * cell is classified and points at executable evidence (or explains why the
 * fault has no meaning for that class).
 */
export const BOUNDARY_FAULT_MATRIX = {
  timeout: {
    mutation: {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-transport.test.ts:timeout'],
      invariants: ['bounded-deadline', 'typed-error-identity'],
    },
    read: {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/daemon-client-timeout-route.test.ts:http timeout'],
      invariants: ['bounded-deadline', 'typed-error-identity'],
    },
    'artifact-producing': {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-transport.test.ts:timeout'],
      invariants: ['bounded-deadline', 'typed-error-identity'],
    },
    'session-lifecycle': {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-transport.test.ts:timeout'],
      invariants: ['bounded-deadline', 'typed-error-identity'],
    },
  },
  cancellation: {
    mutation: {
      kind: 'covered',
      evidence: ['test/integration/provider-scenarios/daemon-http-boundary-cancellation.test.ts'],
      invariants: ['request-scoped-cancellation', 'request-signal-cleanup'],
    },
    read: {
      kind: 'covered',
      evidence: ['test/integration/provider-scenarios/daemon-http-boundary-cancellation.test.ts'],
      invariants: ['request-scoped-cancellation', 'request-signal-cleanup'],
    },
    'artifact-producing': {
      kind: 'covered',
      evidence: ['test/integration/provider-scenarios/daemon-http-boundary-cancellation.test.ts'],
      invariants: ['request-scoped-cancellation', 'request-signal-cleanup'],
    },
    'session-lifecycle': {
      kind: 'covered',
      evidence: ['test/integration/provider-scenarios/daemon-http-boundary-cancellation.test.ts'],
      invariants: ['request-scoped-cancellation', 'request-signal-cleanup'],
    },
  },
  'response-framing': {
    mutation: {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-transport.test.ts:response framing'],
      invariants: ['typed-error-identity', 'no-mutation-replay'],
    },
    read: {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-transport.test.ts:response framing'],
      invariants: ['typed-error-identity'],
    },
    'artifact-producing': {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-transport.test.ts:response framing'],
      invariants: ['typed-error-identity'],
    },
    'session-lifecycle': {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-transport.test.ts:response framing'],
      invariants: ['typed-error-identity'],
    },
  },
  'process-death': {
    mutation: {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-acceptance.test.ts'],
      invariants: ['bounded-deadline', 'no-mutation-replay'],
    },
    read: {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-acceptance.test.ts'],
      invariants: ['bounded-deadline'],
    },
    'artifact-producing': {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-acceptance.test.ts'],
      invariants: ['bounded-deadline'],
    },
    'session-lifecycle': {
      kind: 'covered',
      evidence: ['src/daemon/client/__tests__/boundary-fault-acceptance.test.ts'],
      invariants: ['bounded-deadline'],
    },
  },
  'lost-response-after-mutation': {
    mutation: {
      kind: 'covered',
      evidence: ['packages/platform-apple/src/runner/__tests__/runner-recovery-wiring.test.ts'],
      invariants: ['no-mutation-replay', 'typed-error-identity'],
    },
    read: {
      kind: 'not-applicable',
      reason:
        'The fault is defined after a mutation dispatch; read commands cannot satisfy that precondition.',
    },
    'artifact-producing': {
      kind: 'not-applicable',
      reason:
        'The fault is defined after a mutation dispatch; artifact reads do not satisfy that precondition.',
    },
    'session-lifecycle': {
      kind: 'not-applicable',
      reason:
        'Lifecycle commands use the separate process-death and response-framing rows; this fault requires a mutation.',
    },
  },
  'filesystem-failure': {
    mutation: {
      kind: 'not-applicable',
      reason:
        'The scoped filesystem fault is an artifact-publication errno, not a command-dispatch fault.',
    },
    read: {
      kind: 'not-applicable',
      reason: 'Read commands do not publish the tmp-to-rename artifacts owned by this matrix.',
    },
    'artifact-producing': {
      kind: 'covered',
      evidence: [
        'src/daemon/__tests__/filesystem-boundary-faults.test.ts',
        'packages/platform-apple/src/runner/__tests__/runner-lease-filesystem-boundary-faults.test.ts',
      ],
      invariants: ['atomic-publication', 'publication-residue-free'],
    },
    'session-lifecycle': {
      kind: 'covered',
      evidence: [
        'src/daemon/__tests__/filesystem-boundary-faults.test.ts',
        'packages/platform-apple/src/runner/__tests__/runner-lease-filesystem-boundary-faults.test.ts',
      ],
      invariants: ['atomic-publication', 'publication-residue-free', 'claim-or-lease-state'],
    },
  },
  'optional-optimization-failure': {
    mutation: {
      kind: 'covered',
      evidence: ['src/daemon/interaction/internal/__tests__/interaction-touch-direct-ios.test.ts'],
      invariants: ['best-effort-degradation'],
    },
    read: {
      kind: 'covered',
      evidence: ['src/core/__tests__/dispatch-resolve.test.ts'],
      invariants: ['best-effort-degradation'],
    },
    'artifact-producing': {
      kind: 'covered',
      evidence: ['packages/platform-apple/src/core/__tests__/screenshot.test.ts'],
      invariants: ['best-effort-degradation'],
    },
    'session-lifecycle': {
      kind: 'covered',
      evidence: ['packages/platform-web/src/agent-browser-provider.test.ts'],
      invariants: ['best-effort-degradation'],
    },
  },
} as const satisfies BoundaryFaultMatrix;
