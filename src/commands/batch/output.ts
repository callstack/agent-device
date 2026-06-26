import type { BatchRunResult, BatchStepResult } from '../../core/batch.ts';
import { readCommandMessage } from '../../utils/success-text.ts';
import type { CliOutput } from '../command-contract.ts';
import { resultOutput, type CliOutputFormatter } from '../output-common.ts';

function batchCliOutput(result: BatchRunResult): CliOutput {
  const lines = [
    `Batch completed: ${result.executed}/${result.total} steps in ${result.totalDurationMs}ms`,
  ];
  for (const entry of result.results) {
    lines.push(renderBatchStepLine(entry));
  }
  return { data: result, text: lines.join('\n') };
}

export const batchCliOutputFormatters = {
  batch: resultOutput<BatchRunResult>(batchCliOutput),
} as const satisfies Record<string, CliOutputFormatter>;

function renderBatchStepLine(result: BatchStepResult): string {
  const description = readCommandMessage(result.data) ?? result.command;
  return `${result.step}. OK ${description} (${result.durationMs}ms)`;
}
