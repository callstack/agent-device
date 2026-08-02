import { AppError } from '@agent-device/kernel/errors';
import { REPLAY_VAR_KEY_RE } from '@agent-device/ad-script';

const RECORDED_INPUT_PLACEHOLDER_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

export function validateRecordedInputVariableName(raw: string): string {
  if (raw !== raw.trim() || !REPLAY_VAR_KEY_RE.test(raw)) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid --record-as variable "${raw}": use uppercase letters, digits, and underscores (for example PASSWORD).`,
    );
  }
  if (raw.startsWith('AD_')) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid --record-as variable "${raw}": the AD_* namespace is reserved for built-in replay variables.`,
    );
  }
  return raw;
}

export function recordedInputPlaceholder(variableName: string): string {
  return `\${${variableName}}`;
}

/** Exact placeholders produced by safe authoring; embedded interpolation stays ordinary script input. */
export function readRecordedInputVariableName(value: string): string | undefined {
  const match = RECORDED_INPUT_PLACEHOLDER_RE.exec(value);
  if (!match?.[1] || match[1].startsWith('AD_')) return undefined;
  return match[1];
}
