import { parseTimeout } from '../utils/parse-timeout.ts';
import { splitSelectorFromArgs, tryParseSelectorChain } from '../utils/selectors-parse.ts';

export type WaitParsed =
  | { kind: 'sleep'; durationMs: number }
  | { kind: 'ref'; rawRef: string; timeoutMs: number | null }
  | { kind: 'selector'; selectorExpression: string; timeoutMs: number | null }
  | { kind: 'text'; text: string; timeoutMs: number | null }
  | { kind: 'stable'; quietMs: number | null; timeoutMs: number | null };

export function parseWaitPositionals(args: string[]): WaitParsed | null {
  const firstArg = args[0];
  if (firstArg === undefined) return null;
  const sleepMs = parseTimeout(firstArg);
  if (sleepMs !== null) return { kind: 'sleep', durationMs: sleepMs };
  const timeoutMs = parseTimeout(args[args.length - 1]);
  if (firstArg === 'text') {
    const text = timeoutMs !== null ? args.slice(1, -1).join(' ') : args.slice(1).join(' ');
    return { kind: 'text', text: text.trim(), timeoutMs };
  }
  if (firstArg === 'stable') {
    const rest = args.slice(1);
    const stableTimeoutMs = rest.length > 1 ? parseTimeout(rest[1]) : null;
    const quietMs = rest.length > 0 ? parseTimeout(rest[0]) : null;
    return { kind: 'stable', quietMs, timeoutMs: stableTimeoutMs };
  }
  if (firstArg.startsWith('@')) return { kind: 'ref', rawRef: firstArg, timeoutMs };
  const argsWithoutTimeout = timeoutMs !== null ? args.slice(0, -1) : args.slice();
  const split = splitSelectorFromArgs(argsWithoutTimeout);
  if (split && split.rest.length === 0 && tryParseSelectorChain(split.selectorExpression)) {
    return { kind: 'selector', selectorExpression: split.selectorExpression, timeoutMs };
  }
  const text = timeoutMs !== null ? args.slice(0, -1).join(' ') : args.join(' ');
  return { kind: 'text', text: text.trim(), timeoutMs };
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
  return parsed.timeoutMs;
}
