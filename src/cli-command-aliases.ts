import type { CliFlags } from './commands/cli-grammar/flag-types.ts';

type BooleanCliFlagKey = {
  [Key in keyof CliFlags]-?: Exclude<CliFlags[Key], undefined> extends boolean ? Key : never;
}[keyof CliFlags];

export type CliCommandAlias = {
  alias: string;
  command: string;
  impliedFlags?: readonly BooleanCliFlagKey[];
};

const CLI_COMMAND_ALIASES: readonly CliCommandAlias[] = [
  { alias: 'long-press', command: 'longpress' },
  { alias: 'metrics', command: 'perf' },
  { alias: 'tap', command: 'press' },
  { alias: 'launch', command: 'open' },
  { alias: 'relaunch', command: 'open', impliedFlags: ['relaunch'] },
  // Deprecated: `rotate` was renamed to `orientation` (it collided with the
  // `gesture rotate` two-finger gesture). Kept working at the CLI for a few versions.
  { alias: 'rotate', command: 'orientation' },
];

const aliasByToken: ReadonlyMap<string, CliCommandAlias> = new Map(
  CLI_COMMAND_ALIASES.map((entry) => [entry.alias, entry]),
);

export function normalizeCliCommandAlias(command: string): string {
  return aliasByToken.get(command.toLowerCase())?.command ?? command;
}

export function cliCommandAlias(rawCommand: string): CliCommandAlias | undefined {
  return aliasByToken.get(rawCommand.toLowerCase());
}

export function cliAliasesForCommand(command: string): CliCommandAlias[] {
  return CLI_COMMAND_ALIASES.filter((entry) => entry.command === command);
}
