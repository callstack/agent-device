import {
  listCommandFamilyCliOutputFormatters,
  listCommandFamilyMetadata,
} from './family/registry.ts';
import type { CliOutput } from './command-contract.ts';
import type { CommandProgressState } from './command-progress.ts';
import { routeResponseWarnings, type CliOutputFormatter } from './output-common.ts';
import type { CommandName } from './command-metadata.ts';

const cliOutputFormatters = listCommandFamilyCliOutputFormatters() as Partial<
  Record<CommandName, CliOutputFormatter>
>;

const parseableOutputCommands = new Set(
  listCommandFamilyMetadata()
    .filter((metadata) => metadata.parseableOutput === true)
    .map((metadata) => metadata.name),
);

/**
 * The one place a response's `Warning:` lines become text a human or an agent reads. Each formatter
 * renders its own result; the dispatcher then appends the warnings to stdout, or to stderr for a
 * command that declares `parseableOutput` because its stdout is the value a caller parses. A command
 * that gains a formatter therefore discloses without knowing about it, and one that stays silent is
 * a declared exception rather than an oversight.
 */
export async function formatCliOutput(params: {
  name: CommandName;
  input: unknown;
  result: unknown;
  progress?: CommandProgressState;
}): Promise<CliOutput | undefined> {
  const output = await cliOutputFormatters[params.name]?.({
    input: (params.input ?? {}) as Record<string, unknown>,
    result: params.result,
    progress: params.progress,
  });
  if (output === undefined) return undefined;
  return routeResponseWarnings(
    output,
    params.result,
    parseableOutputCommands.has(params.name) ? 'stderr' : 'text',
  );
}

/** Commands whose stdout is the value itself, so their warnings belong on stderr. */
export function isParseableOutputCommand(name: CommandName): boolean {
  return parseableOutputCommands.has(name);
}
