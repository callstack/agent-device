import type { NormalizedSelector } from './maestro-conformance-types.ts';

export function normalizeUpstreamSelector(selector: Record<string, unknown>): NormalizedSelector {
  const result: NormalizedSelector = {};
  const text = optionalString(selector, 'textRegex') ?? optionalString(selector, 'text');
  const id = optionalString(selector, 'idRegex') ?? optionalString(selector, 'id');
  if (text !== undefined) result.text = text;
  if (id !== undefined) result.id = id;
  if (selector.index !== undefined) result.index = numberValue(selector.index, 'selector index');
  if (selector.childOf !== undefined) {
    result.childOf = normalizeUpstreamSelector(
      requiredRecord(selector.childOf, 'selector.childOf'),
    );
  }
  readSelectorState(selector, result, 'enabled');
  readSelectorState(selector, result, 'selected');
  if (Object.keys(result).length === 0) throw new Error('Selector artifact is empty.');
  return result;
}

export function normalizeAgentSelector(
  value: string | undefined,
  optionsValue?: string,
): NormalizedSelector {
  if (!value) throw new Error('Agent-device selector action is missing its selector.');
  const textValues = new Set<string>();
  const idValues = new Set<string>();
  const states = new Map<'enabled' | 'selected', boolean>();

  for (const alternative of value.split(' || ')) {
    const terms = parseSelectorTerms(alternative);
    for (const [key, termValue] of terms) {
      if (key === 'label' || key === 'text') textValues.add(termValue);
      else if (key === 'id') idValues.add(termValue);
      else if (key === 'enabled' || key === 'selected') {
        if (termValue !== 'true' && termValue !== 'false') {
          throw new Error(`Invalid boolean selector term: ${key}=${termValue}`);
        }
        states.set(key, termValue === 'true');
      }
    }
  }

  const result: NormalizedSelector = {};
  if (textValues.size > 1 || idValues.size > 1) {
    throw new Error(`Selector alternatives disagree: ${value}`);
  }
  const text = [...textValues][0];
  const id = [...idValues][0];
  if (text !== undefined) result.text = text;
  if (id !== undefined && id !== text) result.id = id;
  for (const [key, state] of states) result[key] = state;
  if (optionsValue !== undefined) applyAgentSelectorOptions(result, optionsValue);
  if (Object.keys(result).length === 0)
    throw new Error(`Selector has no supported terms: ${value}`);
  return result;
}

function parseSelectorTerms(value: string): Array<[string, string]> {
  const terms: Array<[string, string]> = [];
  const pattern = /([A-Za-z][A-Za-z0-9]*)=("(?:\\.|[^"\\])*")/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (value.slice(cursor, index).trim().length > 0) {
      throw new Error(`Unsupported selector expression: ${value}`);
    }
    const key = match[1];
    const raw = match[2];
    if (!key || !raw) throw new Error(`Malformed selector expression: ${value}`);
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'string') throw new Error(`Selector term is not a string: ${value}`);
    terms.push([key, parsed]);
    cursor = index + match[0].length;
  }
  if (terms.length === 0 || value.slice(cursor).trim().length > 0) {
    throw new Error(`Unsupported selector expression: ${value}`);
  }
  return terms;
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

function applyAgentSelectorOptions(result: NormalizedSelector, value: string): void {
  const options = JSON.parse(value) as unknown;
  const record = requiredRecord(options, 'selector options');
  if (record.index !== undefined) result.index = numberValue(record.index, 'selector index');
  if (record.childOf !== undefined) {
    if (typeof record.childOf !== 'string') {
      throw new Error('selector.childOf must be a selector expression.');
    }
    result.childOf = normalizeAgentSelector(record.childOf);
  }
}

function numberValue(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw new Error(`${name} must be a non-negative integer.`);
  return number;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value;
}
