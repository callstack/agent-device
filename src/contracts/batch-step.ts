import type { SessionRuntimeHints } from '../kernel/contracts.ts';

/**
 * One step of a daemon batch, as submitted.
 *
 * Declared here rather than in `core/batch.ts` because the public API vocabulary
 * (`contracts/client-replay.ts`) is stated in terms of it, and `core/` sits above contracts. The
 * `runtime` field used to be written as `DaemonRequest['runtime']`, which pulled the whole daemon
 * request type in to say `SessionRuntimeHints` — the same type, one zone lower.
 */
export type DaemonBatchStep = {
  command: string;
  positionals?: string[];
  input?: Record<string, unknown>;
  flags?: Record<string, unknown>;
  runtime?: SessionRuntimeHints;
};
