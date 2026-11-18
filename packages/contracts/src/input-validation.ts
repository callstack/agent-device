import { AppError } from '@agent-device/kernel/errors';

export function readOptionalInteger(
  record: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be an integer.`);
  }
  const numberValue = value as number;
  if (options.min !== undefined && numberValue < options.min) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be at least ${options.min}.`);
  }
  if (options.max !== undefined && numberValue > options.max) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be at most ${options.max}.`);
  }
  return numberValue;
}

export function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a finite number.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be at least ${options.min}.`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be at most ${options.max}.`);
  }
  return value;
}

/**
 * The typed reason the Android adb-shell text channel reports when it cannot carry the
 * requested text. Recovery routing keys on this constant, never on the message: the message
 * states the channel limit; the reason names which recovery surfaces apply. It lives here
 * because every producer and consumer of the reason already evaluates this module.
 */
export const ANDROID_SHELL_TEXT_UNSUPPORTED_REASON = 'android_shell_text_unsupported' as const;

/**
 * Typed reasons for the Android test-IME broadcast channel's truthful-outcome failures (#4520).
 * The channel's acknowledgement proves attempted dispatch only; these reasons distinguish "no
 * acknowledgement evidence at all" (result=0 / unparseable — a pre-ack helper or no receiver, which
 * are indistinguishable and therefore both refused) from a receiver-reported rejection. Result data
 * carries codes and lengths only, never user text.
 */
export const ANDROID_IME_HELPER_NO_ACK_REASON = 'android_ime_helper_no_ack' as const;
export const ANDROID_IME_HELPER_DISPATCH_REJECTED_REASON =
  'android_ime_helper_dispatch_rejected' as const;

/** Resolves a batch step command with the same whitespace and case rules on both peers. */
export function normalizeBatchCommandName(command: unknown): string {
  return typeof command === 'string' ? command.trim().toLowerCase() : '';
}
