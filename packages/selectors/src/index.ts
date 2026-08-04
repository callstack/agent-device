import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import type {
  SelectorChainMatch,
  SelectorChainMatchList,
  SelectorDiagnostics,
  SelectorResolution,
} from './internal/public-resolution-types.ts';
import {
  checkElementTargetArgs,
  checkGetFormat,
  checkIsArgs,
  checkWaitText,
  IS_TEXT_VALUE_REQUIRED_MESSAGE,
  SELECTOR_EXPRESSION_REQUIRED_MESSAGE,
  splitIsSelectorArgs,
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
  IS_PREDICATE_REQUIRED_MESSAGE,
  IS_PREDICATE_USAGE_HINT,
  normalizeIsPositionals,
} from './internal/predicates.ts';
import {
  findSelectorChainMatch as findSelectorChainMatchAst,
  formatSelectorFailure as formatSelectorFailureAst,
  listSelectorChainMatches as listSelectorChainMatchesAst,
  resolveSelectorChain as resolveSelectorChainAst,
  selectorFailureHint,
  STALE_REF_HINT,
} from './internal/resolve.ts';
import { isNodeEditable, isNodeVisible } from './internal/node.ts';
import {
  findBestMatchesByLocator,
  checkFindArgs,
  isReadOnlyFindAction,
  parseFindArgs,
  parseFindSelectorExpression,
  FIND_LOCATORS,
  FIND_VALUE_REQUIRED_MESSAGE,
  normalizeText,
} from './internal/find.ts';
import {
  buildSelectorCandidates,
  readReplaySelectorDisplayValue,
  readSelectorExpression,
  resolveRecordedTarget,
  resolveReplaySuggestionCandidate,
} from './internal/replay.ts';

export type { SelectorArgumentRefusal } from './internal/argument-refusal.ts';
export type {
  FindAction,
  FindArgumentCheck,
  FindLocator,
  FindMatchOptions,
  ReadOnlyFindAction,
  ParsedFindArgs,
} from './internal/find.ts';
export type { IsPredicate } from './internal/predicates.ts';
export type {
  SelectorChainMatchList,
  SelectorChainMatch,
  SelectorDiagnostics,
  SelectorDisambiguationDisclosure,
  SelectorResolution,
} from './internal/public-resolution-types.ts';
export type {
  ReplayRecordedTargetDisambiguation,
  ReplayRecordedTargetPolicy,
  ReplayRecordedTargetResolution,
  ReplayRecordedTargetResolved,
  ReplayRecordedTargetUnresolved,
  ReplaySelectorCandidateAction,
  ReplaySelectorCandidateOptions,
  ReplaySelectorExpressionOutcome,
  ReplaySelectorGrammar,
  ReplaySuggestionCandidateMatch,
} from './internal/replay.ts';

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
  formatSelectorFailure,
  isNodeEditable,
  isNodeVisible,
  isReadOnlyFindAction,
  isRoleHintWord,
  isSelectorToken,
  isValidSelectorExpression,
  listSelectorChainMatches,
  normalizeIsPositionals,
  normalizeSelectorText,
  normalizeText,
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
  selectorUsesKey,
  splitIsSelectorArgs,
  splitSelectorFromArgs,
  validateSelectorExpression,
};

export {
  FIND_LOCATORS,
  FIND_VALUE_REQUIRED_MESSAGE,
  IS_PREDICATE_REQUIRED_MESSAGE,
  IS_PREDICATE_USAGE_HINT,
  IS_TEXT_VALUE_REQUIRED_MESSAGE,
  SELECTOR_EXPRESSION_REQUIRED_MESSAGE,
  SELECTOR_KEY_NAMES,
  STALE_REF_HINT,
};

export type { Platform, PublicPlatform, SnapshotNode, SnapshotState };

/** A single native runner selector suitable for direct iOS lookup. */
export type SimpleSelectorTarget = Readonly<{
  key: 'id' | 'label' | 'text' | 'value';
  value: string;
  raw: string;
}>;

export type SelectorProjection = string | Readonly<Record<string, string | boolean>> | null;

/**
 * Project a selector expression into a consumer-owned target map without exposing selector AST
 * nodes. The caller supplies the target vocabulary (for example, Maestro's text and state keys).
 */
function projectSelectorExpression(
  expression: string,
  options: { textKeys: readonly string[]; booleanKeys: readonly string[] },
): SelectorProjection {
  const parsed = tryParseSelectorChain(expression);
  if (!parsed) return expression.includes('=') || expression.includes('||') ? null : expression;
  const textKeys = new Set(options.textKeys);
  const booleanKeys = new Set(options.booleanKeys);
  if (parsed.selectors.length > 1) {
    const values = parsed.selectors.map((selector) => {
      const term = selector.terms.length === 1 ? selector.terms[0] : undefined;
      return term && textKeys.has(term.key) && typeof term.value === 'string'
        ? term.value
        : undefined;
    });
    const first = values[0];
    return first !== undefined && values.every((value) => value === first) ? first : null;
  }
  const selector = parsed.selectors[0];
  if (!selector) return null;
  const result: Record<string, string | boolean> = {};
  for (const term of selector.terms) {
    if (textKeys.has(term.key)) {
      if (typeof term.value !== 'string' || Object.keys(result).some((key) => textKeys.has(key))) {
        return null;
      }
      result[term.key] = term.value;
      continue;
    }
    if (booleanKeys.has(term.key)) {
      if (typeof term.value !== 'boolean') return null;
      result[term.key] = term.value;
      continue;
    }
    return null;
  }
  return Object.keys(result).length > 0 ? result : null;
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

/** Whether a valid selector contains a term with the requested key. */
function selectorUsesKey(expression: string, key: string): boolean {
  const parsed = tryParseSelectorChain(expression);
  return (
    parsed?.selectors.some((selector) => selector.terms.some((term) => term.key === key)) ?? false
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
  options: { platform: Platform | PublicPlatform; requireRect?: boolean },
): SelectorChainMatch | null {
  const chain = parsePrivateSelector(expression);
  const result = findSelectorChainMatchAst(nodes, chain, options);
  return result ? { ...result, selector: result.selector.raw } : null;
}

/** Public façade wrapper that accepts/returns selector text, never an AST. */
function listSelectorChainMatches(
  nodes: SnapshotState['nodes'],
  expression: string,
  options: { platform: Platform | PublicPlatform; requireRect?: boolean },
): SelectorChainMatchList | null {
  const chain = parsePrivateSelector(expression);
  const result = listSelectorChainMatchesAst(nodes, chain, options);
  return result ? { ...result, selector: result.selector.raw } : null;
}

/** Public façade wrapper that accepts/returns selector text, never an AST. */
function resolveSelectorChain(
  nodes: SnapshotState['nodes'],
  expression: string,
  options: {
    platform: Platform | PublicPlatform;
    requireRect?: boolean;
    requireUnique?: boolean;
    disambiguateAmbiguous?: boolean;
  },
): SelectorResolution | null {
  const chain = parsePrivateSelector(expression);
  const result = resolveSelectorChainAst(nodes, chain, options);
  return result ? { ...result, selector: result.selector.raw } : null;
}

function formatSelectorFailure(
  expression: string,
  diagnostics: SelectorDiagnostics[],
  options: { unique?: boolean },
): string {
  return formatSelectorFailureAst(expression, diagnostics, options);
}

function parsePrivateSelector(expression: string) {
  return parseSelectorChain(expression);
}
