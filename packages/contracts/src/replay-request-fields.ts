import type { ReplayScriptSourceBundle } from './replay.ts';

/**
 * The replay/test request vocabulary, declared once.
 *
 * `CliFlags` and `CommandExecutionOptions` are two views of the same request — the flags a CLI
 * invocation parses and the options a programmatic call passes — and every replay/suite field
 * appears in both. Stating them here keeps the two views from drifting field by field; each view
 * adds only what is genuinely its own (`replayMaestro` and the reporter flags are CLI-side,
 * `replayBackend` is the resolved engine the client sends).
 */
export type ReplayRequestFields = {
  replayUpdate?: boolean;
  replayEnv?: string[];
  replayShellEnv?: Record<string, string>;
  /**
   * #1802: the caller-read script text `replay` executes. The daemon never opens a caller path,
   * so this is the ONLY source a replay run reads.
   */
  replayScriptSource?: ReplayScriptSourceBundle;
  /** #1802: `test`'s caller-side discovery result — one bundle per discovered source, in run order. */
  replayScriptSources?: ReplayScriptSourceBundle[];
  replayFrom?: number;
  replayPlanDigest?: string;
  /** Replay: leave the session active by suppressing an authored terminal close in native .ad. */
  replayKeepSession?: boolean;
  failFast?: boolean;
  timeoutMs?: number;
  retries?: number;
  recordVideo?: boolean;
  artifactsDir?: string;
  shardAll?: number;
  shardSplit?: number;
};
