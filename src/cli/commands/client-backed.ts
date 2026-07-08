import { isCommandName, type CommandName } from '../../commands/command-metadata.ts';

export type ClientBackedCliCommandName = CommandName;

export function isClientBackedCliCommandName(
  command: string,
): command is ClientBackedCliCommandName {
  return isCommandName(command);
}
