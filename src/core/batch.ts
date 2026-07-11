import {
  type DaemonRequest,
  type DaemonResponse,
  type ResponseLevel,
  isNonDefaultResponseLevel,
} from '../kernel/contracts.ts';
import { AppError, asAppError } from '../kernel/errors.ts';
import { isRecord } from '../utils/parsing.ts';
import {
  DEFAULT_BATCH_MAX_STEPS,
  assertBatchStepCount,
  isValidBatchMaxSteps,
  parseBatchStepRuntime,
} from '../batch-contract.ts';
import {
  BATCH_DAEMON_STEP_KEYS,
  INHERITED_PARENT_FLAG_KEYS,
  assertBatchRuntimeCommandAllowed,
  normalizeBatchCommandName,
} from '../batch-policy.ts';

const batchAllowedStepKeys = new Set<string>(BATCH_DAEMON_STEP_KEYS);

export type DaemonBatchStep = {
  command: string;
  positionals?: string[];
  input?: Record<string, unknown>;
  flags?: Record<string, unknown>;
  runtime?: DaemonRequest['runtime'];
};

export type BatchFlags = Record<string, unknown> & {
  batchOnError?: 'stop';
  batchMaxSteps?: number;
  batchSteps?: DaemonBatchStep[];
};

export type BatchRequest = Omit<DaemonRequest, 'flags'> & {
  flags?: BatchFlags | Record<string, unknown>;
};

export type BatchInvoke = (req: BatchRequest) => Promise<DaemonResponse>;

export type NormalizedBatchStep = {
  command: string;
  positionals: string[];
  input?: Record<string, unknown>;
  flags: Record<string, unknown>;
  runtime?: DaemonRequest['runtime'];
};

export type BatchStepResult = {
  step: number;
  command: string;
  ok: true;
  data: Record<string, unknown>;
  durationMs: number;
};

export type BatchRunResult = Record<string, unknown> & {
  total: number;
  executed: number;
  totalDurationMs: number;
  results: BatchStepResult[];
};

export type BatchRunResponse =
  | {
      ok: true;
      data: BatchRunResult;
    }
  | Extract<DaemonResponse, { ok: false }>;

export async function runBatch(
  req: BatchRequest,
  sessionName: string,
  invoke: BatchInvoke,
): Promise<BatchRunResponse> {
  const flags = readBatchFlags(req.flags);
  const batchOnError = flags?.batchOnError ?? 'stop';
  if (batchOnError !== 'stop') {
    return batchErrorResponse('INVALID_ARGS', `Unsupported batch on-error mode: ${batchOnError}.`);
  }
  const batchMaxSteps = flags?.batchMaxSteps ?? DEFAULT_BATCH_MAX_STEPS;
  if (!isValidBatchMaxSteps(batchMaxSteps)) {
    return batchErrorResponse(
      'INVALID_ARGS',
      `Invalid batch max-steps: ${String(flags?.batchMaxSteps)}`,
    );
  }
  try {
    const steps = validateAndNormalizeBatchSteps(flags?.batchSteps, batchMaxSteps);
    const startedAt = Date.now();
    const partialResults: BatchStepResult[] = [];
    for (const [index, step] of steps.entries()) {
      const stepResponse = await runBatchStep(
        req,
        sessionName,
        step,
        invoke,
        index + 1,
        index === steps.length - 1,
      );
      if (!stepResponse.ok) {
        return {
          ok: false,
          error: {
            code: stepResponse.error.code,
            message: `Batch failed at step ${stepResponse.step} (${step.command}): ${stepResponse.error.message}`,
            hint: stepResponse.error.hint,
            diagnosticId: stepResponse.error.diagnosticId,
            logPath: stepResponse.error.logPath,
            details: {
              ...(stepResponse.error.details ?? {}),
              step: stepResponse.step,
              command: step.command,
              positionals: step.positionals,
              executed: index,
              total: steps.length,
              partialResults,
            },
          },
        };
      }
      partialResults.push(stepResponse.result);
    }
    const data: BatchRunResult = {
      total: steps.length,
      executed: steps.length,
      totalDurationMs: Date.now() - startedAt,
      results: partialResults,
    };
    return {
      ok: true,
      data,
    };
  } catch (error) {
    const appErr = asAppError(error);
    return batchErrorResponse(appErr.code, appErr.message, appErr.details);
  }
}

