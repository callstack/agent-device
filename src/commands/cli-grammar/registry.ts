import type { CliFlags } from '@agent-device/contracts/command';
import type { CommandName } from '../command-metadata.ts';
import { listCommandFamilyCliReaders } from '../family/registry.ts';
import { settleInputForCommand } from '../post-action-observation-grammar.ts';

const cliReaders = listCommandFamilyCliReaders();

export function readInputFromCli(
  command: CommandName,
  positionals: string[],
  flags: CliFlags,
): Record<string, unknown> {
  const reader = cliReaders[command];
  if (!reader) {
    throw new Error(`Missing CLI reader for command: ${command}`);
  }
  // #1652: the `--settle` triple merges here, at the one seam every reader
  // passes through, instead of being hand-spread per settle-capable reader —
  // a drop at any one of those silently disabled the flag.
  return { ...reader(positionals, flags), ...settleInputForCommand(command, flags) };
}
