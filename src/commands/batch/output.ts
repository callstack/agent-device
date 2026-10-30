import type { CommandName } from '@agent-device/command-surface';
import type { BatchRunResult, BatchStepResult } from '@agent-device/command-registry/batch';
import { readCommandMessage } from '@agent-device/kernel/success-text';
import { resultOutput, type CliOutputFormatter, type CliOutput } from '../output-common.ts';

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
} as const satisfies Partial<Record<CommandName, CliOutputFormatter>>;

function renderBatchStepLine(result: BatchStepResult): string {
  const description = readCommandMessage(result.data) ?? result.command;
  return `${result.step}. OK ${description} (${result.durationMs}ms)`;
}
