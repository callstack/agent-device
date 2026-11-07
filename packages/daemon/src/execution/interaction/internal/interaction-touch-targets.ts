import type { DaemonResponse } from '@agent-device/kernel/contracts';
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
} from '@agent-device/selectors/interaction-positionals';
import { parseCoordinateTarget } from './interaction-targeting.ts';
import { parseVersionedRefPositional } from '../../ref-positionals.ts';
import { errorResponse } from '@agent-device/kernel/contracts';

/** What a decoded touch target carries: the target plus optional ref-plan provenance. */
type ParsedTouchTargetOk = {
  target: InteractionTarget;
  refGeneration?: number;
  /** Multi-ref press sequence members in dispatch order, bare ref bodies (`e13`). */
  refs?: string[];
  refGenerations?: (number | undefined)[];
};

export type ParsedTouchTarget =
  | (ParsedTouchTargetOk & {
      ok: true;
      /** Only `longpress` decodes a duration. */ durationMs?: never;
    })
  | { ok: false; response: DaemonResponse };

/** The tap family members a multi-ref sequence is admitted on: the commands that own `--count`. */
const SEQUENCE_TOUCH_COMMANDS: ReadonlySet<string> = new Set(['press', 'click']);

export function parseTouchTarget(positionals: string[], commandLabel: string): ParsedTouchTarget {
  const coordinates = parseCoordinateTarget(positionals);
  if (coordinates) {
    return { ok: true, target: { kind: 'point', x: coordinates.x, y: coordinates.y } };
  }
  const first = positionals[0] ?? '';
  if (first.startsWith('@')) {
    if (first.includes(',')) {
      if (!SEQUENCE_TOUCH_COMMANDS.has(commandLabel)) {
        return {
          ok: false,
          response: errorResponse(
            'INVALID_ARGS',
            `${commandLabel} takes one @ref — only press and click accept a comma-separated ref sequence`,
          ),
        };
      }
      return parseTouchRefSequence(positionals);
    }
    const spaceSeparatedRef = positionals[1];
    if (
      SEQUENCE_TOUCH_COMMANDS.has(commandLabel) &&
      spaceSeparatedRef !== undefined &&
      /^@e\d+(~s\d+)?$/.test(spaceSeparatedRef.trim())
    ) {
      // `press @e13 @e14` is a comma-separated plan typed with spaces. On the
      // single-ref path the extra positional would become a fallback label and
      // every key after the first would be lost to a silent success — the
      // exact failure class the sequence form exists to remove.
      return {
        ok: false,
        response: errorResponse(
          'INVALID_ARGS',
          `"${spaceSeparatedRef.trim()}" looks like a second key. Separate the keys of a ref sequence with commas: @e13,@e14.`,
          undefined,
          { hint: REF_SEQUENCE_HINT },
        ),
      };
    }
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

const TOUCH_SEQUENCE_MAX_REFS = 16;

/**
 * The multi-ref press plan (`press @e13,@e14,@e15,@e16`): every comma-separated
 * token must parse as a versioned snapshot ref and normalize to the `e<digits>`
 * body the frame issues, and the plan names at least two distinct keys. The
 * first member stays the command's `target` so the response's ref identity
 * keeps the single-ref shape; the full plan rides beside it. The form is not
 * recordable — the recorder binds one target per step — so daemon admission
 * refuses it while a script recording is armed, and a replay dispatch that
 * still carries a target guard for it refuses instead of downgrading to the
 * first key.
 */
function parseTouchRefSequence(positionals: string[]): ParsedTouchTarget {
  if (positionals.length > 1) {
    // A plan is one positional. A trailing token would otherwise be dropped
    // silently, while the same command on the single-ref path reads it as a
    // fallback label — one trailing rule per form, stated instead of guessed.
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        `Unexpected argument "${positionals.slice(1).join(' ')}" after the ref sequence — a multi-ref plan takes no trailing label.`,
        undefined,
        { hint: REF_SEQUENCE_HINT },
      ),
    };
  }
  const members = positionals[0]!.split(',').map((token) => token.trim());
  if (members.some((token) => token.length === 0)) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        `Invalid ref sequence "${positionals[0]}" — empty member between commas.`,
        undefined,
        { hint: REF_SEQUENCE_HINT },
      ),
    };
  }
  if (members.length > TOUCH_SEQUENCE_MAX_REFS) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        `Ref sequence "${positionals[0]}" lists ${members.length} refs; the maximum is ${TOUCH_SEQUENCE_MAX_REFS}.`,
        undefined,
        { hint: REF_SEQUENCE_HINT },
      ),
    };
  }
  const parsed: { ref: string; generation?: number }[] = [];
  for (const member of members) {
    const versioned = parseVersionedRefPositional(member);
    if (!versioned.ok) return { ok: false, response: versioned.response };
    const body = versioned.ref.startsWith('@') ? versioned.ref.slice(1) : versioned.ref;
    if (!/^e\d+$/.test(body)) {
      return {
        ok: false,
        response: errorResponse(
          'INVALID_ARGS',
          `Invalid ref "${member}" in sequence — expected a snapshot ref.`,
          undefined,
          { hint: REF_SEQUENCE_HINT },
        ),
      };
    }
    parsed.push({
      ref: body,
      ...(versioned.generation !== undefined ? { generation: versioned.generation } : {}),
    });
  }
  const bodies = parsed.map((member) => member.ref);
  if (new Set(bodies).size !== bodies.length) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        `Ref sequence "${positionals[0]}" names the same ref more than once.`,
        undefined,
        { hint: REF_SEQUENCE_HINT },
      ),
    };
  }
  return {
    ok: true,
    target: { kind: 'ref', ref: `@${bodies[0]}` },
    refs: bodies,
    refGenerations: parsed.map((member) => member.generation),
  };
}

const REF_SEQUENCE_HINT =
  'List each snapshot ref in press order, for example press @e13,@e14,@e15,@e16. Every key is admitted against the current frame before the first press; after each press the next key is re-found by identity on a fresh capture and refused with sequence_ref_unmatched when its element is gone.';

export type ParsedLongPressTarget =
  | (ParsedTouchTargetOk & { ok: true; durationMs?: number })
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
  // opt-in via --settle) is additive on all four touch commands. `sequence`
  // is additive on press only (the multi-ref plan summary).
  const evidence = 'evidence' in result ? result.evidence : undefined;
  const settle = result.settle;
  const sequence = 'sequence' in result ? result.sequence : undefined;
  const shared = sequence ? { sequence } : {};
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
      ...shared,
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
      ...shared,
    };
  }
  return { evidence, settle, ...shared };
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
