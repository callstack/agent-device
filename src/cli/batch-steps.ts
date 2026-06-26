import type { BatchStep } from '../client-types.ts';
import type { SessionRuntimeHints } from '../contracts.ts';
import { readInputFromCli } from '../commands/cli-grammar.ts';
import { isCommandName, type CommandName } from '../commands/command-metadata.ts';
import type { CliFlags } from '../utils/cli-flags.ts';
import { AppError } from '../utils/errors.ts';

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
    if (isStructuredBatchStep(step)) return step;
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

function isStructuredBatchStep(step: unknown): step is BatchStep {
  return (
    step !== null &&
    typeof step === 'object' &&
    !Array.isArray(step) &&
    'input' in step &&
    !('positionals' in step) &&
    !('flags' in step) &&
    isRuntimeHints((step as Record<string, unknown>).runtime)
  );
}

function readLegacyCliBatchStep(step: unknown, stepNumber: number): LegacyCliBatchStep {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    throw new AppError('INVALID_ARGS', `Invalid batch step ${stepNumber}.`);
  }
  const record = step as Record<string, unknown>;
  assertLegacyBatchStepKeys(record, stepNumber);
  const command = readLegacyCommand(record.command, stepNumber);
  const positionals = readLegacyPositionals(record.positionals, stepNumber);
  const flags = readLegacyFlags(record.flags, stepNumber);
  const runtime = readRuntimeHints(record.runtime, stepNumber);
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', `Batch step ${stepNumber} flags must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readRuntimeHints(value: unknown, stepNumber: number): SessionRuntimeHints | undefined {
  if (value === undefined) return undefined;
  if (!isRuntimeHints(value)) {
    throw new AppError('INVALID_ARGS', `Batch step ${stepNumber} runtime must be an object.`);
  }
  return value;
}

function isRuntimeHints(value: unknown): value is SessionRuntimeHints | undefined {
  return (
    value === undefined || (Boolean(value) && typeof value === 'object' && !Array.isArray(value))
  );
}

function cliFlagsFromBatchStep(flags: Record<string, unknown> | undefined): CliFlags {
  return {
    json: false,
    help: false,
    version: false,
    ...(flags as Partial<CliFlags> | undefined),
  };
}
