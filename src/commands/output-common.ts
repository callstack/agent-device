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
