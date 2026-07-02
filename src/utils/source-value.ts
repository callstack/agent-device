import { AppError } from '../kernel/errors.ts';

export type SourceValueDefinition = {
  type: 'boolean' | 'int' | 'enum' | 'string' | 'booleanOrString';
  multiple?: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  setValue?: unknown;
};

const BOOLEAN_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const BOOLEAN_FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export function buildPrimaryEnvVarName(key: string): string {
  return `AGENT_DEVICE_${key
    .replace(/([A-Z])/g, '_$1')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase()}`;
}

export function parseSourceValue(
  definition: SourceValueDefinition,
  value: unknown,
  sourceLabel: string,
  rawKey: string,
): unknown {
  if (definition.multiple) {
    const rawValues = Array.isArray(value) ? value : [value];
    return rawValues.map((entry) =>
      parseSourceValue(
        {
          ...definition,
          multiple: false,
        },
        entry,
        sourceLabel,
        rawKey,
      ),
    );
  }

  if (definition.type === 'boolean') {
    return parseBooleanValue(value, sourceLabel, rawKey);
  }
  if (definition.type === 'booleanOrString') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && parseBooleanLiteral(value) !== undefined) {
      return parseBooleanLiteral(value);
    }
    if (typeof value === 'string' && value.trim().length > 0) return value;
    throw new AppError(
      'INVALID_ARGS',
      `Invalid value for "${rawKey}" in ${sourceLabel}. Expected boolean or non-empty string.`,
    );
  }
  if (definition.type === 'string') {
    if (typeof value === 'string' && value.trim().length > 0) return value;
    throw new AppError(
      'INVALID_ARGS',
      `Invalid value for "${rawKey}" in ${sourceLabel}. Expected non-empty string.`,
    );
  }
  if (definition.type === 'enum') {
    if (definition.setValue !== undefined) {
      return parseEnumSetValue(definition, value, sourceLabel, rawKey);
    }
    if (typeof value !== 'string' || !definition.enumValues?.includes(value)) {
      throw new AppError(
        'INVALID_ARGS',
        `Invalid value for "${rawKey}" in ${sourceLabel}. Expected one of: ${definition.enumValues?.join(', ')}.`,
      );
    }
    return value;
  }
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid value for "${rawKey}" in ${sourceLabel}. Expected integer.`,
    );
  }
  if (typeof definition.min === 'number' && parsed < definition.min) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid value for "${rawKey}" in ${sourceLabel}. Must be >= ${definition.min}.`,
    );
  }
  if (typeof definition.max === 'number' && parsed > definition.max) {
    throw new AppError(
      'INVALID_ARGS',
      `Invalid value for "${rawKey}" in ${sourceLabel}. Must be <= ${definition.max}.`,
    );
  }
  return parsed;
}

function parseBooleanValue(value: unknown, sourceLabel: string, rawKey: string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const parsed = parseBooleanLiteral(value);
    if (parsed !== undefined) return parsed;
  }
  throw new AppError(
    'INVALID_ARGS',
    `Invalid value for "${rawKey}" in ${sourceLabel}. Expected boolean.`,
  );
}

export function parseBooleanLiteral(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (BOOLEAN_TRUE_VALUES.has(normalized)) return true;
  if (BOOLEAN_FALSE_VALUES.has(normalized)) return false;
  return undefined;
}

function parseEnumSetValue(
  definition: SourceValueDefinition,
  value: unknown,
  sourceLabel: string,
  rawKey: string,
): unknown {
  const expectedValue = definition.setValue;
  if (value === expectedValue) return expectedValue;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized === '' || normalized === 'true' || normalized === '1') return expectedValue;
    if (normalized === 'false' || normalized === '0') return undefined;
  }
  if (value === true) return expectedValue;
  if (value === false) return undefined;
  throw new AppError(
    'INVALID_ARGS',
    `Invalid value for "${rawKey}" in ${sourceLabel}. Expected boolean-like value for enum flag.`,
  );
}
