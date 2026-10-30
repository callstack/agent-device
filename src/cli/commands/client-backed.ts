import { isCommandName, type CommandName } from '@agent-device/command-surface';

export type ClientBackedCliCommandName = CommandName;

export function isClientBackedCliCommandName(
  command: string,
): command is ClientBackedCliCommandName {
  return isCommandName(command);
}
