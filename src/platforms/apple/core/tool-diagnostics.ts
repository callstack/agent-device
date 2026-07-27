import { AppError } from '../../../kernel/errors.ts';

export function extractAppleToolErrorMeta(error: unknown): Record<string, unknown> {
  if (!(error instanceof AppError)) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
  const details = (error.details ?? {}) as {
    args?: unknown;
    exitCode?: unknown;
    stderr?: unknown;
    stdout?: unknown;
    timeoutMs?: unknown;
  };
  const args = Array.isArray(details.args)
    ? details.args.filter((value): value is string => typeof value === 'string').join(' ')
    : undefined;

  return {
    errorCode: error.code,
    reason: error.message,
    timeoutMs: typeof details.timeoutMs === 'number' ? details.timeoutMs : undefined,
    exitCode: typeof details.exitCode === 'number' ? details.exitCode : undefined,
    stderr:
      typeof details.stderr === 'string' && details.stderr.trim() ? details.stderr : undefined,
    stdout:
      typeof details.stdout === 'string' && details.stdout.trim() ? details.stdout : undefined,
    commandArgs: args,
  };
}

export function appleToolFailureText(error: AppError): string {
  const details = (error.details ?? {}) as { stdout?: unknown; stderr?: unknown; args?: unknown };
  const stdout = typeof details.stdout === 'string' ? details.stdout : '';
  const stderr = typeof details.stderr === 'string' ? details.stderr : '';
  const args = Array.isArray(details.args)
    ? details.args.filter((value): value is string => typeof value === 'string').join(' ')
    : '';
  return `${error.message}\n${stdout}\n${stderr}\n${args}`.toLowerCase();
}
