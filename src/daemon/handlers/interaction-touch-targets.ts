import type {
  FillCommandResult,
  InteractionTarget,
  LongPressCommandResult,
  PressCommandResult,
} from '@agent-device/contracts/interaction';
import {
  readFillTargetFromPositionals,
  stripAtPrefix,
  type DecodedFillTarget,
} from '../../core/interaction-positionals.ts';
import type { DaemonResponse } from '../types.ts';
import { REF_GRAMMAR_HINT, splitRefGenerationSuffix } from '@agent-device/kernel/snapshot';
import { parseCoordinateTarget } from './interaction-targeting.ts';
import { errorResponse } from './response.ts';

export type ParsedTouchTarget =
  | { ok: true; target: InteractionTarget; refGeneration?: number; durationMs?: never }
  | { ok: false; response: DaemonResponse };

/**
 * Daemon boundary for the versioned-ref suffix (#1076): a pinned `@e12~s3`
 * target is split here so everything downstream (runtime resolution, backend
 * fast paths, recording) sees exactly today's plain `@e12` ref, while the
 * minted generation is surfaced separately for the staleness warning.
 */
type ParsedVersionedRef =
  | { ok: true; ref: string; generation?: number }
  | { ok: false; response: DaemonResponse };

export function parseVersionedRefPositional(refInput: string): ParsedVersionedRef {
  const split = splitRefGenerationSuffix(refInput);
  if (!split) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        `Invalid ref "${refInput}" — malformed generation suffix.`,
        { hint: REF_GRAMMAR_HINT },
      ),
    };
  }
  return { ok: true, ref: split.base, generation: split.generation };
}

export function parseTouchTarget(positionals: string[], commandLabel: string): ParsedTouchTarget {
  const coordinates = parseCoordinateTarget(positionals);
  if (coordinates) {
    return { ok: true, target: { kind: 'point', x: coordinates.x, y: coordinates.y } };
  }
  const first = positionals[0] ?? '';
  if (first.startsWith('@')) {
    const versioned = parseVersionedRefPositional(first);
    if (!versioned.ok) return { ok: false, response: versioned.response };
    return {
      ok: true,
      target: {
        kind: 'ref',
        ref: versioned.ref,
        fallbackLabel: positionals.slice(1).join(' ').trim(),
      },
      refGeneration: versioned.generation,
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
  | { ok: true; target: InteractionTarget; refGeneration?: number; durationMs?: number }
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
    refGeneration: parsedTarget.refGeneration,
    ...split.duration,
  };
}

export type ParsedFillTarget =
  | { ok: true; target: InteractionTarget; refGeneration?: number; text: string }
  | { ok: false; response: DaemonResponse };

function missingFillTextResponse(place: 'ref' | 'coordinates' | 'selector'): ParsedFillTarget {
  return {
    ok: false,
    response: errorResponse(
      'INVALID_ARGS',
      `fill requires text after ${place} (use "" to clear the field)`,
    ),
  };
}

/**
 * One decode, then per-shape admission. `readFillTargetFromPositionals` owns shape detection and
 * the missing-vs-empty text rule (`''` is the clear request, `undefined` a forgotten argument —
 * see {@link DecodedFillTarget}); this layer adds only what the wire owns: versioned-ref
 * admission, the selector whitespace rule, and the daemon error responses.
 */
export function parseFillTarget(positionals: string[]): ParsedFillTarget {
  const decoded = decodeFillTarget(positionals);
  if (!decoded) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        'fill requires x y text, @ref text, or selector text',
      ),
    };
  }
  switch (decoded.kind) {
    case 'ref': {
      const versioned = parseVersionedRefPositional(positionals[0] ?? '');
      if (!versioned.ok) return { ok: false, response: versioned.response };
      if (decoded.text === undefined) return missingFillTextResponse('ref');
      return {
        ok: true,
        target: {
          kind: 'ref',
          ref: versioned.ref,
        },
        refGeneration: versioned.generation,
        text: decoded.text,
      };
    }
    case 'point': {
      if (decoded.text === undefined) return missingFillTextResponse('coordinates');
      return {
        ok: true,
        target: { kind: 'point', x: decoded.target.x, y: decoded.target.y },
        text: decoded.text,
      };
    }
    case 'selector': {
      // Preserve payload whitespace (for example Maestro/keyboard-enter newlines) while still
      // rejecting selector fills that contain only whitespace. `''` is exempt: it is the
      // explicit clear request, not an accidentally blank argument.
      if (decoded.text === undefined || (decoded.text.length > 0 && !decoded.text.trim())) {
        return missingFillTextResponse('selector');
      }
      return {
        ok: true,
        target: { kind: 'selector', selector: decoded.target.selector },
        text: decoded.text,
      };
    }
  }
}

// A decode failure only means "no recognizable target shape" — fold it into this handler's
// uniform INVALID_ARGS response.
function decodeFillTarget(positionals: string[]): DecodedFillTarget | null {
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
  // (and gets dropped by the response layer) for longpress. `settle` (#1101,
  // opt-in via --settle) is additive on all four touch commands.
  const evidence = 'evidence' in result ? result.evidence : undefined;
  const settle = result.settle;
  if (result.kind === 'ref') {
    return {
      ref: stripAtPrefix(result.target?.kind === 'ref' ? result.target.ref : undefined),
      refLabel: result.refLabel,
      selectorChain: result.selectorChain,
      targetHittable: result.targetHittable,
      hint: result.hint,
      evidence,
      settle,
      resolution: result.resolution,
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
      settle,
      resolution: result.resolution,
    };
  }
  return { evidence, settle };
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
