import { readCommandMessage } from '@agent-device/kernel/success-text';
import type { CliOutput } from './command-contract.ts';

export type CliOutputFormatter = (params: {
  input: Record<string, unknown>;
  result: unknown;
}) => CliOutput;

export function resultOutput<TResult>(
  formatter: (result: TResult) => CliOutput,
): CliOutputFormatter {
  return ({ result }) => formatter(result as TResult);
}

export const messageOutput = resultOutput(messageCliOutput);

export function messageCliOutput(result: Record<string, unknown>): CliOutput {
  return { data: result, text: readCommandMessage(result) };
}

/**
 * `messageCliOutput` plus one `Warning:` line per entry of the response's `warnings`
 * array — the composable warnings channel (`open`, `debug`, snapshot capture use it too),
 * so a warning the daemon appended reaches the human CLI reader, not only `--json`.
 */
export const messageWithWarningsOutput = resultOutput(
  (result: Record<string, unknown>): CliOutput => {
    const output = messageCliOutput(result);
    const warnings = Array.isArray(result.warnings)
      ? result.warnings.filter((warning): warning is string => typeof warning === 'string')
      : [];
    if (warnings.length === 0) return output;
    const lines = [output.text, ...warnings.map((warning) => `Warning: ${warning}`)];
    return { data: output.data, text: lines.filter(Boolean).join('\n') };
  },
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
