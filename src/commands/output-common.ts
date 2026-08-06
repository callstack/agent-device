import { readCommandMessage } from '../utils/success-text.ts';
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
