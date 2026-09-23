import {
  isShardedTestRequest,
  NO_PLATFORM_EXECUTION,
  ownerFilesEnabled,
  type RawCommandDescriptor,
} from '../descriptor-traits.ts';
import { DEFAULT_TIMEOUT_POLICY } from '../timeout-policy.ts';

/**
 * The commands that run OTHER commands (`src/commands/replay/**`, `src/commands/batch/**`):
 * each step re-enters the pipeline under the named command's own descriptor, which is why all
 * three declare `refFrameEffect: 'delegated'`.
 */
export const REPLAY_COMMAND_DESCRIPTORS = [
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
    // Replay durations are script-dependent; --timeout bounds the envelope.
    timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY, budget: { source: 'flag' } },
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
    // Test is suite orchestration over replay attempts; each attempt delegates its admitted
    // operations, including Maestro viewport acquisition, to their own descriptors.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'batch',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/batch/index.ts'] as const } : {}),
    catalog: { group: 'public' },
    frameworkTier: 'extended',
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'delegated' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    // Wave 6 residue: every step runs as its own daemon request under its own descriptor, which
    // is what `refFrameEffect: 'delegated'` already says. `batch` itself reaches no device.
    platformExecution: NO_PLATFORM_EXECUTION,
  },
] as const satisfies readonly RawCommandDescriptor[];
