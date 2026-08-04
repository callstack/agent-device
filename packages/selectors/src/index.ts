import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { Selector } from './internal/parse.ts';
import type {
  SelectorChainMatch,
  SelectorChainMatchList,
  SelectorMatchOptions,
  SelectorResolution,
  SelectorResolutionOptions,
} from './internal/public-resolution-types.ts';
import {
  checkElementTargetArgs,
  checkGetFormat,
  checkIsArgs,
  checkWaitText,
  IS_TEXT_VALUE_REQUIRED_MESSAGE,
  SELECTOR_EXPRESSION_REQUIRED_MESSAGE,
} from './internal/arguments.ts';
import { buildSelectorChainForNode, normalizeSelectorText } from './internal/build.ts';
import {
  detectUnknownSelectorKeyToken,
  isRoleHintWord,
  isSelectorToken,
  SELECTOR_KEY_NAMES,
  splitSelectorFromArgs,
  parseSelectorChain,
  tryParseSelectorChain,
} from './internal/parse.ts';
import {
  checkIsPredicate,
  evaluateIsPredicate,
  IS_PREDICATE_USAGE_HINT,
  normalizeIsPositionals,
} from './internal/predicates.ts';
import {
  findSelectorChainMatch as findSelectorChainMatchAst,
  listSelectorChainMatches as listSelectorChainMatchesAst,
  resolveSelectorChain as resolveSelectorChainAst,
  selectorFailureHint,
  STALE_REF_HINT,
} from './internal/resolve.ts';
import {
  findBestMatchesByLocator,
  checkFindArgs,
  isReadOnlyFindAction,
  parseFindArgs,
  parseFindSelectorExpression,
  FIND_LOCATORS,
  FIND_VALUE_REQUIRED_MESSAGE,
  UNSUPPORTED_FIND_ACTION_HINT,
} from './internal/find.ts';
import {
  buildSelectorCandidates,
  readReplaySelectorDisplayValue,
  readSelectorExpression,
  resolveRecordedTarget,
  resolveReplaySuggestionCandidate,
} from './internal/replay.ts';

export type { FindAction, FindLocator } from './internal/find.ts';
export type { IsPredicate } from './internal/predicates.ts';
export type {
  SelectorChainMatchList,
  SelectorChainMatch,
  SelectorResolution,
} from './internal/public-resolution-types.ts';
export { formatSelectorFailure } from './internal/resolve.ts';

export {
  buildSelectorCandidates,
  buildSelectorChainForNode,
  checkElementTargetArgs,
  checkFindArgs,
  checkGetFormat,
  checkIsArgs,
  checkIsPredicate,
  checkWaitText,
  detectUnknownSelectorKeyToken,
  evaluateIsPredicate,
  findBestMatchesByLocator,
  findSelectorChainMatch,
  isReadOnlyFindAction,
  isRoleHintWord,
  isSelectorToken,
  isValidSelectorExpression,
  listSelectorChainMatches,
  normalizeIsPositionals,
  normalizeSelectorText,
  parseFindArgs,
  parseFindSelectorExpression,
  projectSelectorExpression,
  readSimpleSelectorTarget,
  readSelectorAlternatives,
  readReplaySelectorDisplayValue,
  readSelectorExpression,
  resolveRecordedTarget,
  resolveReplaySuggestionCandidate,
  resolveSelectorChain,
  selectorFailureHint,
  selectorContainsValue,
  splitSelectorFromArgs,
  validateSelectorExpression,
};

export {
  FIND_LOCATORS,
  FIND_VALUE_REQUIRED_MESSAGE,
  IS_PREDICATE_USAGE_HINT,
  IS_TEXT_VALUE_REQUIRED_MESSAGE,
  SELECTOR_EXPRESSION_REQUIRED_MESSAGE,
  SELECTOR_KEY_NAMES,
  STALE_REF_HINT,
  UNSUPPORTED_FIND_ACTION_HINT,
};

/** A single native runner selector suitable for direct iOS lookup. */
export type SimpleSelectorTarget = Readonly<{
  key: 'id' | 'label' | 'text' | 'value';
  value: string;
  raw: string;
}>;

export type SelectorProjection = string | Readonly<Record<string, string | boolean>> | null;

/**
 * Project a selector expression into a consumer-owned target map without exposing selector AST
 * nodes. `vocabulary` is the caller's own — Maestro passes `MAESTRO_SELECTOR_PROJECTION`, because
 * which keys a Maestro flow understands is that package's knowledge, not this one's.
 */
