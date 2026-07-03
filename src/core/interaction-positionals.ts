import { AppError } from '../kernel/errors.ts';
import { splitSelectorFromArgs } from '../utils/selectors-parse.ts';

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
  if (selectorArgs) return { selector: selectorArgs.selectorExpression };
  return { x: Number(positionals[0]), y: Number(positionals[1]) };
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
    target: { x: Number(positionals[0]), y: Number(positionals[1]) },
    text: positionals.slice(2).join(' '),
  };
}

function optionalTrimmedText(parts: string[]): string | undefined {
  const text = parts.join(' ').trim();
  return text ? text : undefined;
}
