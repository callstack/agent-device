import { isMap, isNode, isScalar, isSeq, LineCounter, type Node } from 'yaml';
import { AppError } from '../../kernel/errors.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import type { MaestroOptionalCommand, MaestroScalar, MaestroSourceLocation } from './program-ir.ts';

export type MaestroProgramParseContext = {
  lineCounter: LineCounter;
  sourcePath?: string;
};

export type MaestroMapEntry = {
  key: string;
  keyNode: Node;
  value: Node | null;
};

export function sourceAt(
  node: Node | null | undefined,
  context: MaestroProgramParseContext,
): MaestroSourceLocation {
  return sourceAtOffset(node?.range?.[0], context);
}

export function sourceAtOffset(
  offset: number | undefined,
  context: MaestroProgramParseContext,
): MaestroSourceLocation {
  const line = context.lineCounter.linePos(offset !== undefined && offset >= 0 ? offset : 0).line;
  return context.sourcePath === undefined ? { line } : { path: context.sourcePath, line };
}

export function formatSourceLocation(source: MaestroSourceLocation): string {
  return `${source.path === undefined ? '' : `${source.path}:`}line ${source.line}`;
}

export function invalidAt(
  message: string,
  node: Node | null | undefined,
  context: MaestroProgramParseContext,
): never {
  throw new AppError(
    'INVALID_ARGS',
    `${message} (${formatSourceLocation(sourceAt(node, context))})`,
  );
}

export function readMapEntries(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): MaestroMapEntry[] {
  if (!isMap(node)) invalidAt(`Maestro ${name} expects a map.`, node, context);
  const entries: MaestroMapEntry[] = [];
  for (const pair of node.items) {
    const keyNode = pair.key;
    if (!isScalar(keyNode)) {
      invalidAt(`Maestro ${name} map keys must be strings.`, undefined, context);
    }
    const keyValue = keyNode.value;
    if (
      typeof keyValue !== 'string' &&
      typeof keyValue !== 'number' &&
      typeof keyValue !== 'boolean'
    ) {
      invalidAt(`Maestro ${name} map keys must be strings.`, keyNode, context);
    }
    if (pair.value !== null && !isNode(pair.value)) {
      invalidAt(`Maestro ${name} values must be YAML nodes.`, keyNode, context);
    }
    entries.push({
      key: String(keyValue),
      keyNode,
      value: pair.value as Node | null,
    });
  }
  return entries;
}

export function readSequenceItems(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): Node[] {
  if (!isSeq(node)) invalidAt(`Maestro ${name} expects a list.`, node, context);
  return node.items as Node[];
}

export function readStringSequence(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): string[] {
  return readSequenceItems(node, name, context).map((item, index) =>
    readRequiredString(item, `${name}[${index}]`, context),
  );
}

export function assertOnlyKeys(
  entries: readonly MaestroMapEntry[],
  name: string,
  supportedKeys: readonly string[],
  context: MaestroProgramParseContext,
): void {
  const supported = new Set(supportedKeys);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      invalidAt(`Maestro ${name} contains duplicate field "${entry.key}".`, entry.keyNode, context);
    }
    seen.add(entry.key);
    if (!supported.has(entry.key)) {
      invalidAt(`Maestro ${name} field "${entry.key}" is not supported.`, entry.keyNode, context);
    }
  }
}

export function hasEntry(entries: readonly MaestroMapEntry[], key: string): boolean {
  return entries.some((entry) => entry.key === key);
}

export function entryValue(
  entries: readonly MaestroMapEntry[],
  key: string,
): Node | null | undefined {
  return entries.find((entry) => entry.key === key)?.value;
}

export function readOptionalEntry<T>(
  entries: readonly MaestroMapEntry[],
  key: string,
  read: (value: Node | null | undefined) => T,
): T | undefined {
  return hasEntry(entries, key) ? read(entryValue(entries, key)) : undefined;
}

export function readOptionalCommandOption(
  entries: readonly MaestroMapEntry[],
  name: string,
  context: MaestroProgramParseContext,
): MaestroOptionalCommand {
  const optional = readOptionalEntry(entries, 'optional', (entry) =>
    readOptionalBoolean(entry, `${name}.optional`, context),
  );
  return stripUndefined({ optional });
}

export function isNullNode(node: Node | null | undefined): boolean {
  return node === null || (isScalar(node) && node.value === null);
}

export function readScalarValue(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): MaestroScalar | null {
  if (node === null || node === undefined) return null;
  if (!isScalar(node)) invalidAt(`Maestro ${name} expects a scalar value.`, node, context);
  const value = node.value;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  invalidAt(`Maestro ${name} contains an unsupported scalar value.`, node, context);
}

export function readRequiredString(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): string {
  const value = readScalarValue(node, name, context);
  if (typeof value !== 'string') invalidAt(`Maestro ${name} expects a string.`, node, context);
  return value;
}

