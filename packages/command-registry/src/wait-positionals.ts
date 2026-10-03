import { parseTimeout } from './parse-timeout.ts';
import {
  detectUnknownSelectorKeyToken,
  isRoleHintWord,
  isSelectorToken,
  isValidSelectorExpression,
  SELECTOR_KEY_NAMES,
  splitSelectorFromArgs,
} from '@agent-device/selectors';

export type WaitInvalidReason =
  | 'unknown-selector-key'
  | 'selector-shaped-text'
  | 'absent-selector-required';

export type WaitParsed =
  | { kind: 'sleep'; durationMs: number }
  | { kind: 'ref'; rawRef: string; timeoutMs: number | null }
  | { kind: 'selector'; selectorExpression: string; timeoutMs: number | null }
  | { kind: 'absent'; selectorExpression: string; timeoutMs: number | null }
  | { kind: 'text'; text: string; timeoutMs: number | null }
  | { kind: 'stable'; quietMs: number | null; timeoutMs: number | null }
  | { kind: 'invalid'; reason: WaitInvalidReason; message: string };

// Words that name a wait CONDITION rather than a selector key. A caller leading with one of these
// almost certainly wants the selector form — `visible`/`hidden` are already selector keys, so they
// never reach this list; they parse as valid boolean-key selector terms instead (#1800).
const CONDITION_WORDS = new Set(['exists', 'present', 'appears', 'gone', 'disappears']);

export function parseWaitPositionals(args: string[]): WaitParsed | null {
  const firstArg = args[0];
  if (firstArg === undefined) return null;
  const sleepMs = parseTimeout(firstArg);
  if (sleepMs !== null) return { kind: 'sleep', durationMs: sleepMs };
  const timeoutMs = parseTimeout(args.at(-1));
  if (firstArg === 'text') return parseTextKeyword(args, timeoutMs);
  if (firstArg === 'stable') return parseStableKeyword(args);
  if (firstArg === 'absent') return parseAbsentKeyword(args, timeoutMs);
  if (firstArg.startsWith('@')) return { kind: 'ref', rawRef: firstArg, timeoutMs };
  return parseSelectorOrText(args, timeoutMs);
}

function parseTextKeyword(args: string[], timeoutMs: number | null): WaitParsed {
  const text = timeoutMs !== null ? args.slice(1, -1).join(' ') : args.slice(1).join(' ');
  return { kind: 'text', text: text.trim(), timeoutMs };
}

function parseStableKeyword(args: string[]): WaitParsed {
  const rest = args.slice(1);
  const stableTimeoutMs = rest.length > 1 ? parseTimeout(rest[1]) : null;
  const quietMs = rest.length > 0 ? parseTimeout(rest[0]) : null;
  return { kind: 'stable', quietMs, timeoutMs: stableTimeoutMs };
}

function parseAbsentKeyword(args: string[], timeoutMs: number | null): WaitParsed {
  const selectorArgs = timeoutMs !== null ? args.slice(1, -1) : args.slice(1);
  const split = splitSelectorFromArgs(selectorArgs);
  if (
    selectorArgs.length > 0 &&
    split?.rest.length === 0 &&
    isValidSelectorExpression(split.selectorExpression)
  ) {
    return {
      kind: 'absent',
      selectorExpression: split.selectorExpression,
      timeoutMs,
    };
  }
  return {
    kind: 'invalid',
    reason: 'absent-selector-required',
    message: formatAbsentSelectorMessage(selectorArgs),
  };
}

function formatAbsentSelectorMessage(selectorArgs: string[]): string {
  const raw = selectorArgs.join(' ');
  return raw.length > 0
    ? `wait absent requires one valid selector; received "${raw}". Use wait absent '<selector>' [timeoutMs].`
    : 'wait absent requires <selector> [timeoutMs].';
}

/**
 * The fallback path once `wait` isn't a keyword form, a sleep, or a `@ref`: either a full selector
 * expression, or literal text. #1800: a token shaped like a selector (a recognized key, or an
 * unrecognized `key=value`) must never silently degrade to literal text just because the overall
 * positional list failed to parse as a full selector expression — that is exactly the shape that
 * reads as an absent element after a full timeout instead of the caller's own mistake.
 */
function parseSelectorOrText(args: string[], timeoutMs: number | null): WaitParsed {
  const argsWithoutTimeout = timeoutMs !== null ? args.slice(0, -1) : args.slice();
  const split = splitSelectorFromArgs(argsWithoutTimeout);
  if (split && split.rest.length === 0 && isValidSelectorExpression(split.selectorExpression)) {
    return { kind: 'selector', selectorExpression: split.selectorExpression, timeoutMs };
  }
  const rejection = detectSelectorShapedRejection(argsWithoutTimeout, split);
  if (rejection) return rejection;
  const text = timeoutMs !== null ? args.slice(0, -1).join(' ') : args.join(' ');
  return { kind: 'text', text: text.trim(), timeoutMs };
}

