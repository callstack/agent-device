import { checkIsPredicate, normalizeIsPositionals, type IsPredicate } from './predicates.ts';
import { splitSelectorFromArgs } from './parse.ts';
import { refuse, type SelectorArgumentRefusal } from './argument-refusal.ts';

export * from './parse.ts';

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

/** Shared by `checkIsArgs` and the CLI grammar's own splitter guard. */
export const SELECTOR_EXPRESSION_REQUIRED_MESSAGE = 'is requires a selector expression';

/** Shared by `checkIsArgs` and `isCommand`, which validates its already-parsed options. */
export const IS_TEXT_VALUE_REQUIRED_MESSAGE = 'is text requires expected text value';

export type CheckedIsArgs = {
  ok: true;
  predicate: IsPredicate;
  selectorExpression: string;
  /** Present only for `is text`; the other predicates reject trailing values. */
  expectedText: string;
};

/**
 * `is`'s complete argument contract: predicate admission, a selector that survives the
 * split, `is text`'s required expected value, and the trailing-value refusal the other
 * predicates share. All four ran in the daemon; the command surface ran the first three,
 * one of them against a hand-inlined predicate list and one without the usage hint.
 */
export function checkIsArgs(
  positionals: readonly string[],
): CheckedIsArgs | SelectorArgumentRefusal {
  const { predicate: rawPredicate, split } = splitIsSelectorArgs([...positionals]);
  const admitted = checkIsPredicate(rawPredicate);
  if (!admitted.ok) return admitted;
  if (!split) return refuse(SELECTOR_EXPRESSION_REQUIRED_MESSAGE);
  const expectedText = split.rest.join(' ').trim();
  if (admitted.predicate === 'text' && !expectedText) {
    return refuse(IS_TEXT_VALUE_REQUIRED_MESSAGE);
  }
  if (admitted.predicate !== 'text' && split.rest.length > 0) {
    return refuse(`is ${admitted.predicate} does not accept trailing values`);
  }
  return {
    ok: true,
    predicate: admitted.predicate,
    selectorExpression: split.selectorExpression,
    expectedText,
  };
}

/** `get`'s output format. Only `text` and `attrs` exist; both surfaces said so separately. */
export function checkGetFormat(
  value: string | undefined,
): { ok: true; format: 'text' | 'attrs' } | SelectorArgumentRefusal {
  if (value === 'text' || value === 'attrs') return { ok: true, format: value };
  return refuse('get only supports text or attrs');
}

/** A `get`/`is` element target: an `@ref`, or a non-empty selector expression. */
export function checkElementTargetArgs(
  positionals: readonly string[],
):
  | { ok: true; ref: string; label?: string }
  | { ok: true; selector: string }
  | SelectorArgumentRefusal {
  const first = positionals[0];
  if (first?.startsWith('@')) {
    const label = positionals.slice(1).join(' ').trim();
    return { ok: true, ref: first, ...(label ? { label } : {}) };
  }
  const selector = positionals.join(' ').trim();
  if (!selector) return refuse('get requires @ref or selector expression');
  return { ok: true, selector };
}

/** `wait <text>`: the text form needs text. The stable form has its own arguments. */
export function checkWaitText(
  text: string | undefined,
): { ok: true; text: string } | SelectorArgumentRefusal {
  if (!text) return refuse('wait requires text');
  return { ok: true, text };
}
