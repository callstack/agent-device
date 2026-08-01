import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import type { CommandFlags } from './command-flags.ts';
import type { TargetAnnotationV1 } from './target-annotation.ts';

// One recorded action in a session's script.
//
// `replay/` reads and writes these and the Maestro package exports them, so declaring the
// shape inside `daemon/types.ts` made both zones depend on the daemon server to describe a file
// format neither of them asks the daemon to produce. The daemon still owns the RECORDING — it is
// the only thing that appends actions; this is only the shape they are appended in.
//
// It could not move until `CommandFlags` did, since a recorded action carries the flags it ran
// with: this was the tail of a three-link chain (DaemonBatchStep -> CommandFlags -> SessionAction).

export type SessionAction = {
  ts: number;
  command: string;
  positionals: string[];
  runtime?: SessionRuntimeHints;
  flags: Partial<CommandFlags> & {
    snapshotInteractiveOnly?: boolean;
    snapshotDepth?: number;
    snapshotScope?: string;
    snapshotRaw?: boolean;
    launchArgs?: string[];
    saveScript?: boolean | string;
    noRecord?: boolean;
  };
  result?: Record<string, unknown>;
  /**
   * ADR 0012 decision 3: parsed or record-time-computed `target-v1`
   * evidence, written as a comment immediately before this action's line.
   * Inert until migration step 4 adds enforcement.
   */
  targetEvidence?: TargetAnnotationV1;
};
