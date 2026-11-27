import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

export function stripAtPrefix(ref: string | undefined): string | undefined {
  return ref?.startsWith('@') ? ref.slice(1) : ref;
}
import {
  detectUnknownSelectorKeyToken,
  isRoleHintWord,
  isSelectorToken,
  SELECTOR_KEY_NAMES,
  splitSelectorFromArgs,
} from '@agent-device/selectors';

type PositionalInteractionTarget =
  | { x: number; y: number }
  | { ref: string; label?: string }
  | { selector: string };

/**
 * `text` is `undefined` when the grammar supplied NO text argument at all, and `''` when it
 * supplied an empty one. `fill <target> ""` is the clear-field primitive (#2063), so the two
 * cannot collapse: without the distinction a forgotten argument (`fill @e57`) would silently
 * erase the field instead of being refused.
 */
export type DecodedFillTarget =
  | { kind: 'ref'; target: { ref: string }; text: string | undefined }
  | { kind: 'selector'; target: { selector: string }; text: string | undefined }
  | { kind: 'point'; target: { x: number; y: number }; text: string | undefined };

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

/**
 * Decodes `fill` positionals. Any positional may be sensitive text (for example `--record-as` or
 * `--text-stdin` when a ref variable expands to nothing), so no refusal quotes a positional.
 */
export function readFillTargetFromPositionals(positionals: string[]): DecodedFillTarget {
  const firstPositional = positionals[0];
  if (firstPositional?.startsWith('@')) {
    const textPositionals = positionals.slice(1);
    const text = textPositionals.length === 0 ? undefined : textPositionals.join(' ');
    return {
      kind: 'ref',
      target: { ref: firstPositional },
      text,
    };
  }
  if (BARE_SNAPSHOT_REF_PATTERN.test(firstPositional ?? '')) {
    throw new AppError('INVALID_ARGS', 'Snapshot refs need the @ prefix.');
  }
  const selectorArgs = splitSelectorFromArgs(positionals, { preferTrailingValue: true });
  if (selectorArgs) {
    return {
      kind: 'selector',
      target: { selector: selectorArgs.selectorExpression },
      text: selectorArgs.rest.length === 0 ? undefined : selectorArgs.rest.join(' '),
    };
  }
  if (isFillTargetMissing(positionals)) {
    throw new AppError('INVALID_ARGS', formatFillMissingTargetFailure(positionals), {
      reason: FILL_TARGET_REFUSAL_REASONS.targetMissing.reason,
    });
  }
  const pointText = positionals.slice(2);
  return {
    kind: 'point',
    target: readPointTarget(positionals.slice(0, 2), { quotePositionals: false }),
    text: pointText.length === 0 ? undefined : pointText.join(' '),
  };
}

/** Why `fill` refused its positionals before it decoded a target. */
const FILL_TARGET_REFUSAL_REASONS = {
  // Only the text arrived: one value that is no target, or a blank target before the text.
  targetMissing: { reason: 'fill_target_missing' },
} as const satisfies ReasonTable<'fill'>;

/**
 * `fill $REF "136849"` with an unset `REF` reaches here as one value, and `fill "$REF" "136849"`
 * as a blank target; either way the caller supplied text but no target. One value that holds a
 * selector key (`label=Sign in`) or an unknown key is a malformed target, so its own diagnostic
 * stays.
 */
function isFillTargetMissing(positionals: string[]): boolean {
  const [target = '', ...rest] = positionals;
  if (rest.length > 0) return target.trim() === '';
  if (target.trim() === '' || detectUnknownSelectorKeyToken(target)) return false;
  return !target.split(/\s+/).some(isSelectorToken);
}

function formatFillMissingTargetFailure(positionals: string[]): string {
  const got = positionals.length === 1 ? 'got one value' : 'got an empty target';
  return `fill needs <target> <text> but ${got}. If a ref variable expanded to nothing, the target is missing: pass an @ref from snapshot, a selector, or x y coordinates before the text.`;
}

function readPointTarget(
  positionals: string[],
  options: { quotePositionals?: boolean } = {},
): { x: number; y: number } {
  const quotePositionals = options.quotePositionals ?? true;
  const firstPositional = positionals[0] ?? '';
  const unknownKey = detectUnknownSelectorKeyToken(firstPositional);
  if (unknownKey) {
    throw new AppError(
      'INVALID_ARGS',
      formatUnknownSelectorKeyFailure(unknownKey, positionals, quotePositionals),
    );
  }
  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  throw new AppError('INVALID_ARGS', formatTargetParseFailure(positionals, quotePositionals));
}

function hasCompleteQuotedValue(token: string): boolean {
  const valueRaw = token.slice(token.indexOf('=') + 1).trim();
  if (valueRaw.length < 2) return false;
  const first = valueRaw[0];
  return (first === '"' || first === "'") && valueRaw.endsWith(first);
}

function formatUnknownSelectorKeyFailure(
  unknownKey: { key: string; value: string },
  positionals: string[],
  quotePositionals: boolean,
): string {
  const { key } = unknownKey;
  const supported = SELECTOR_KEY_NAMES.join(', ');
  if (!quotePositionals) {
    const hint = isRoleHintWord(key)
      ? 'Did you mean role=<role> label="..."?'
      : 'Did you mean label="..."?';
    return `Unknown selector key. Supported: ${supported}. ${hint}`;
  }
  // An unquoted multi-word value arrives split across positionals (button=Push Article), so
  // fold the trailing tokens back into the suggested value like mergeRestIntoSelectorValue.
  // A fully quoted value (button="Push Article") is complete; trailing tokens are not part of it.
  const firstPositional = positionals[0] ?? '';
  const value = hasCompleteQuotedValue(firstPositional)
    ? unknownKey.value
    : [unknownKey.value, ...positionals.slice(1)].join(' ').trim();
  const hint = isRoleHintWord(key)
    ? `Did you mean role=${key} label=${quoteSelectorValue(value)}?`
    : `Did you mean label=${quoteSelectorValue(value)}?`;
  return `Unknown selector key "${key}". Supported: ${supported}. ${hint}`;
}

function formatTargetParseFailure(positionals: string[], quotePositionals: boolean): string {
  const raw = positionals.filter((part) => part !== undefined).join(' ');
  if (!raw.trim()) {
    return 'Missing target. Pass an @ref from snapshot, a selector like text="Sign in", or "x y" coordinates.';
  }
  const base = quotePositionals
    ? `Target "${raw}" is not a @ref, selector, or "x y" point.`
    : 'Target is not a @ref, selector, or "x y" point.';
  if (positionals.some((part) => isSelectorToken(part ?? ''))) {
    return `${base} Selector values with spaces need quotes, e.g. text="Sign in".`;
  }
  const textExample = quotePositionals ? quoteSelectorValue(raw) : '"..."';
  return `${base} To match by visible text, use text=${textExample} (or label=/id=/role=), or pass an @ref from snapshot.`;
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
  return `"${value.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`;
}

function optionalTrimmedText(parts: string[]): string | undefined {
  const text = parts.join(' ').trim();
  return text ? text : undefined;
}
