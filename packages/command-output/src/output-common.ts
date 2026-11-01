import type { CommandMetadata, CommandName } from '@agent-device/command-surface';
import { readCommandMessage, readResponseWarnings } from '@agent-device/kernel/success-text';
import type { EnvMap } from '@agent-device/kernel/source-value';

/**
 * Whether streamed `command` progress has already been rendered for the human
 * reader of this CLI run.
 *
 * A command whose final output would repeat what progress already said reads it
 * and prints the shorter form instead (`doctorCliOutput`). The state is handed
 * to the formatter with the result, so a caller that renders progress somewhere
 * else — an SDK or MCP consumer passing its own `RequestProgressSink`, which
 * writes nothing to this process's stderr — is never told progress was rendered
 * here, and gets the full output.
 */
export type CommandProgressState = {
  renderedToStderr: boolean;
};

export type CliOutput = {
  data: unknown;
  jsonData?: unknown;
  text?: string | null;
  stderr?: string | null;
};

export type CliOutputFormatterParams = {
  input: Record<string, unknown>;
  result: unknown;
  /**
   * Progress already rendered for this run, when the caller renders progress
   * itself. Absent for a caller that streams progress somewhere the human
   * reader of this output will not see (MCP, an SDK sink) — and for one that
   * asked for no progress at all.
   */
  progress?: CommandProgressState;
  /** The caller's host environment; a formatter that styles output reads color from it. */
  env: EnvMap;
  /** Whether the caller's stderr is a terminal; a formatter that colors status markers reads it. */
  stderrIsTTY: boolean;
};

export type CliOutputFormatter = (
  params: CliOutputFormatterParams,
) => CliOutput | Promise<CliOutput>;

export function resultOutput<TResult, TOutput extends CliOutput | Promise<CliOutput> = CliOutput>(
  formatter: (result: TResult) => TOutput,
): (params: CliOutputFormatterParams) => TOutput {
  return ({ result }) => formatter(result as TResult);
}

export const messageOutput = resultOutput(messageCliOutput);

export function messageCliOutput(result: Record<string, unknown>): CliOutput {
  return { data: result, text: readCommandMessage(result) };
}

/**
 * The response's composable warnings — the singular `warning` field, then the `warnings` array the
 * capture routes append to (`open`, `debug`, and every capture consumer use it) — collapsed so each
 * one renders on a single line.
 */
function collectResponseWarnings(result: Record<string, unknown>): string[] {
  return [
    ...(typeof result.warning === 'string' && result.warning.trim() !== '' ? [result.warning] : []),
    ...readResponseWarnings(result),
  ]
    .map((warning) => collapseWarningText(warning))
    .filter((warning) => warning.length > 0);
}

/**
 * One `Warning:` line per response warning, after text a formatter rendered itself. A warning the
 * text already carries is skipped: a report builder may render the channel inside its own text, and
 * the dispatcher must then say it once, not twice.
 */
export function appendWarningLinesText(
  text: string | null | undefined,
  result: Record<string, unknown>,
): string | null {
  const rendered = text ?? '';
  const lines = collectResponseWarnings(result)
    .filter((warning) => !rendered.includes(warning))
    .map((warning) => `Warning: ${warning}`);
  if (lines.length === 0) return text ?? null;
  return [...(rendered === '' ? [] : [rendered]), ...lines].join('\n');
}

/**
 * Where the single CLI dispatcher sends a response's warnings (#2682). `text` puts them after the
 * command's own line; `stderr` is for a command whose stdout IS the value a caller parses
 * (`CommandMetadata.parseableOutput`), where an appended line would corrupt it. No formatter chooses
 * a route: `dispatchCliOutput` derives it from the command's descriptor once, which is why a new
 * formatter cannot drop the disclosure and no wrapper can repeat it.
 */
export type ResponseWarningRoute = 'text' | 'stderr';

/** The route a command's descriptor metadata declares: a parseable-output command warns on stderr. */
export function responseWarningRoute(
  metadata: Pick<CommandMetadata<CommandName, unknown>, 'parseableOutput'>,
): ResponseWarningRoute {
  return metadata.parseableOutput === true ? 'stderr' : 'text';
}

export function routeResponseWarnings(
  output: CliOutput,
  response: unknown,
  route: ResponseWarningRoute,
): CliOutput {
  // The response is the source, not `output.data`: a formatter that rebuilds its own data payload
  // (`close`, `devices`) would otherwise be able to swallow the warnings channel with it.
  const data = (response ?? {}) as Record<string, unknown>;
  if (route === 'text') return { ...output, text: appendWarningLinesText(output.text, data) };
  const rendered = `${output.text ?? ''}\n${output.stderr ?? ''}`;
  const lines = collectResponseWarnings(data)
    .filter((warning) => !rendered.includes(warning))
    .map((warning) => `Warning: ${warning}`);
  if (lines.length === 0) return output;
  const stderr = output.stderr ?? '';
  return {
    ...output,
    stderr: `${stderr}${stderr === '' || stderr.endsWith('\n') ? '' : '\n'}${lines.join('\n')}\n`,
  };
}

/** Warning text can embed runner newlines; rendered warning lines stay one-per-warning. */
export function collapseWarningText(warning: string): string {
  return warning.replaceAll(/\s+/g, (whitespace) => (whitespace.includes('\n') ? ' ' : whitespace));
}

/**
 * ADR 0014: a reusable ref in a PARTIAL result renders in ready-to-copy
 * `@eN~s<refsGeneration>` form so a human CLI caller can paste it into the next
 * mutation without a separate pin step. A mutating result carries no
 * `refsGeneration`, so its acted ref is never pinned.
 */
export function pinnedRefText(ref: unknown, refsGeneration: unknown): string | undefined {
  if (typeof ref !== 'string' || ref.length === 0) return undefined;
  if (typeof refsGeneration !== 'number') return undefined;
  const body = ref.startsWith('@') ? ref.slice(1) : ref;
  return `@${body}~s${refsGeneration}`;
}
