// Canonical CLI command aliases. This is the single source of truth for the
// case-insensitive command-token normalization the parser applies (args.ts)
// AND for the alias surface `explain` reports — so the two can never drift.
// Aliases are distinct from catalog keys: a catalog key is a descriptor's
// internal name, whereas an alias is a user-typed token the CLI grammar
// rewrites to a canonical command (optionally injecting implied flags).

export type CliCommandAlias = {
  /** The token an agent may type on the command line. */
  alias: string;
  /** The canonical command the alias normalizes to. */
  command: string;
  /**
   * Flags the alias implicitly sets. `relaunch` is `open --relaunch`; `launch`
   * is a plain `open` (forcing --relaunch there would silently destroy app
   * state), so only aliases with genuine implied semantics carry entries here.
   */
  impliedFlags?: readonly string[];
};

const CLI_COMMAND_ALIASES: readonly CliCommandAlias[] = [
  { alias: 'long-press', command: 'longpress' },
  { alias: 'metrics', command: 'perf' },
  { alias: 'tap', command: 'press' },
  { alias: 'launch', command: 'open' },
  { alias: 'relaunch', command: 'open', impliedFlags: ['relaunch'] },
];

const aliasByToken: ReadonlyMap<string, CliCommandAlias> = new Map(
  CLI_COMMAND_ALIASES.map((entry) => [entry.alias, entry]),
);

/**
 * Case-insensitive alias resolution: `TAP`/`Relaunch` normalize to their
 * canonical command; non-alias tokens pass through with their original casing
 * so unknown-command errors echo what the user typed.
 */
export function normalizeCliCommandAlias(command: string): string {
  return aliasByToken.get(command.toLowerCase())?.command ?? command;
}

export function cliCommandAlias(rawCommand: string): CliCommandAlias | undefined {
  return aliasByToken.get(rawCommand.toLowerCase());
}

/** Every alias that normalizes to the given canonical command, in table order. */
export function cliAliasesForCommand(command: string): CliCommandAlias[] {
  return CLI_COMMAND_ALIASES.filter((entry) => entry.command === command);
}