export function validateAndNormalizeBatchSteps(
  steps: unknown,
  maxSteps: number,
): NormalizedBatchStep[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new AppError('INVALID_ARGS', 'batch requires a non-empty batchSteps array.');
  }
  assertBatchStepCount(steps.length, maxSteps);

  const normalized: NormalizedBatchStep[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (!isRecord(step)) {
      throw new AppError('INVALID_ARGS', `Invalid batch step at index ${index}.`);
    }
    const unknownKeys = Object.keys(step).filter((key) => !batchAllowedStepKeys.has(key));
    if (unknownKeys.length > 0) {
      const fields = unknownKeys.map((key) => `"${key}"`).join(', ');
      throw new AppError(
        'INVALID_ARGS',
        `Batch step ${index + 1} has unknown field(s): ${fields}. Allowed fields: command, positionals, input, flags, runtime.`,
      );
    }
    const command = normalizeBatchCommandName(step.command);
    if (!command) {
      throw new AppError('INVALID_ARGS', `Batch step ${index + 1} requires command.`);
    }
    assertBatchRuntimeCommandAllowed(command, index + 1);
    if (step.positionals !== undefined && !Array.isArray(step.positionals)) {
      throw new AppError('INVALID_ARGS', `Batch step ${index + 1} positionals must be an array.`);
    }
    const positionals = (step.positionals ?? []) as unknown[];
    if (positionals.some((value) => typeof value !== 'string')) {
      throw new AppError(
        'INVALID_ARGS',
        `Batch step ${index + 1} positionals must contain only strings.`,
      );
    }
    if (step.flags !== undefined && !isRecord(step.flags)) {
      throw new AppError('INVALID_ARGS', `Batch step ${index + 1} flags must be an object.`);
    }
    if (step.input !== undefined && !isRecord(step.input)) {
      throw new AppError('INVALID_ARGS', `Batch step ${index + 1} input must be an object.`);
    }
    normalized.push({
      command,
      positionals: positionals as string[],
      input: step.input as Record<string, unknown> | undefined,
      flags: (step.flags ?? {}) as Record<string, unknown>,
      runtime: parseBatchStepRuntime(step.runtime, index + 1),
    });
  }
  return normalized;
}

function buildBatchStepFlags(
  parentFlags: BatchFlags | Record<string, unknown> | undefined,
  stepFlags: DaemonBatchStep['flags'] | Record<string, unknown> | undefined,
): BatchFlags {
  const {
    batchSteps: _batchSteps,
    batchOnError: _batchOnError,
    batchMaxSteps: _batchMaxSteps,
    ...merged
  } = stepFlags ?? {};
  return mergeParentFlags(readBatchFlags(parentFlags), merged as BatchFlags);
}

export function mergeParentFlags<TFlags extends Record<string, unknown>>(
  parentFlags: BatchFlags | Record<string, unknown> | undefined,
  childFlags: TFlags,
): TFlags {
  const parentRecord = readBatchFlags(parentFlags) ?? {};
  const childRecord = childFlags as Record<string, unknown>;
  for (const key of INHERITED_PARENT_FLAG_KEYS) {
    if (childRecord[key] === undefined && parentRecord[key] !== undefined) {
      childRecord[key] = parentRecord[key];
    }
  }
  return childFlags;
}

// Phase 4 (agent-cost) batch-step elision. When a non-default response level is
// requested for the whole batch, INTERMEDIATE steps are forced to `digest` so a
// multi-step run collapses tokens, while the FINAL step keeps the requested
// level. With no responseLevel (or `default`) this is a no-op, so the per-step
// meta is passed through unchanged — byte-identical to today (Maestro `.ad`
// recompare safe).
function batchStepResponseLevel(
  requested: ResponseLevel | undefined,
  isFinalStep: boolean,
): ResponseLevel | undefined {
  if (!isNonDefaultResponseLevel(requested)) return requested;
  return isFinalStep ? requested : 'digest';
}

function batchStepMeta(meta: BatchRequest['meta'], isFinalStep: boolean): BatchRequest['meta'] {
  const requested = meta?.responseLevel;
  const stepLevel = batchStepResponseLevel(requested, isFinalStep);
  if (stepLevel === requested) return meta;
  return { ...meta, responseLevel: stepLevel };
}

async function runBatchStep(
  req: BatchRequest,
  sessionName: string,
  step: NormalizedBatchStep,
  invoke: BatchInvoke,
  stepNumber: number,
  isFinalStep: boolean,
): Promise<
  | { ok: true; step: number; result: BatchStepResult }
  | {
      ok: false;
      step: number;
      error: {
        code: string;
        message: string;
        hint?: string;
        diagnosticId?: string;
        logPath?: string;
        details?: Record<string, unknown>;
      };
    }
> {
  const stepStartedAt = Date.now();
  const stepFlags = buildBatchStepFlags(req.flags, step.flags);
  if (stepFlags.session === undefined) {
    stepFlags.session = sessionName;
  }
  const response = await invoke({
    token: req.token,
    session: sessionName,
    command: step.command,
    positionals: step.positionals,
    input: step.input,
    flags: stepFlags,
    runtime: step.runtime === undefined ? req.runtime : step.runtime,
    meta: batchStepMeta(req.meta, isFinalStep),
  });
  const durationMs = Date.now() - stepStartedAt;
  if (!response.ok) {
    return { ok: false, step: stepNumber, error: response.error };
  }
  return {
    ok: true,
    step: stepNumber,
    result: {
      step: stepNumber,
      command: step.command,
      ok: true,
      data: response.data ?? {},
      durationMs,
    },
  };
}

function readBatchFlags(
  flags: BatchFlags | Record<string, unknown> | undefined,
): BatchFlags | undefined {
  return flags as BatchFlags | undefined;
}

function batchErrorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Extract<DaemonResponse, { ok: false }> {
  return {
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  };
}