export function readOptionalString(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): string | undefined {
  const value = readScalarValue(node, name, context);
  if (value === null) return undefined;
  if (typeof value !== 'string') invalidAt(`Maestro ${name} expects a string.`, node, context);
  return value;
}

export function readOptionalBoolean(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): boolean | undefined {
  const value = readScalarValue(node, name, context);
  if (value === null) return undefined;
  if (typeof value !== 'boolean') invalidAt(`Maestro ${name} expects a boolean.`, node, context);
  return value;
}

const VARIABLE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_.]*\}$/;
const NUMERIC_STRING_PATTERN = /^-?\d+(\.\d+)?$/;
const INTEGER_STRING_PATTERN = /^-?\d+$/;

export type NumericScalarConstraints = {
  integer?: boolean;
  nonNegative?: boolean;
  positive?: boolean;
};

export const MAESTRO_NUMERIC_FIELD_CONSTRAINTS: Record<string, NumericScalarConstraints> = {
  'tapOn.index': { integer: true, nonNegative: true },
  'tapOn.repeat': { integer: true, positive: true },
  'tapOn.delay': { integer: true, nonNegative: true },
  'doubleTapOn.delay': { integer: true, nonNegative: true },
  eraseText: { integer: true, positive: true },
  'eraseText.charactersToErase': { integer: true, positive: true },
  'extendedWaitUntil.timeout': { nonNegative: true },
  'scrollUntilVisible.timeout': { nonNegative: true },
  waitForAnimationToEnd: { nonNegative: true },
  'waitForAnimationToEnd.timeout': { nonNegative: true },
  'swipe.duration': { nonNegative: true },
  'repeat.times': { integer: true, nonNegative: true },
  'retry.maxRetries': { integer: true, nonNegative: true },
};

export function numericDescription(constraints: NumericScalarConstraints): string {
  if (constraints.positive && constraints.integer) return 'a positive integer';
  if (constraints.positive) return 'a positive number';
  if (constraints.nonNegative && constraints.integer) return 'a non-negative integer';
  if (constraints.nonNegative) return 'a non-negative finite number';
  if (constraints.integer) return 'an integer';
  return 'a finite number';
}

function validateNumericScalar(
  value: number,
  name: string,
  node: Node | null | undefined,
  context: MaestroProgramParseContext,
  constraints: NumericScalarConstraints,
): void {
  const message = `Maestro ${name} expects ${numericDescription(constraints)} or a variable expression.`;
  if (!Number.isFinite(value)) {
    invalidAt(message, node, context);
  }
  if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    invalidAt(message, node, context);
  }
  if (constraints.integer && !Number.isSafeInteger(value)) {
    invalidAt(message, node, context);
  }
  if (constraints.nonNegative && value < 0) {
    invalidAt(message, node, context);
  }
  if (constraints.positive && value <= 0) {
    invalidAt(message, node, context);
  }
}

function readNumericScalar(
  value: MaestroScalar,
  name: string,
  node: Node | null | undefined,
  context: MaestroProgramParseContext,
  constraints: NumericScalarConstraints,
): number | string {
  if (typeof value === 'number') {
    validateNumericScalar(value, name, node, context, constraints);
    return value;
  }
  if (typeof value === 'string') {
    if (VARIABLE_PATTERN.test(value)) return value;
    const pattern = constraints.integer ? INTEGER_STRING_PATTERN : NUMERIC_STRING_PATTERN;
    if (pattern.test(value)) {
      const num = Number(value);
      validateNumericScalar(num, name, node, context, constraints);
      return num;
    }
  }
  invalidAt(
    `Maestro ${name} expects ${numericDescription(constraints)} or a variable expression.`,
    node,
    context,
  );
}

export function readOptionalNumeric(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): number | string | undefined {
  const value = readScalarValue(node, name, context);
  if (value === null) return undefined;
  return readNumericScalar(
    value,
    name,
    node,
    context,
    MAESTRO_NUMERIC_FIELD_CONSTRAINTS[name] ?? {},
  );
}

export function readRequiredNumeric(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): number | string {
  const constraints = MAESTRO_NUMERIC_FIELD_CONSTRAINTS[name] ?? {};
  const value = readScalarValue(node, name, context);
  if (value === null) {
    invalidAt(
      `Maestro ${name} expects ${numericDescription(constraints)} or a variable expression.`,
      node,
      context,
    );
  }
  return readNumericScalar(value, name, node, context, constraints);
}

export function readScalarMap(
  node: Node | null | undefined,
  name: string,
  context: MaestroProgramParseContext,
): Record<string, string | number | boolean> {
  const entries = readMapEntries(node, name, context);
  const values: Record<string, string | number | boolean> = {};
  for (const entry of entries) {
    const value = readScalarValue(entry.value, `${name}.${entry.key}`, context);
    if (value === null) {
      invalidAt(
        `Maestro ${name}.${entry.key} expects a string, number, or boolean.`,
        entry.value,
        context,
      );
    }
    values[entry.key] = value;
  }
  return values;
}