function projectSelectorExpression(
  expression: string,
  vocabulary: { textKeys: readonly string[]; booleanKeys: readonly string[] },
): SelectorProjection {
  const parsed = tryParseSelectorChain(expression);
  // Not selector-shaped at all: pass plain text through, refuse anything that
  // tried to be a selector and failed.
  if (!parsed) return expression.includes('=') || expression.includes('||') ? null : expression;
  const textKeys = new Set(vocabulary.textKeys);
  return parsed.selectors.length > 1
    ? readAgreedTextValue(parsed.selectors, textKeys)
    : projectSelectorTerms(parsed.selectors[0], textKeys, new Set(vocabulary.booleanKeys));
}

/**
 * Alternatives collapse only when every branch is a single text term naming the
 * same value — the one case where a target vocabulary with no `||` can still
 * express the selector faithfully.
 */
function readAgreedTextValue(
  selectors: readonly Selector[],
  textKeys: ReadonlySet<string>,
): SelectorProjection {
  const values = selectors.map((selector) => {
    const term = selector.terms.length === 1 ? selector.terms[0] : undefined;
    return term && textKeys.has(term.key) && typeof term.value === 'string'
      ? term.value
      : undefined;
  });
  const first = values[0];
  return first !== undefined && values.every((value) => value === first) ? first : null;
}

/** Every term must map into the vocabulary, and at most one may be a text key. */
function projectSelectorTerms(
  selector: Selector | undefined,
  textKeys: ReadonlySet<string>,
  booleanKeys: ReadonlySet<string>,
): SelectorProjection {
  if (!selector) return null;
  const result: Record<string, string | boolean> = {};
  let textTerms = 0;
  for (const term of selector.terms) {
    if (termMatches(term, textKeys, 'string')) textTerms += 1;
    else if (!termMatches(term, booleanKeys, 'boolean')) return null;
    result[term.key] = term.value;
  }
  return textTerms <= 1 && Object.keys(result).length > 0 ? result : null;
}

function termMatches(
  term: Selector['terms'][number],
  keys: ReadonlySet<string>,
  expected: 'string' | 'boolean',
): boolean {
  return keys.has(term.key) && typeof term.value === expected;
}

/** Read a one-term selector without exposing the parser's AST. */
function readSimpleSelectorTarget(expression: string): SimpleSelectorTarget | null {
  const parsed = tryParseSelectorChain(expression);
  if (!parsed || parsed.selectors.length !== 1) return null;
  const selector = parsed.selectors[0];
  if (!selector || selector.terms.length !== 1) return null;
  const term = selector.terms[0];
  if (!term || typeof term.value !== 'string') return null;
  if (term.key !== 'id' && term.key !== 'label' && term.key !== 'text' && term.key !== 'value') {
    return null;
  }
  return { key: term.key, value: term.value, raw: selector.raw };
}

/** Whether any text-bearing selector term semantically contains `literal`. */
function selectorContainsValue(expression: string, literal: string): boolean {
  if (!literal) return false;
  const parsed = tryParseSelectorChain(expression);
  if (!parsed) return false;
  return parsed.selectors.some((selector) =>
    selector.terms.some(
      (term) =>
        (term.key === 'text' || term.key === 'label' || term.key === 'value') &&
        typeof term.value === 'string' &&
        term.value.includes(literal),
    ),
  );
}

/** Return the canonical alternative strings without exposing selector nodes or terms. */
function readSelectorAlternatives(expression: string): string[] {
  return parseSelectorChain(expression).selectors.map((selector) => selector.raw);
}

/** Validate an expression without returning the private parser representation. */
function isValidSelectorExpression(expression: string): boolean {
  return tryParseSelectorChain(expression) !== null;
}

/** Throw the same INVALID_ARGS parser failure while keeping the AST private. */
function validateSelectorExpression(expression: string): void {
  parseSelectorChain(expression);
}

/** Public façade wrapper that accepts/returns selector text, never an AST. */
function findSelectorChainMatch(
  nodes: SnapshotState['nodes'],
  expression: string,
  options: SelectorMatchOptions,
): SelectorChainMatch | null {
  const result = findSelectorChainMatchAst(nodes, parseSelectorChain(expression), options);
  return result ? { ...result, selector: result.selector.raw } : null;
}

/** Public façade wrapper that accepts/returns selector text, never an AST. */
function listSelectorChainMatches(
  nodes: SnapshotState['nodes'],
  expression: string,
  options: SelectorMatchOptions,
): SelectorChainMatchList | null {
  const result = listSelectorChainMatchesAst(nodes, parseSelectorChain(expression), options);
  return result ? { ...result, selector: result.selector.raw } : null;
}

/** Public façade wrapper that accepts/returns selector text, never an AST. */
function resolveSelectorChain(
  nodes: SnapshotState['nodes'],
  expression: string,
  options: SelectorResolutionOptions,
): SelectorResolution | null {
  const result = resolveSelectorChainAst(nodes, parseSelectorChain(expression), options);
  return result ? { ...result, selector: result.selector.raw } : null;
}
