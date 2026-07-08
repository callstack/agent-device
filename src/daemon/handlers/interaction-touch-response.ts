import type { GestureReferenceFrame } from '../../core/scroll-gesture.ts';
import type {
  FillCommandResult,
  LongPressCommandResult,
  PressCommandResult,
  SettleObservation,
} from '../../contracts/interaction.ts';
import { successText } from '../../utils/success-text.ts';
import { interactionResultExtra } from './interaction-touch-targets.ts';

/**
 * The single construction site for interaction response payloads (ADR 0011
 * Layer 2). Every press/click/fill/longpress dispatch branch builds its
 * `result` (session history + touch visualization) and `responseData` (public
 * response) payloads here, so identity extras (ref/refLabel/selectorChain/
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
      publicData?: Record<string, unknown>;
    }
  | {
      // Direct iOS selector dispatch: no runtime result exists, only the raw
      // runner payload; identity extras are a declared gap on that path.
      kind: 'runner-payload';
      targetKind: InteractionRuntimeResult['kind'];
      data: Record<string, unknown>;
      publicData?: Record<string, unknown>;
      point: { x: number; y: number };
    };

export type InteractionResponsePayloads = {
  /** Recorded in session history and used for touch visualization. */
  result: Record<string, unknown>;
  /** The public payload returned to the client. */
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
  /**
   * Staleness warning for the consumed `@ref` argument (#1076), resolved by
   * `resolveRefStalenessWarning` (src/daemon/session-snapshot.ts): the coarse
   * STALE_SNAPSHOT_REFS_WARNING for plain refs while `snapshotRefsStale` is
   * set, or the precise pinned-generation warning for `@e12~s3` refs whose
   * generation no longer matches the stored tree. Appended to the response
   * warning.
   */
  staleRefsWarning?: string;
  /**
   * `--settle` (#1101): the session's `snapshotGeneration` AFTER the settled
   * tree became the stored snapshot. Rides INSIDE the settle payload as
   * `settle.refsGeneration` — a settle response with a diff hands the client
   * fresh refs (added lines carry them), making it ref-issuing like snapshot/
   * find; the generation is what MCP auto-pinning merges per-ref (#1076).
   * Only attached when the settle observation actually carries a diff.
   */
  settleRefsGeneration?: number;
}): InteractionResponsePayloads {
  const { source, referenceFrame, extra } = params;
  if (source.kind === 'runner-payload') {
    const commonExtra = {
      targetKind: source.targetKind,
      ...(extra ?? {}),
    };
    const result = buildTouchPayload({
      data: source.data,
      fallbackX: source.point.x,
      fallbackY: source.point.y,
      referenceFrame,
      extra: commonExtra,
    });
    const responseData = buildTouchPayload({
      data: source.publicData,
      fallbackX: source.point.x,
      fallbackY: source.point.y,
      referenceFrame,
      extra: commonExtra,
    });
    return { result, responseData };
  }

  const { result } = source;
  const resultExtra = interactionResultExtra(result);
  const commonExtra = {
    targetKind: result.kind,
    ...resultExtra,
    ...settleExtra(result.settle, params.settleRefsGeneration),
    ...(extra ?? {}),
  };
  const visualization = buildTouchPayload({
    data: result.backendResult,
    fallbackX: result.point?.x,
    fallbackY: result.point?.y,
    referenceFrame,
    extra: commonExtra,
  });
  const responseData = buildTouchPayload({
    data: source.publicData,
    fallbackX: result.point?.x,
    fallbackY: result.point?.y,
    referenceFrame,
    extra: commonExtra,
  });
  const warning = composeResponseWarning(
    'warning' in result ? result.warning : undefined,
    params.staleRefsWarning,
  );
  if (warning) {
    visualization.warning = warning;
    responseData.warning = warning;
  }
  return { result: visualization, responseData };
}

// Attaches refsGeneration inside the settle payload when the response is
// ref-issuing (diff present). Overrides the raw `settle` from
// interactionResultExtra by key order in the extras spread.
function settleExtra(
  settle: SettleObservation | undefined,
  refsGeneration: number | undefined,
): Record<string, unknown> {
  if (!settle?.diff || refsGeneration === undefined) return {};
  return { settle: { ...settle, refsGeneration } };
}

function composeResponseWarning(
  resultWarning: string | undefined,
  staleRefsWarning: string | undefined,
): string | undefined {
  if (!staleRefsWarning) return resultWarning;
  return resultWarning ? `${resultWarning} ${staleRefsWarning}` : staleRefsWarning;
}

function buildTouchPayload(params: {
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
  return stripUndefinedFields({
    ...(data ?? {}),
    ...(fallbackX === undefined || fallbackY === undefined ? {} : { x: fallbackX, y: fallbackY }),
    ...(referenceFrame ?? {}),
    ...(extra ?? {}),
    ...successText(message),
  });
}

function stripUndefinedFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function buildTouchMessage(
  extra: Record<string, unknown> | undefined,
  x: number | undefined,
  y: number | undefined,
): string | undefined {
  const fillText = readString(extra, 'text');
  if (fillText !== undefined) return `Filled ${Array.from(fillText).length} chars`;

  const pointSuffix = buildPointSuffix(x, y);
  const label = buildTouchTargetLabel(extra);
  if (label) return buildTouchTargetMessage(label, extra ?? {}, pointSuffix);
  if (!pointSuffix) return undefined;

  return buildPointTouchMessage(extra, pointSuffix);
}

function readString(data: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function buildPointSuffix(x: number | undefined, y: number | undefined): string {
  return x === undefined || y === undefined ? '' : ` (${x}, ${y})`;
}

function buildTouchTargetLabel(extra: Record<string, unknown> | undefined): string | undefined {
  const ref = readString(extra, 'ref');
  return ref === undefined ? readString(extra, 'selector') : `@${ref}`;
}

function buildPointTouchMessage(
  extra: Record<string, unknown> | undefined,
  pointSuffix: string,
): string {
  return extra?.gesture === 'longpress' ? `Long pressed${pointSuffix}` : `Tapped${pointSuffix}`;
}

function buildTouchTargetMessage(
  label: string,
  extra: Record<string, unknown>,
  pointSuffix: string,
): string {
  const button = typeof extra.button === 'string' ? extra.button : undefined;
  if (extra.gesture === 'longpress') {
    return `Long pressed ${label}${pointSuffix}`;
  }
  if (button && button !== 'primary') {
    return `Clicked ${button} ${label}${pointSuffix}`;
  }
  return `Tapped ${label}${pointSuffix}`;
}
