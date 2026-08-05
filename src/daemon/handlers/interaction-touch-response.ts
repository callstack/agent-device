import type {
  FillCommandResult,
  GestureReferenceFrame,
  LongPressCommandResult,
  PressCommandResult,
  RecordingTargetOverride,
  ResolutionDisclosure,
  SettleObservation,
} from '@agent-device/contracts/interaction';
import { successText } from '../../utils/success-text.ts';
import type { RecordedTargetCapture } from '../session-target-evidence.ts';
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

type InteractionResponseSourceBase = {
  publicData?: Record<string, unknown>;
  /**
   * The runner EXECUTED its Maestro non-hittable coordinate fallback, never the
   * mere permission to. Names the dispatch path that ran, not a request flag —
   * see {@link suppressesResolutionDisclosure}.
   */
  maestroCoordinateFallbackDispatched?: boolean;
};

export type InteractionResponseSource =
  | (InteractionResponseSourceBase & {
      kind: 'runtime';
      result: InteractionRuntimeResult;
    })
  | (InteractionResponseSourceBase & {
      // Direct iOS selector dispatch: no runtime result exists, only the raw
      // runner payload; identity extras are a declared gap on that path.
      kind: 'runner-payload';
      targetKind: InteractionRuntimeResult['kind'];
      data: Record<string, unknown>;
      point: { x: number; y: number };
    })
  | (InteractionResponseSourceBase & {
      // An XCTest mutation failure was corroborated by a changed same-scope
      // post-action capture. The target was resolved before the runner error,
      // but no runtime result survived the thrown backend failure.
      kind: 'corroborated-tap';
      targetKind: InteractionRuntimeResult['kind'];
      data: Record<string, unknown>;
      publicData?: Record<string, unknown>;
      point?: { x: number; y: number };
      resolution?: ResolutionDisclosure;
    });

// ADR 0012 decision 2: the XCTest fast path has no daemon tree, so it can only
// disclose that resolution was not observed.
const DIRECT_IOS_NOT_OBSERVED_RESOLUTION: ResolutionDisclosure = {
  source: 'direct-ios',
  kind: 'not-observed',
};

/**
 * ADR 0012: `resolution` discloses how the daemon resolved the target. When the
 * runner executed its Maestro non-hittable coordinate fallback, the dispatch
 * that ran reached a coordinate — Maestro owns the matching and nothing about
 * daemon resolution is being reported — so any disclosure the source would
 * otherwise carry describes a dispatch that did not happen and is dropped. Cell
 * membership in `maestro-non-hittable-fallback`
 * (packages/contracts/src/interaction-guarantees.ts) is usage-based for exactly
 * this reason: allowed-but-not-taken is still the direct path and keeps its
 * not-observed disclosure.
 *
 * Both source variants route their extras through here, so the rule is stated
 * and applied once rather than re-encoded per branch.
 */
function applyResolutionDisclosurePolicy<TExtra extends { resolution?: unknown }>(
  source: InteractionResponseSource,
  extra: TExtra,
): TExtra | Omit<TExtra, 'resolution'> {
  if (!suppressesResolutionDisclosure(source)) return extra;
  const { resolution: _resolution, ...withoutResolutionDisclosure } = extra;
  return withoutResolutionDisclosure;
}

function suppressesResolutionDisclosure(source: InteractionResponseSource): boolean {
  return source.maestroCoordinateFallbackDispatched === true;
}

export type InteractionResponsePayloads = {
  /** Recorded in session history and used for touch visualization. */
  result: Record<string, unknown>;
  /** The public payload returned to the client. */
  responseData: Record<string, unknown>;
  /** Typed side channel — never part of either serialized payload. */
  recordedTarget?: RecordedTargetCapture;
};

export function buildCorroboratedTapResponseData(params: {
  targetKind: InteractionRuntimeResult['kind'];
  point?: { x: number; y: number };
  warning: string;
  resolution?: ResolutionDisclosure;
  referenceFrame?: GestureReferenceFrame;
  extra?: Record<string, unknown>;
}): InteractionResponsePayloads {
  return buildInteractionResponseData({
    source: {
      kind: 'corroborated-tap',
      targetKind: params.targetKind,
      data: { warning: params.warning },
      publicData: { warning: params.warning },
      point: params.point,
      resolution: params.resolution,
    },
    referenceFrame: params.referenceFrame,
    extra: params.extra,
  });
}

