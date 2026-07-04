import type {
  FillCommandResult,
  InteractionTarget,
  LongPressCommandResult,
  PressCommandResult,
} from '../../contracts/interaction.ts';
import {
  readFillTargetFromPositionals,
  type DecodedFillTarget,
} from '../../core/interaction-positionals.ts';
import type { DaemonResponse } from '../types.ts';
import { parseCoordinateTarget } from './interaction-targeting.ts';
import { errorResponse } from './response.ts';

export type ParsedTouchTarget =
  | { ok: true; target: InteractionTarget; durationMs?: never }
  | { ok: false; response: DaemonResponse };

export function parseTouchTarget(positionals: string[], commandLabel: string): ParsedTouchTarget {
  const coordinates = parseCoordinateTarget(positionals);
  if (coordinates) {
    return { ok: true, target: { kind: 'point', x: coordinates.x, y: coordinates.y } };
  }
  const first = positionals[0] ?? '';
  if (first.startsWith('@')) {
    return {
      ok: true,
      target: {
        kind: 'ref',
        ref: first,
        fallbackLabel: positionals.slice(1).join(' ').trim(),
      },
    };
  }
  const selector = positionals.join(' ').trim();
  if (!selector) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        `${commandLabel} requires @ref, selector expression, or x y coordinates`,
      ),
    };
  }
  return { ok: true, target: { kind: 'selector', selector } };
}

export type ParsedLongPressTarget =
  | { ok: true; target: InteractionTarget; durationMs?: number }
  | { ok: false; response: DaemonResponse };

export function parseLongPressTarget(positionals: string[]): ParsedLongPressTarget {
  const coordinates = parseCoordinateTarget(positionals);
  if (coordinates) {
    return {
      ok: true,
      target: { kind: 'point', x: coordinates.x, y: coordinates.y },
      ...readOptionalDuration(positionals[2]),
    };
  }

  const split = splitTrailingDuration(positionals);
  const parsedTarget = parseTouchTarget(split.targetPositionals, 'longpress');
  if (!parsedTarget.ok) return parsedTarget;
  return {
    ok: true,
    target: parsedTarget.target,
    ...split.duration,
  };
}

export type ParsedFillTarget =
  | { ok: true; target: InteractionTarget; text: string }
  | { ok: false; response: DaemonResponse };

export function parseFillTarget(positionals: string[]): ParsedFillTarget {
  const first = positionals[0] ?? '';
  if (first.startsWith('@')) {
    const parsed = readFillTargetFromPositionals(positionals);
    const text = parsed.text;
    if (!text)
      return { ok: false, response: errorResponse('INVALID_ARGS', 'fill requires text after ref') };
    return {
      ok: true,
      target: {
        kind: 'ref',
        ref: first,
        fallbackLabel: readRefFallbackLabel(positionals),
      },
      text,
    };
  }

  const coordinates = parseCoordinateTarget(positionals);
  if (coordinates) {
    const text = positionals.slice(2).join(' ');
    if (!text)
      return {
        ok: false,
        response: errorResponse('INVALID_ARGS', 'fill requires text after coordinates'),
      };
    return { ok: true, target: { kind: 'point', x: coordinates.x, y: coordinates.y }, text };
  }

  const parsed = tryReadFillSelectorTarget(positionals);
  if (!parsed || parsed.kind !== 'selector') {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        'fill requires x y text, @ref text, or selector text',
      ),
    };
  }
  // Preserve payload whitespace (for example Maestro/keyboard-enter newlines)
  // while still rejecting selector fills that contain only whitespace.
  if (!parsed.text.trim()) {
    return {
      ok: false,
      response: errorResponse('INVALID_ARGS', 'fill requires text after selector'),
    };
  }
  return {
    ok: true,
    target: { kind: 'selector', selector: parsed.target.selector },
    text: parsed.text,
  };
}

// Valid points and @refs are handled above, so a parse failure here only means
// "not a selector either" — fold it into this handler's uniform INVALID_ARGS response.
function tryReadFillSelectorTarget(positionals: string[]): DecodedFillTarget | null {
  try {
    return readFillTargetFromPositionals(positionals);
  } catch {
    return null;
  }
}

export function interactionResultExtra(
  result: PressCommandResult | FillCommandResult | LongPressCommandResult,
): Record<string, unknown> {
  // `evidence` (#1047, opt-in via --verify) is additive on press/fill only —
  // LongPressCommandResult has no evidence field, so it reads as undefined
  // (and gets dropped by the response layer) for longpress.
  const evidence = 'evidence' in result ? result.evidence : undefined;
  if (result.kind === 'ref') {
    return {
      ref: stripAtPrefix(result.target?.kind === 'ref' ? result.target.ref : undefined),
      refLabel: result.refLabel,
      selectorChain: result.selectorChain,
      targetHittable: result.targetHittable,
      hint: result.hint,
      evidence,
    };
  }
  if (result.kind === 'selector') {
    return {
      selector: result.target?.kind === 'selector' ? result.target.selector : undefined,
      selectorChain: result.selectorChain,
      refLabel: result.refLabel,
      targetHittable: result.targetHittable,
      hint: result.hint,
      evidence,
    };
  }
  return { evidence };
}

export function formatTouchTargetLabel(
  target: InteractionTarget,
  result: PressCommandResult | LongPressCommandResult,
): string {
  if (target.kind === 'point') return 'coordinate tap';
  if (result.kind === 'ref' && result.target?.kind === 'ref') return result.target.ref;
  if (result.kind === 'selector' && result.target?.kind === 'selector')
    return result.target.selector;
  return 'target';
}

export function stripAtPrefix(ref: string | undefined): string | undefined {
  return ref?.startsWith('@') ? ref.slice(1) : ref;
}

function readRefFallbackLabel(positionals: string[]): string {
  return positionals.length >= 3 ? positionals[1]?.trim() || '' : '';
}

function splitTrailingDuration(positionals: string[]): {
  targetPositionals: string[];
  duration: { durationMs: number } | Record<string, never>;
} {
  const last = positionals.at(-1);
  if (positionals.length > 1 && isFiniteNumberString(last)) {
    return {
      targetPositionals: positionals.slice(0, -1),
      duration: { durationMs: Number(last) },
    };
  }
  return { targetPositionals: positionals, duration: {} };
}

function readOptionalDuration(
  value: string | undefined,
): { durationMs: number } | Record<string, never> {
  if (value === undefined) return {};
  return { durationMs: Number(value) };
}

function isFiniteNumberString(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  return Number.isFinite(Number(value));
}
