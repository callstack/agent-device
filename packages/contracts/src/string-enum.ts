import { AppError } from '@agent-device/kernel/errors';

export function defineStringEnum<const T extends readonly string[]>(
  values: T,
  options: {
    normalize?: (value: string) => string;
    message: (value: string) => string;
  } = { message: (value) => `Invalid value: ${value}` },
) {
  type Value = T[number];
  const allowed = new Set<string>(values);
  const normalize = options.normalize ?? ((value: string) => value);
  return {
    is: (value: unknown): value is Value => typeof value === 'string' && allowed.has(value),
    parse: (value: string | undefined): Value => {
      const normalized = normalize(value ?? '');
      if (allowed.has(normalized)) return normalized as Value;
      throw new AppError('INVALID_ARGS', options.message(value ?? ''));
    },
  };
}
