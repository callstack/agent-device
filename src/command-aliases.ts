import type { CliFlags } from './commands/cli-grammar/flag-types.ts';

type BooleanCliFlagKey = {
  [Key in keyof CliFlags]-?: Exclude<CliFlags[Key], undefined> extends boolean ? Key : never;
}[keyof CliFlags];

export type CommandAlias = {
  alias: string;
  command: string;
  impliedFlags?: readonly BooleanCliFlagKey[];
  /** A previously canonical command name that must work outside CLI parsing. */
  crossSurfaceRename?: true;
  /** Legacy response discriminant retained for hidden compatibility execution. */
  legacyResultAction?: string;
};

// The single source of truth for command-name aliases. CLI parsing accepts all
// entries and applies implied flags. Non-CLI command-data boundaries accept only
// cross-surface renames: ordinary CLI aliases such as `relaunch` cannot be
// rewritten safely without also applying their parser-only implied flags.
const COMMAND_ALIASES: readonly CommandAlias[] = [
  { alias: 'long-press', command: 'longpress' },
  { alias: 'metrics', command: 'perf' },
  { alias: 'tap', command: 'press' },
  { alias: 'launch', command: 'open' },
  { alias: 'relaunch', command: 'open', impliedFlags: ['relaunch'] },
  // Deprecated: `rotate` collided with the `gesture rotate` two-finger gesture.
  {
    alias: 'rotate',
    command: 'orientation',
    crossSurfaceRename: true,
    legacyResultAction: 'rotate',
  },
];

const aliasByToken: ReadonlyMap<string, CommandAlias> = new Map(
  COMMAND_ALIASES.map((entry) => [entry.alias, entry]),
);

export function normalizeCommandAlias(command: string): string {
  return aliasByToken.get(command.toLowerCase())?.command ?? command;
}

export function normalizeCrossSurfaceCommandAlias(command: string): string {
  const entry = aliasByToken.get(command.toLowerCase());
  return entry?.crossSurfaceRename === true ? entry.command : command;
}

export function commandAlias(rawCommand: string): CommandAlias | undefined {
  return aliasByToken.get(rawCommand.toLowerCase());
}

export function aliasesForCommand(command: string): CommandAlias[] {
  return COMMAND_ALIASES.filter((entry) => entry.command === command);
}
