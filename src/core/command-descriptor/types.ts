import type { CommandCapability } from '../capabilities.ts';
import type { DaemonCommandDescriptor } from '../../daemon/daemon-command-registry.ts';

/**
 * The daemon route + request-policy traits for a command, minus the `command`
 * key (which is carried at the descriptor top level as `name`). This reuses the
 * existing hand-authored `DaemonCommandDescriptor` shape VERBATIM — including the
 * closure traits (`allowSessionlessDefaultDevice`, `skipSessionlessProviderDevice`)
 * — rather than flattening them into booleans.
 */
export type DaemonCommandTraits = Omit<DaemonCommandDescriptor, 'command'>;

/**
 * The single additive command-descriptor shape (ADR-0008, Phase 1 step 1).
 *
 * Per command this carries, side-by-side, the facts that today live in three
 * separate hand-authored tables:
 *  - `daemon`     — the daemon route + request-policy traits
 *                   (from DAEMON_COMMAND_DESCRIPTORS). Absent for commands that
 *                   have no daemon route (e.g. `app-switcher`, `install-from-source`).
 *  - `capability` — the optional platform/kind capability entry
 *                   (from BASE_COMMAND_CAPABILITY_MATRIX).
 *  - `batchable`  — whether the command is exposed through `batch`
 *                   (from STRUCTURED_BATCH_COMMAND_NAMES).
 *  - `mcpExposed` — whether the command is surfaced over MCP.
 *
 * This registry is dormant: nothing reads it yet. It exists only to be proven
 * byte-equal to the live hand tables by the parity tests, as the strangler-fig
 * foundation for later slices that flip consumers and delete the hand tables.
 */
export type CommandDescriptor = {
  name: string;
  daemon?: DaemonCommandTraits;
  capability?: CommandCapability;
  batchable: boolean;
  mcpExposed: boolean;
};

/** Identity helper that pins each entry to the {@link CommandDescriptor} shape. */
export function defineCommandDescriptor(descriptor: CommandDescriptor): CommandDescriptor {
  return descriptor;
}