export function buildInteractionResponseData(params: {
  source: InteractionResponseSource;
  referenceFrame: GestureReferenceFrame | undefined;
  /**
   * Per-command extras: `text` for fill, `durationMs`/`gesture` for longpress,
   * button tags for click, selector/maestro details for the direct path.
   */
  extra?: Record<string, unknown>;
  /**
   * Staleness warning for the consumed `@ref` argument (ADR 0014), resolved by
   * `resolveRefStalenessWarning` (src/daemon/session-snapshot.ts): the
   * STALE_SNAPSHOT_REFS_WARNING for a plain ref once the frame has expired, or
   * the precise pinned-generation warning for a `@e12~s3` ref whose epoch no
   * longer matches the frame. Stale mutations are rejected before reaching this
   * builder; remaining paths append it to the response warning.
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
  if (source.kind === 'runner-payload' || source.kind === 'corroborated-tap') {
    const commonExtra = {
      targetKind: source.targetKind,
      ...applyResolutionDisclosurePolicy(source, {
        resolution:
          source.kind === 'runner-payload' ? DIRECT_IOS_NOT_OBSERVED_RESOLUTION : source.resolution,
      }),
      ...(extra ?? {}),
    };
    const result = buildTouchPayload({
      data: source.data,
      fallbackX: source.point?.x,
      fallbackY: source.point?.y,
      referenceFrame,
      extra: commonExtra,
    });
    const responseData = buildTouchPayload({
      data: source.publicData,
      fallbackX: source.point?.x,
      fallbackY: source.point?.y,
      referenceFrame,
      extra: commonExtra,
    });
    return { result, responseData };
  }

  const { result } = source;
  const commonExtra = {
    targetKind: result.kind,
    ...applyResolutionDisclosurePolicy(source, interactionResultExtra(result)),
    ...settleExtra(result.settle, params.settleRefsGeneration),
    ...(extra ?? {}),
  };
  // #1280: THE recording boundary. `visualization` below is the recorded
  // action entry (the .ad writer reads its `selectorChain`; recording
  // overlays read it too), so it carries the retargeted descendant's
  // chain/ref-label — while `responseData`, built from `commonExtra` alone,
  // keeps describing the dispatched container.
  const visualization = buildTouchPayload({
    data: result.backendResult,
    fallbackX: result.point?.x,
    fallbackY: result.point?.y,
    referenceFrame,
    extra: { ...commonExtra, ...recordingTargetExtra(result) },
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
  return { result: visualization, responseData, ...recordedTargetCapture(result) };
}

function recordedTargetCapture(
  result: InteractionRuntimeResult,
): Pick<InteractionResponsePayloads, 'recordedTarget'> {
  // #1280: the target-v1 evidence source prefers the recording-only
  // retargeted descendant, in lockstep with `recordingTargetExtra`'s chain
  // override — the recorded entry and its evidence always name ONE node.
  const node = readRecordingTarget(result)?.node ?? ('node' in result ? result.node : undefined);
  const preActionNodes = 'preActionNodes' in result ? result.preActionNodes : undefined;
  return node && preActionNodes ? { recordedTarget: { node, preActionNodes } } : {};
}

/** The recorded action entry's #1280 overrides: descendant chain + ref-label; empty when no retarget fired. */
function recordingTargetExtra(result: InteractionRuntimeResult): Record<string, unknown> {
  const recordingTarget = readRecordingTarget(result);
  if (!recordingTarget) return {};
  return { selectorChain: recordingTarget.selectorChain, refLabel: recordingTarget.refLabel };
}

function readRecordingTarget(
  result: InteractionRuntimeResult,
): RecordingTargetOverride | undefined {
  return 'recordingTarget' in result ? result.recordingTarget : undefined;
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
