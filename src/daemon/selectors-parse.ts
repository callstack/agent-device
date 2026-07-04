import { splitSelectorFromArgs } from '../utils/selectors-parse.ts';
import { normalizeIsPositionals } from '../utils/selector-is-predicates.ts';

export * from '../utils/selectors-parse.ts';

export function splitIsSelectorArgs(positionals: string[]): {
  predicate: string;
  split: { selectorExpression: string; rest: string[] } | null;
} {
  const normalized = normalizeIsPositionals(positionals);
  const predicate = normalized[0] ?? '';
  const split = splitSelectorFromArgs(normalized.slice(1), {
    preferTrailingValue: predicate === 'text',
  });
  return { predicate, split };
}