function detectSelectorShapedRejection(
  argsWithoutTimeout: string[],
  split: { selectorExpression: string; rest: string[] } | null,
): Extract<WaitParsed, { kind: 'invalid' }> | null {
  for (const token of argsWithoutTimeout) {
    const unknownKey = detectUnknownSelectorKeyToken(token);
    if (unknownKey) {
      return {
        kind: 'invalid',
        reason: 'unknown-selector-key',
        message: formatUnknownSelectorKeyMessage(unknownKey, argsWithoutTimeout),
      };
    }
  }
  if (split && split.rest.length > 0) {
    return {
      kind: 'invalid',
      reason: 'selector-shaped-text',
      message: formatTrailingArgsMessage(split, argsWithoutTimeout),
    };
  }
  if (argsWithoutTimeout.some((token) => isSelectorToken(token))) {
    return {
      kind: 'invalid',
      reason: 'selector-shaped-text',
      message: formatSelectorShapedMessage(argsWithoutTimeout),
    };
  }
  return null;
}

function formatUnknownSelectorKeyMessage(
  unknownKey: { key: string; value: string },
  argsWithoutTimeout: string[],
): string {
  const raw = argsWithoutTimeout.join(' ');
  const hintValue = isRoleHintWord(unknownKey.key)
    ? `role=${unknownKey.key} label="${unknownKey.value}"`
    : `label="${unknownKey.value}"`;
  return (
    `Unknown selector key "${unknownKey.key}" in "${raw}". Supported: ${SELECTOR_KEY_NAMES.join(', ')}. ` +
    `Use wait '${hintValue}' [timeoutMs] to wait for the selector, or wait text '${raw}' [timeoutMs] to wait for the literal text "${raw}".`
  );
}

function formatTrailingArgsMessage(
  split: { selectorExpression: string; rest: string[] },
  argsWithoutTimeout: string[],
): string {
  const raw = argsWithoutTimeout.join(' ');
  return (
    `Selector ${split.selectorExpression} is followed by unexpected extra arguments: "${split.rest.join(' ')}". ` +
    `Selector values with spaces need quotes, e.g. label="Sign in". ` +
    `Use wait '<selector>' [timeoutMs], or wait text '${raw}' [timeoutMs] to wait for the literal text "${raw}".`
  );
}

function formatSelectorShapedMessage(argsWithoutTimeout: string[]): string {
  const raw = argsWithoutTimeout.join(' ');
  const plainTokens = argsWithoutTimeout.filter((token) => !isSelectorToken(token));
  const selectorTokens = argsWithoutTimeout.filter((token) => isSelectorToken(token));
  if (plainTokens.length > 0) {
    const offending = plainTokens[0]!;
    const conditionHint = CONDITION_WORDS.has(offending.toLowerCase())
      ? ` "${offending}" describes a condition, not a selector key. Use the selector form: ` +
        (offending.toLowerCase() === 'gone' || offending.toLowerCase() === 'disappears'
          ? `wait absent '${selectorTokens.join(' ')}' [timeoutMs] to wait for zero matches.`
          : `wait '${selectorTokens.join(' ')}' [timeoutMs] to wait for it to appear.`)
      : ` "${offending}" is not a recognized selector key (${SELECTOR_KEY_NAMES.join(', ')}).`;
    return (
      `"${raw}" mixes plain word "${offending}" with selector-shaped "${selectorTokens.join(' ')}", ` +
      `so it is neither a valid selector nor safe as literal text.${conditionHint} ` +
      `Use wait '<selector>' [timeoutMs] for a selector, or wait text '${raw}' [timeoutMs] to wait for the literal text "${raw}".`
    );
  }
  return (
    `"${raw}" looks like a selector key but is not a valid selector expression. ` +
    `Use wait '<selector>' [timeoutMs], e.g. wait '${argsWithoutTimeout[0]}="value"' [timeoutMs], ` +
    `or wait text '${raw}' [timeoutMs] to wait for the literal text "${raw}".`
  );
}

/**
 * The user-supplied budget of a `wait` invocation, or null when none was given.
 * The budget travels as a positional, not a flag, so it is parsed the same way
 * the daemon will. Referenced by the `wait` descriptor's timeout policy
 * (ADR 0008) so the client's request envelope can extend past it.
 */
export function resolveWaitBudgetMs(positionals: string[]): number | null {
  const parsed = parseWaitPositionals(positionals);
  if (!parsed) return null;
  if (parsed.kind === 'sleep') return parsed.durationMs;
  if (parsed.kind === 'invalid') return null;
  return parsed.timeoutMs;
}
