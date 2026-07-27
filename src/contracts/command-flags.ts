import type { CliFlags, DaemonExcludedCliFlag } from './cli-flags.ts';
import type { DaemonBatchStep } from './batch-step.ts';
import type { Point } from '../kernel/snapshot.ts';

// The flag vocabulary a dispatched command is stated in terms of.
//
// This is the CLI flag set minus the flags that never cross the daemon boundary, plus the
// daemon-side additions. It lives in contracts/ because the zones on both sides of the process
// boundary are declared in terms of it: `core/` composes descriptors around it, `daemon/` narrows
// its request type with it, and `replay/` reads it back off a recorded action. Declaring it in
// `core/` (rank 2) meant every one of those had to reach up or across to say "a command's flags".
//
// The kernel wire type deliberately keeps `flags?: Record<string, unknown>` — untyped, because the
// wire cannot enforce a shape. This is the typed view of the same field, one rank above the wire
// and below every consumer.

export type MaestroRuntimeFlags = {
  allowNonHittableCoordinateFallback?: boolean;
  expectedTapPoint?: Point;
  prewarmRunnerBeforeOpen?: boolean;
  screenshotCaptureBackend?: 'runner';
};

export type CommandFlags = Omit<CliFlags, DaemonExcludedCliFlag> & {
  batchSteps?: DaemonBatchStep[];
  clearAppState?: boolean;
  interactionOutcome?: {
    retryOnNoChange?: boolean;
  };
  launchArgs?: string[];
  kind?: string;
  maestro?: MaestroRuntimeFlags;
  postGestureStabilization?: boolean;
  snapshotIncludeHiddenContentHints?: boolean;
  leaseProvider?: string;
  provider?: string;
  deviceKey?: string;
  clientId?: string;
  devicePort?: number;
  hostPort?: number;
  portReverseName?: string;
  replayBackend?: string;
  shardCount?: number;
  shardIndex?: number;
};
