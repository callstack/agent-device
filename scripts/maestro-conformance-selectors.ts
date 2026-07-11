import type { NormalizedSelector } from './maestro-conformance-types.ts';
import { readOptionalString, readRequiredRecord } from './maestro-conformance-values.ts';

export function normalizeUpstreamSelector(selector: Record<string, unknown>): NormalizedSelector {
  const result: NormalizedSelector = {};
  const text = readOptionalString(selector, 'textRegex') ?? readOptionalString(selector, 'text');
  const id = readOptionalString(selector, 'idRegex') ?? readOptionalString(selector, 'id');
  if (text !== undefined) result.text = text;
  if (id !== undefined) result.id = id;
  if (selector.index !== undefined) result.index = numberValue(selector.index, 'selector index');
  if (selector.childOf !== undefined) {
    result.childOf = normalizeUpstreamSelector(
      readRequiredRecord(selector.childOf, 'selector.childOf'),
    );
  }
  readSelectorState(selector, result, 'enabled');
  readSelectorState(selector, result, 'selected');
  if (Object.keys(result).length === 0) throw new Error('Selector artifact is empty.');
  return result;
}

function readSelectorState(
  record: Record<string, unknown>,
  result: NormalizedSelector,
  key: 'enabled' | 'selected',
): void {
  const value = record[key];
  if (value === undefined) return;
  if (typeof value !== 'boolean') throw new Error(`Selector ${key} must be boolean.`);
  result[key] = value;
}

function numberValue(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new Error(`${name} must be a non-negative integer.`);
  return number;
}
