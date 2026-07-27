import type { DaemonRequest as WireRequest } from '../kernel/contracts.ts';
import type { CommandFlags } from './command-flags.ts';

/**
 * The command a request dispatches: its name, its positionals, and its typed flags.
 *
 * Deliberately not a third name for "a request" — there are two request shapes, at two ranks:
 *
 * - `kernel/contracts.ts` `DaemonRequest` — the WIRE shape, with `flags?: Record<string, unknown>`,
 *   because a process boundary cannot enforce a flag vocabulary.
 * - `daemon/types.ts` `DaemonRequest` — the wire shape with `token`/`session` required, `flags`
 *   narrowed to `CommandFlags`, and `internal?: DaemonRequestInternal` carrying `SessionState`
 *   callbacks, the admitted lease and the resolved session scope. Server-private, which is why it
 *   cannot move down here.
 *
 * `core/command-descriptor/` classifies commands — ADR 0014 ref-frame effects, ADR 0016 recording
 * effects — and needs exactly these three fields to do it. It used to import the daemon's
 * `DaemonRequest`: reaching up two ranks, and depending on the server's private extension to read a
 * command name. `command` and `positionals` are `Pick`ed from the wire so they cannot drift from it.
 */
export type DispatchedCommand = Pick<WireRequest, 'command' | 'positionals'> & {
  flags?: CommandFlags;
};
