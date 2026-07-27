import type { DaemonRequest as WireRequest } from '../kernel/contracts.ts';
import type { CommandFlags } from './command-flags.ts';

/**
 * A dispatched command with its flags typed.
 *
 * Three shapes describe a request, at three ranks, and the difference between them is the point:
 *
 * - `kernel/contracts.ts` `DaemonRequest` — the WIRE shape. `flags?: Record<string, unknown>`,
 *   because a process boundary cannot enforce a flag vocabulary.
 * - this — the wire shape with `flags` narrowed to `CommandFlags`. What a command surface needs to
 *   reason about a request without knowing anything about the server that will run it.
 * - `daemon/types.ts` `DaemonRequest` — this plus `token`/`session` required and
 *   `internal?: DaemonRequestInternal`, which carries `SessionState` callbacks, the admitted lease
 *   and the resolved session scope. Server-private, and the reason the daemon's version cannot move
 *   down here.
 *
 * `core/command-descriptor/` used to import the daemon's version to read `command`, `positionals`
 * and `flags` — reaching up two ranks for three fields, and taking a dependency on the server's
 * private extension to get them.
 */
export type CommandRequest = Omit<WireRequest, 'flags'> & {
  flags?: CommandFlags;
};
