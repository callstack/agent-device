/**
 * The one decoding of an Apple runner response body. Every reader of the
 * runner's HTTP envelope — command responses, the lifecycle `status` read, and
 * the adoption `uptime` probe — decodes here, so no caller can keep a private
 * rule about what is readable and what is an answer (#2662).
 */
import { AppError } from '@agent-device/kernel/errors';
import { classifyRunnerReportedError } from './runner-contract.ts';

export type RunnerResponsePayload = {
  ok?: unknown;
  error?: { code?: unknown; message?: unknown; hint?: unknown };
  data?: unknown;
};

/**
 * A body that is not JSON at all is transport-shaped failure, not an empty
 * response: a runner that died mid-write must not be read as having answered.
 */
export function decodeRunnerResponseBody(text: string): RunnerResponsePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('COMMAND_FAILED', 'Invalid runner response', { text });
  }
  return parsed && typeof parsed === 'object' ? (parsed as RunnerResponsePayload) : {};
}

/** The runner's `ok` is a Swift `Bool`, so only the literal `true` is an answer. */
export function isRunnerResponseOk(payload: RunnerResponsePayload): boolean {
  return payload.ok === true;
}

export function readRunnerResponseData(payload: RunnerResponsePayload): Record<string, unknown> {
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return {};
  return payload.data as Record<string, unknown>;
}

export function buildRunnerResponseError(
  payload: RunnerResponsePayload,
  logPath?: string,
): AppError {
  const runnerErrorCode = readRunnerErrorCode(payload.error?.code);
  const errorMessage =
    typeof payload.error?.message === 'string' ? payload.error.message : undefined;
  const hint = typeof payload.error?.hint === 'string' ? payload.error.hint : undefined;
  const classification = classifyRunnerReportedError(runnerErrorCode);
  return new AppError(classification.code, errorMessage ?? 'Runner error', {
    runner: payload,
    ...classification.details,
    xcodebuild: {
      exitCode: 1,
      stdout: '',
      stderr: '',
    },
    hint,
    logPath,
  });
}

function readRunnerErrorCode(rawCode: unknown): string | undefined {
  return typeof rawCode === 'string' && rawCode.trim().length > 0 ? rawCode.trim() : undefined;
}
