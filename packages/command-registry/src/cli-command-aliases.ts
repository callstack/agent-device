import type { CliFlags } from '@agent-device/contracts/command';
import {
  PERF_AGGREGATE_ALIAS,
  PERF_AGGREGATE_REMOVED_ERROR_MESSAGE,
} from '@agent-device/contracts/observability';

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
  { alias: 'tap', command: 'press' },
  { alias: 'launch', command: 'open' },
  { alias: 'relaunch', command: 'open', impliedFlags: ['relaunch'] },
];

const aliasByToken: ReadonlyMap<string, CliCommandAlias> = new Map(
  CLI_COMMAND_ALIASES.map((entry) => [entry.alias, entry]),
);

const ROTATE_REMOVED_ERROR_MESSAGE =
  'rotate was renamed to orientation; for the two-finger gesture use: gesture rotate';
const RETIRED_CLI_COMMANDS: ReadonlyMap<string, string> = new Map([
  [PERF_AGGREGATE_ALIAS, PERF_AGGREGATE_REMOVED_ERROR_MESSAGE],
  ['rotate', ROTATE_REMOVED_ERROR_MESSAGE],
]);

export function normalizeCliCommandAlias(command: string): string {
  return aliasByToken.get(command.toLowerCase())?.command ?? command;
}

export function retiredCliCommandMessage(command: string): string | undefined {
  return RETIRED_CLI_COMMANDS.get(command.toLowerCase());
}

export function cliCommandAlias(rawCommand: string): CliCommandAlias | undefined {
  return aliasByToken.get(rawCommand.toLowerCase());
}

export function cliAliasesForCommand(command: string): CliCommandAlias[] {
  return CLI_COMMAND_ALIASES.filter((entry) => entry.command === command);
}
