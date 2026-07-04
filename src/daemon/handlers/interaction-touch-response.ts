import type { GestureReferenceFrame } from '../../core/scroll-gesture.ts';
import type {
  FillCommandResult,
  LongPressCommandResult,
  PressCommandResult,
} from '../../contracts/interaction.ts';
import { successText } from '../../utils/success-text.ts';
import { interactionResultExtra, stripAtPrefix } from './interaction-touch-targets.ts';

/**
 * The single construction site for interaction response payloads (ADR 0011
 * Layer 2). Every press/click/fill/longpress dispatch branch builds its
 * `result` (session history + touch visualization) and `responseData` (wire)
 * payloads here, so identity extras (ref/refLabel/selectorChain/
 * targetHittable/hint/evidence) are composed in exactly one place — the class
 * of bug where a hand-rolled branch dropped a field (fill @ref dropped
 * `evidence`, #1064 review) cannot recur. A guard test fails any interaction
 * touch handler that assembles a `responseData` object literal outside this
 * module.
 */

type InteractionRuntimeResult = PressCommandResult | FillCommandResult | LongPressCommandResult;

export type InteractionResponseSource =
  | {
      kind: 'runtime';
      result: InteractionRuntimeResult;
      /**
       * Wire-compat for fill @ref: the response echoes backendResult (or a
       * minimal ref/point fallback) plus the identity extras instead of the
       * visualization shape. Only applies when the result resolved as a ref.
       */
      refBackendWireShape?: boolean;
    }
  | {
      // Direct iOS selector dispatch: no runtime result exists, only the raw
      // runner payload; identity extras are a declared gap on that path.
      kind: 'runner-payload';
      data: Record<string, unknown>;
      point: { x: number; y: number };
    };

export type InteractionResponsePayloads = {
  /** Recorded in session history and used for touch visualization. */
  result: Record<string, unknown>;
  /** The wire payload returned to the client. */
  responseData: Record<string, unknown>;
};

export function buildInteractionResponseData(params: {
  source: InteractionResponseSource;
  referenceFrame: GestureReferenceFrame | undefined;
  /**
   * Per-command extras: `text` for fill, `durationMs`/`gesture` for longpress,
   * button tags for click, selector/maestro details for the direct path.
   */
  extra?: Record<string, unknown>;
}): InteractionResponsePayloads {
  const { source, referenceFrame, extra } = params;
  if (source.kind === 'runner-payload') {
    const payload = buildTouchVisualizationResult({
      data: source.data,
      fallbackX: source.point.x,
      fallbackY: source.point.y,
      referenceFrame,
      extra,
    });
    return { result: payload, responseData: payload };
  }

  const { result } = source;
  const visualization = buildTouchVisualizationResult({
    data: result.backendResult,
    fallbackX: result.point?.x,
    fallbackY: result.point?.y,
    referenceFrame,
    extra: {
      ...interactionResultExtra(result),
      ...(extra ?? {}),
    },
  });
  const responseData =
    source.refBackendWireShape && result.kind === 'ref'
      ? {
          ...(result.backendResult ?? {
            ref: stripAtPrefix(result.target?.kind === 'ref' ? result.target.ref : undefined),
            ...(result.point ? { x: result.point.x, y: result.point.y } : {}),
          }),
          ...interactionResultExtra(result),
        }
      : visualization;
  if ('warning' in result && result.warning) {
    visualization.warning = result.warning;
    responseData.warning = result.warning;
  }
  return { result: visualization, responseData };
}

function buildTouchVisualizationResult(params: {
  data: Record<string, unknown> | undefined;
  fallbackX?: number;
  fallbackY?: number;
  referenceFrame?: GestureReferenceFrame;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const { data, fallbackX, fallbackY, referenceFrame, extra } = params;
  const message =
    buildTouchMessage(extra, fallbackX, fallbackY) ??
    (typeof data?.message === 'string' ? data.message : undefined);
  return {
    ...(fallbackX === undefined || fallbackY === undefined ? {} : { x: fallbackX, y: fallbackY }),
    ...(referenceFrame ?? {}),
    ...(extra ?? {}),
    ...(data ?? {}),
    ...successText(message),
  };
}

function buildTouchMessage(
  extra: Record<string, unknown> | undefined,
  x: number | undefined,
  y: number | undefined,
): string | undefined {
  if (typeof extra?.text === 'string') {
    return `Filled ${Array.from(extra.text).length} chars`;
  }
  const ref = typeof extra?.ref === 'string' ? extra.ref : undefined;
  if (!ref) return undefined;
  const pointSuffix = x === undefined || y === undefined ? '' : ` (${x}, ${y})`;
  return buildRefTouchMessage(ref, extra ?? {}, pointSuffix);
}

function buildRefTouchMessage(
  ref: string,
  extra: Record<string, unknown>,
  pointSuffix: string,
): string {
  const button = typeof extra.button === 'string' ? extra.button : undefined;
  if (extra.gesture === 'longpress') {
    return `Long pressed @${ref}${pointSuffix}`;
  }
  if (button && button !== 'primary') {
    return `Clicked ${button} @${ref}${pointSuffix}`;
  }
  return `Tapped @${ref}${pointSuffix}`;
}
