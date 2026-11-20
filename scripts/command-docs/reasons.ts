// The published `error.details.reason` values, grouped by the command that raises them. A command
// family declares its table in `packages/contracts/src/<family>-reasons.ts` and registers it here.
// The registration typechecks each row's `command` against the CLI command names.

import type { CliCommandName } from '@agent-device/command-registry/catalog';
import { SCROLL_REASONS } from '@agent-device/contracts/scroll-reasons';

type OwnedReasonRow = Readonly<{ reason: string; command: CliCommandName }>;

const COMMAND_REASON_TABLES = [SCROLL_REASONS] as const satisfies ReadonlyArray<
  Readonly<Record<string, OwnedReasonRow>>
>;

/** The reasons a command can refuse or fail with, in declaration order; empty when it has none. */
export function publishedReasonsOf(command: CliCommandName): string[] {
  return COMMAND_REASON_TABLES.flatMap((table) =>
    Object.values<OwnedReasonRow>(table)
      .filter((row) => row.command === command)
      .map((row) => row.reason),
  );
}
