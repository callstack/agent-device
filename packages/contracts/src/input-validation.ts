import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

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
 * Why an Android text channel refused to carry the text it was handed. Recovery routing keys on the
 * reason, never on the message: the message states the channel limit, the reason names which
 * recovery surfaces apply. The table lives here because every producer of these failures and the
 * replay boundary that rewrites their hint already evaluate this module.
 */
export const ANDROID_TEXT_CHANNEL_REASONS = {
  // The adb-shell fallback carries ASCII text only; a helper or provider channel is needed.
  shellTextUnsupported: {
    reason: 'android_shell_text_unsupported',
    commands: ['fill', 'type'],
  },
  // The test IME helper gave no evidence it attempted the dispatch, so nothing is proven typed.
  imeHelperNoAck: { reason: 'android_ime_helper_no_ack', commands: ['fill', 'type'] },
  // The test IME helper answered that it rejected the dispatch, so nothing was typed.
  imeHelperDispatchRejected: {
    reason: 'android_ime_helper_dispatch_rejected',
    commands: ['fill', 'type'],
  },
} as const satisfies ReasonTable<'android text channel'>;

/** Resolves a batch step command with the same whitespace and case rules on both peers. */
export function normalizeBatchCommandName(command: unknown): string {
  return typeof command === 'string' ? command.trim().toLowerCase() : '';
}
