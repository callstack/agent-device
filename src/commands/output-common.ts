import { readCommandMessage, readResponseWarnings } from '@agent-device/kernel/success-text';
import type { CommandProgressState } from './command-progress.ts';
import type { CliOutput } from './command-contract.ts';

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
 * The response message plus one `Warning:` line per entry of the response's warnings — the
 * composable warnings channel (`open`, `debug`, and every capture route use it), so a warning the
 * daemon appended reaches the human CLI reader and not only `--json`.
 */
export function messageWithWarningsText(result: Record<string, unknown>): string | null {
  return appendWarningLinesText(readCommandMessage(result), result);
}

/**
 * One `Warning:` line per response warning, after text a formatter rendered itself. Every
 * capture-consuming command routes its text through this so a disclosure cannot be visible on
 * `snapshot` and silent on the `get`/`is`/`find`/`wait`/`press` that consumed the same capture. A
 * warning already in the text is skipped: two renderers may wrap one response (a settle-capable
 * command's notes and its own line), and the second must not repeat the first.
 */
export function appendWarningLinesText(
  text: string | null | undefined,
  result: Record<string, unknown>,
): string | null {
  const rendered = text ?? '';
  const warnings = [
    ...(typeof result.warning === 'string' && result.warning.trim() !== '' ? [result.warning] : []),
    ...readResponseWarnings(result),
  ]
    .map((warning) => collapseWarningText(warning))
    .filter((warning) => warning.length > 0 && !rendered.includes(warning))
    .map((warning) => `Warning: ${warning}`);
  if (warnings.length === 0) return text ?? null;
  return [...(rendered === '' ? [] : [rendered]), ...warnings].join('\n');
}

/**
 * Appends the response's `Warning:` lines to a formatter's own text (#2682). A formatter that
 * returns its output synchronously stays synchronous: the note is text, not work.
 */
export function withResponseWarnings<TFormatter extends CliOutputFormatter>(
  formatter: TFormatter,
): TFormatter {
  return ((params: CliOutputFormatterParams) => {
    const output = formatter(params);
    return output instanceof Promise
      ? output.then((resolved) => withWarningLines(resolved))
      : withWarningLines(output);
  }) as TFormatter;
}

function withWarningLines(output: CliOutput): CliOutput {
  return {
    data: output.data,
    text: appendWarningLinesText(output.text, output.data as Record<string, unknown>),
  };
}

/** Warning text can embed runner newlines; rendered warning lines stay one-per-warning. */
export function collapseWarningText(warning: string): string {
  return warning.replaceAll(/\s*\n\s*/g, ' ');
}

/** `messageCliOutput` carrying {@link messageWithWarningsText} as its text. */
export const messageWithWarningsOutput = resultOutput(
  (result: Record<string, unknown>): CliOutput => ({
    data: result,
    text: messageWithWarningsText(result),
  }),
);

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
