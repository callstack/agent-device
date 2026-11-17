import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';

/**
 * One step of a daemon batch, as submitted.
 *
 * Declared here rather than in `@agent-device/command-registry/batch` because the public API
 * vocabulary (`contracts/client-replay.ts`) is stated in terms of it, and contracts sits below
 * command-registry.
 *
 * The `runtime` field used to be written as `DaemonRequest['runtime']`, which pulled the whole daemon
 * request type in to say `SessionRuntimeHints` — the same type, one zone lower.
 */
export type DaemonBatchStep = {
  command: string;
  positionals?: string[];
  input?: Record<string, unknown>;
  flags?: Record<string, unknown>;
  runtime?: SessionRuntimeHints;
};

/**
 * The command name a submitted step carries, as the daemon will RUN it.
 *
 * Declared here because both sides of the batch boundary read a step: the daemon normalizes it
 * before its handler sees it, and a client that checks a daemon's answer against the plan it
 * submitted resolves the same step to the same command. A caller that matched the raw value would
 * read ` CLOSE ` as no command at all while the daemon runs `close`.
 */
export function normalizeBatchCommandName(command: unknown): string {
  return typeof command === 'string' ? command.trim().toLowerCase() : '';
}
