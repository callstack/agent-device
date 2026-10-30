import { findCommandMetadata, type CommandName } from '@agent-device/command-surface';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { batchCliOutputFormatters } from './batch/output.ts';
import { captureCliOutputFormatters } from './capture/output.ts';
import type { CommandProgressState } from './command-progress.ts';
import { debuggingCliOutputFormatters } from './debugging/output.ts';
import { interactionCliOutputFormatters } from './interaction/output.ts';
import { managementCliOutputFormatters } from './management/output.ts';
import { metroCliOutputFormatters } from './metro/output.ts';
import { observabilityCliOutputFormatters } from './observability/output.ts';
import { routeResponseWarnings, type CliOutput, type CliOutputFormatter } from './output-common.ts';
import { perfCliOutputFormatters } from './perf/output.ts';
import { recordingCliOutputFormatters } from './recording/output.ts';
import { replayCliOutputFormatters } from './replay/output.ts';
import { systemCliOutputFormatters } from './system/output.ts';

type CliOutputFormatters = Partial<Record<CommandName, CliOutputFormatter>>;

const cliOutputFormatters = mergeCliOutputFormatters([
  batchCliOutputFormatters,
  captureCliOutputFormatters,
  debuggingCliOutputFormatters,
  interactionCliOutputFormatters,
  managementCliOutputFormatters,
  metroCliOutputFormatters,
  observabilityCliOutputFormatters,
  perfCliOutputFormatters,
  recordingCliOutputFormatters,
  replayCliOutputFormatters,
  systemCliOutputFormatters,
]);

function mergeCliOutputFormatters(tables: readonly CliOutputFormatters[]): CliOutputFormatters {
  const merged: CliOutputFormatters = {};
  for (const table of tables) {
    for (const [command, formatter] of Object.entries(table) as [
      CommandName,
      CliOutputFormatter,
    ][]) {
      if (Object.hasOwn(merged, command)) {
        throw new Error(`Duplicate CLI output formatter: ${command}`);
      }
      merged[command] = formatter;
    }
  }
  return merged;
}

/** @internal Introspection helper used by the CLI output parity tests. */
export function listCliOutputFormatters(): CliOutputFormatters {
  return { ...cliOutputFormatters };
}

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
  /** The caller's host environment; a formatter that styles output reads color from it. */
  env: EnvMap;
}): Promise<CliOutput | undefined> {
  const output = await cliOutputFormatters[params.name]?.({
    input: (params.input ?? {}) as Record<string, unknown>,
    result: params.result,
    progress: params.progress,
    env: params.env,
  });
  if (output === undefined) return undefined;
  return routeResponseWarnings(
    output,
    params.result,
    isParseableOutputCommand(params.name) ? 'stderr' : 'text',
  );
}

/** Commands whose stdout is the value itself, so their warnings belong on stderr. */
export function isParseableOutputCommand(name: CommandName): boolean {
  return findCommandMetadata(name).parseableOutput === true;
}
