import type { CliFlags } from './commands/cli-grammar/flag-types.ts';

type BooleanCliFlagKey = {
  [Key in keyof CliFlags]-?: Exclude<CliFlags[Key], undefined> extends boolean ? Key : never;
}[keyof CliFlags];

export type CommandAlias = {
  alias: string;
  command: string;
  impliedFlags?: readonly BooleanCliFlagKey[];
};

// The single source of truth for command-name aliases. It is applied at two
// ingress boundaries so an alias resolves the same way regardless of how a
// command arrives: CLI token parsing (`src/cli/parser/args.ts`) and the daemon
// request boundary (`src/daemon/request-router.ts`), which covers structured
// batch steps, recorded replay data, and older remote clients that send the
// wire command directly. `impliedFlags` is a CLI-parse-only concern.
const COMMAND_ALIASES: readonly CommandAlias[] = [
  { alias: 'long-press', command: 'longpress' },
  { alias: 'metrics', command: 'perf' },
  { alias: 'tap', command: 'press' },
  { alias: 'launch', command: 'open' },
  { alias: 'relaunch', command: 'open', impliedFlags: ['relaunch'] },
  // Deprecated: `rotate` collided with the `gesture rotate` two-finger gesture.
  { alias: 'rotate', command: 'orientation' },
];

const aliasByToken: ReadonlyMap<string, CommandAlias> = new Map(
  COMMAND_ALIASES.map((entry) => [entry.alias, entry]),
);

export function normalizeCommandAlias(command: string): string {
  return aliasByToken.get(command.toLowerCase())?.command ?? command;
}

export function commandAlias(rawCommand: string): CommandAlias | undefined {
  return aliasByToken.get(rawCommand.toLowerCase());
}

export function aliasesForCommand(command: string): CommandAlias[] {
  return COMMAND_ALIASES.filter((entry) => entry.command === command);
}
