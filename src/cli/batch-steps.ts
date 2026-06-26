import type { BatchStep } from '../client-types.ts';
import { daemonRuntimeSchema, type SessionRuntimeHints } from '../contracts.ts';
import { readInputFromCli } from '../commands/cli-grammar.ts';
import { isCommandName, type CommandName } from '../commands/command-metadata.ts';
import type { CliFlags } from '../utils/cli-flags.ts';
import { AppError } from '../utils/errors.ts';
import { isRecord } from '../utils/parsing.ts';

type LegacyCliBatchStep = {
  command: CommandName;
  positionals?: string[];
  flags?: Record<string, unknown>;
  runtime?: SessionRuntimeHints;
};

export function readCliBatchStepsJson(raw: string): BatchStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError('INVALID_ARGS', 'Batch steps must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AppError('INVALID_ARGS', 'Batch steps must be a non-empty JSON array.');
  }
  return normalizeCliBatchSteps(parsed);
}

function normalizeCliBatchSteps(steps: unknown[]): BatchStep[] {
  let sawLegacyStep = false;
  const normalized = steps.map((step, index) => {
    if (isStructuredBatchStepShape(step)) return readStructuredBatchStep(step, index + 1);
    const legacyStep = readLegacyCliBatchStep(step, index + 1);
    sawLegacyStep = true;
    return legacyStepToStructuredStep(legacyStep);
  });
  if (sawLegacyStep) {
    process.stderr.write(
      'Warning: batch steps using positionals/flags are deprecated and will be removed in the next major version. Use {"command":"...","input":{...}} steps instead.\n',
    );
  }
  return normalized;
}

function legacyStepToStructuredStep(legacyStep: LegacyCliBatchStep): BatchStep {
  const input = readInputFromCli(
    legacyStep.command,
    legacyStep.positionals ?? [],
    cliFlagsFromBatchStep(legacyStep.flags),
  );
  return {
    command: legacyStep.command,
    input,
    ...(legacyStep.runtime === undefined ? {} : { runtime: legacyStep.runtime }),
  };
}

function isStructuredBatchStepShape(step: unknown): step is Record<string, unknown> & BatchStep {
  return isRecord(step) && 'input' in step && !('positionals' in step) && !('flags' in step);
}

function readStructuredBatchStep(
  step: Record<string, unknown> & BatchStep,
  stepNumber: number,
): BatchStep {
  const runtime = readRuntimeHints(step.runtime, stepNumber);
  const { runtime: _runtime, ...rest } = step;
  return {
    ...rest,
    ...(runtime === undefined ? {} : { runtime }),
  };
}

function readLegacyCliBatchStep(step: unknown, stepNumber: number): LegacyCliBatchStep {
  if (!isRecord(step)) {
    throw new AppError('INVALID_ARGS', `Invalid batch step ${stepNumber}.`);
  }
  assertLegacyBatchStepKeys(step, stepNumber);
  const command = readLegacyCommand(step.command, stepNumber);
  const positionals = readLegacyPositionals(step.positionals, stepNumber);
  const flags = readLegacyFlags(step.flags, stepNumber);
  const runtime = readRuntimeHints(step.runtime, stepNumber);
  return {
    command,
    ...(positionals === undefined ? {} : { positionals }),
    ...(flags === undefined ? {} : { flags }),
    ...(runtime === undefined ? {} : { runtime }),
  };
}

function readLegacyCommand(value: unknown, stepNumber: number): CommandName {
  const command = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!command) throw new AppError('INVALID_ARGS', `Batch step ${stepNumber} requires command.`);
  if (isCommandName(command)) return command;
  throw new AppError(
    'INVALID_ARGS',
    `Batch step ${stepNumber} command is not available through command batch: ${String(value)}`,
  );
}

function assertLegacyBatchStepKeys(record: Record<string, unknown>, stepNumber: number): void {
  const unknownKeys = Object.keys(record).filter(
    (key) => !['command', 'positionals', 'flags', 'runtime'].includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new AppError(
      'INVALID_ARGS',
      `Batch step ${stepNumber} has unknown legacy field(s): ${unknownKeys.join(', ')}.`,
    );
  }
}

function readLegacyPositionals(value: unknown, stepNumber: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new AppError(
      'INVALID_ARGS',
      `Batch step ${stepNumber} positionals must contain only strings.`,
    );
  }
  return value;
}

function readLegacyFlags(value: unknown, stepNumber: number): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new AppError('INVALID_ARGS', `Batch step ${stepNumber} flags must be an object.`);
  }
  return value;
}

function readRuntimeHints(value: unknown, stepNumber: number): SessionRuntimeHints | undefined {
  if (value === undefined) return undefined;
  try {
    return daemonRuntimeSchema.parse(value);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `Batch step ${stepNumber} runtime is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function cliFlagsFromBatchStep(flags: Record<string, unknown> | undefined): CliFlags {
  return {
    json: false,
    help: false,
    version: false,
    ...(flags as Partial<CliFlags> | undefined),
  };
}
