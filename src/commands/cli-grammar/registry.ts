import type { CliFlags } from '../../utils/cli-flags.ts';
import type { CommandName } from '../command-metadata.ts';
import { listCommandFamilyCliReaders } from '../family/registry.ts';

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
  return reader(positionals, flags);
}
