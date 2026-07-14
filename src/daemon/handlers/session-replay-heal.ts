import { splitIsSelectorArgs, splitSelectorFromArgs } from '../../selectors/index.ts';
import { uniqueStrings } from '../../kernel/collections.ts';
import type { ReplayReportAction } from './session-replay-report-action.ts';
import { isTouchTargetCommand } from '../../replay/script-utils.ts';

/**
 * ADR 0012 decision 1 / migration step 6: `--update` retired as an actor —
 * this module used to also drive `healReplayAction`'s retry-and-rewrite arm
 * (recorded-selector re-resolution feeding a silent `.ad` rewrite). That arm
 * is gone; the recorded-selector-candidate extraction below is the one piece
 * of the old heal machinery that survives, now read-only, powering the
 * ranked `suggestions` list in every divergence report
 * (`session-replay-divergence.ts`'s `collectReplayDivergenceSuggestions`).
 */

function parseSelectorWaitPositionals(positionals: string[]): {
  selectorExpression: string | null;
  selectorTimeout: string | null;
} {
  if (positionals.length === 0) return { selectorExpression: null, selectorTimeout: null };
  const maybeTimeout = positionals[positionals.length - 1];
  const selectorTimeout =
    maybeTimeout !== undefined && /^\d+$/.test(maybeTimeout) ? maybeTimeout : null;
  const hasTimeout = selectorTimeout !== null;
  const selectorTokens = hasTimeout ? positionals.slice(0, -1) : positionals.slice();
  const split = splitSelectorFromArgs(selectorTokens);
  if (!split || split.rest.length > 0) {
    return { selectorExpression: null, selectorTimeout: null };
  }
  return {
    selectorExpression: split.selectorExpression,
    selectorTimeout,
  };
}

// fallow-ignore-next-line complexity
export function collectReplaySelectorCandidates(action: ReplayReportAction): string[] {
  const result: string[] = [];
  const explicitChain =
    Array.isArray(action.result?.selectorChain) &&
    action.result?.selectorChain.every((entry) => typeof entry === 'string')
      ? (action.result.selectorChain as string[])
      : [];
  result.push(...explicitChain);

  if (isTouchTargetCommand(action.command)) {
    const positionals = readTargetSelectorPositionals(action);
    const first = positionals[0] ?? '';
    if (first && !first.startsWith('@')) {
      result.push(positionals.join(' '));
    }
  }
  if (action.command === 'fill') {
    const first = action.positionals?.[0] ?? '';
    if (first && !first.startsWith('@') && Number.isNaN(Number(first))) {
      result.push(first);
    }
  }
  if (action.command === 'get') {
    const selector = action.positionals?.[1] ?? '';
    if (selector && !selector.startsWith('@')) {
      result.push(action.positionals.slice(1).join(' '));
    }
  }
  if (action.command === 'is') {
    const { split } = splitIsSelectorArgs([...action.positionals]);
    if (split) {
      result.push(split.selectorExpression);
    }
  }
  if (action.command === 'wait') {
    const { selectorExpression } = parseSelectorWaitPositionals([...action.positionals]);
    if (selectorExpression) {
      result.push(selectorExpression);
    }
  }

  return uniqueStrings(result).filter((entry) => entry.trim().length > 0);
}

function readTargetSelectorPositionals(action: ReplayReportAction): readonly string[] {
  const positionals = action.positionals;
  if (action.command !== 'longpress') return positionals;
  const last = positionals.at(-1);
  return positionals.length > 1 && isFiniteNumberString(last)
    ? positionals.slice(0, -1)
    : positionals;
}

function isFiniteNumberString(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  return Number.isFinite(Number(value));
}
