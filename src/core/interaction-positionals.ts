import { AppError } from '../kernel/errors.ts';
import { isSelectorToken, splitSelectorFromArgs } from '../utils/selectors-parse.ts';

type PositionalInteractionTarget =
  | { x: number; y: number }
  | { ref: string; label?: string }
  | { selector: string };

export type DecodedFillTarget =
  | { kind: 'ref'; target: { ref: string; label?: string }; text: string }
  | { kind: 'selector'; target: { selector: string }; text: string }
  | { kind: 'point'; target: { x: number; y: number }; text: string };

const BARE_SNAPSHOT_REF_PATTERN = /^e\d+$/;

export function readInteractionTargetFromPositionals(
  positionals: string[],
): PositionalInteractionTarget {
  if (positionals[0]?.startsWith('@')) {
    const label = optionalTrimmedText(positionals.slice(1));
    return { ref: positionals[0], ...(label === undefined ? {} : { label }) };
  }
  if (BARE_SNAPSHOT_REF_PATTERN.test(positionals[0] ?? '')) {
    throw new AppError(
      'INVALID_ARGS',
      `Did you mean "@${positionals[0]}"? Snapshot refs need the @ prefix.`,
    );
  }
  const selectorArgs = splitSelectorFromArgs(positionals);
  if (selectorArgs) {
    if (selectorArgs.rest.length > 0) {
      throw new AppError(
        'INVALID_ARGS',
        formatSelectorTrailingArgsFailure(positionals, selectorArgs),
      );
    }
    return { selector: selectorArgs.selectorExpression };
  }
  return readPointTarget(positionals);
}

export function readFillTargetFromPositionals(positionals: string[]): DecodedFillTarget {
  const firstPositional = positionals[0];
  if (firstPositional?.startsWith('@')) {
    const text =
      positionals.length >= 3 ? positionals.slice(2).join(' ') : positionals.slice(1).join(' ');
    return {
      kind: 'ref',
      target: {
        ref: firstPositional,
        label: positionals.length >= 3 ? optionalTrimmedText(positionals.slice(1, 2)) : undefined,
      },
      text,
    };
  }
  if (BARE_SNAPSHOT_REF_PATTERN.test(firstPositional ?? '')) {
    throw new AppError(
      'INVALID_ARGS',
      `Did you mean "@${firstPositional}"? Snapshot refs need the @ prefix.`,
    );
  }
  const selectorArgs = splitSelectorFromArgs(positionals, { preferTrailingValue: true });
  if (selectorArgs) {
    return {
      kind: 'selector',
      target: { selector: selectorArgs.selectorExpression },
      text: selectorArgs.rest.join(' '),
    };
  }
  return {
    kind: 'point',
    target: readPointTarget(positionals.slice(0, 2)),
    text: positionals.slice(2).join(' '),
  };
}

function readPointTarget(positionals: string[]): { x: number; y: number } {
  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  throw new AppError('INVALID_ARGS', formatTargetParseFailure(positionals));
}

function formatTargetParseFailure(positionals: string[]): string {
  const raw = positionals.filter((part) => part !== undefined).join(' ');
  if (!raw.trim()) {
    return 'Missing target. Pass an @ref from snapshot, a selector like text="Sign in", or "x y" coordinates.';
  }
  const base = `Target "${raw}" is not a @ref, selector, or "x y" point.`;
  if (positionals.some((part) => isSelectorToken(part ?? ''))) {
    return `${base} Selector values with spaces need quotes, e.g. text="Sign in".`;
  }
  return `${base} To match by visible text, use text=${quoteSelectorValue(raw)} (or label=/id=/role=), or pass an @ref from snapshot.`;
}

function formatSelectorTrailingArgsFailure(
  positionals: string[],
  selectorArgs: { selectorExpression: string; rest: string[] },
): string {
  const base = `Selector ${selectorArgs.selectorExpression} is followed by unexpected extra arguments: "${selectorArgs.rest.join(' ')}".`;
  const suggestion = mergeRestIntoSelectorValue(positionals, selectorArgs) ?? 'text="Sign in"';
  return `${base} Selector values with spaces need quotes, e.g. ${suggestion}.`;
}

function mergeRestIntoSelectorValue(
  positionals: string[],
  selectorArgs: { selectorExpression: string; rest: string[] },
): string | undefined {
  const boundary = positionals.length - selectorArgs.rest.length;
  const lastSelectorToken = positionals[boundary - 1];
  if (lastSelectorToken === undefined) return undefined;
  const equalsIdx = lastSelectorToken.indexOf('=');
  if (equalsIdx <= 0) return undefined;
  const mergedValue = [lastSelectorToken.slice(equalsIdx + 1), ...selectorArgs.rest].join(' ');
  const mergedToken = `${lastSelectorToken.slice(0, equalsIdx + 1)}${quoteSelectorValue(mergedValue)}`;
  return [...positionals.slice(0, boundary - 1), mergedToken].join(' ');
}

function quoteSelectorValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function optionalTrimmedText(parts: string[]): string | undefined {
  const text = parts.join(' ').trim();
  return text ? text : undefined;
}
