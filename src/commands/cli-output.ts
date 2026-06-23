import { listCommandFamilyCliOutputFormatters } from './family/registry.ts';
import type { CliOutput } from './command-contract.ts';
import type { CliOutputFormatter } from './output-common.ts';
import type { CommandName } from './command-metadata.ts';

const cliOutputFormatters = listCommandFamilyCliOutputFormatters() as Partial<
  Record<CommandName, CliOutputFormatter>
>;

export function formatCliOutput(params: {
  name: CommandName;
  input: unknown;
  result: unknown;
}): CliOutput | undefined {
  return cliOutputFormatters[params.name]?.({
    input: (params.input ?? {}) as Record<string, unknown>,
    result: params.result,
  });
}
