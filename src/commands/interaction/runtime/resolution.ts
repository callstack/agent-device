import { AppError } from '@agent-device/kernel/errors';
import type { Point, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { findNodeByRef, normalizeRef } from '@agent-device/kernel/snapshot';
import { resolveRectCenter } from '../../../utils/rect-center.ts';
import type {
  AgentDeviceRuntime,
  CommandContext,
  CommandSessionRecord,
} from '../../../runtime-contract.ts';
import {
  formatSelectorFailure,
  selectorFailureHint,
  STALE_REF_HINT,
  type SelectorResolution,
  buildSelectorChainForNode,
} from '@agent-device/selectors';
import {
  resolveSelectorPipeline,
  runNodePipelineStages,
  type SelectorPipelineHooks,
} from '../../../core/selector-pipeline.ts';
import {
  SELECTOR_PIPELINE_POLICIES,
  type ActingPipelinePolicy,
  type SelectorPipelinePolicy,
} from '../../../core/selector-pipeline-policy.ts';
import { resolvePressRecordingTarget } from '../../../core/press-retarget.ts';
import { requireSnapshotSession } from './selector-read-shared.ts';
import { findNodeByLabel, resolveRefLabel } from '../../../core/snapshot-node-lookup.ts';
import { containsPoint } from '@agent-device/kernel/rect';
import {
  isNodeVisibleOnScreen,
  normalizeType,
  resolveEffectiveViewportRect,
  resolveViewportRect,
} from '@agent-device/contracts/snapshot';
import {
  classifyOffscreenScrollDirection,
  type OffscreenScrollDirection,
} from '../../../snapshot/mobile-snapshot-semantics.ts';
import { truncateUtf8 } from '../../../utils/truncate-utf8.ts';
import type {
  InteractionTarget,
  PointTarget,
  PreresolvedInteractionTarget,
  RecordingTargetOverride,
  ResolutionDiagnosticEntry,
  ResolutionDisclosure,
  ResolvedInteractionTarget,
} from '@agent-device/contracts/interaction';
import type {
  BackendActionResult,
  BackendCommandContext,
  BackendRefTarget,
} from '../../../backend.ts';
import { now, toBackendContext } from '../../runtime-common.ts';
import { toBackendResult } from '../../runtime-types.ts';
import { resolveInteractionTouchPoint } from '../../../core/interaction-touch-point.ts';
import {
  localIdentitiesEqual,
  readNodeLocalIdentity,
  readNodeStructuralDenotation,
  structuralDenotationsEqual,
} from '@agent-device/ad-script';
import {
  REPLAY_TARGET_GUARD_MISMATCH_REASON,
  type ReplayTargetGuardDenotation,
} from '@agent-device/contracts/replay';
import { resolveActionSelector } from './selector-action-resolution.ts';

export type { InteractionTarget, ResolvedInteractionTarget };

/**
 * ADR 0012 migration step 4, post-resolution guard: the LOCAL identity AND
 * the STRUCTURAL denotation (pre-order document index + same-parent sibling
 * ordinal) of the element replay's pre-action verification isolated. Set ONLY
 * by the replay step loop (via `DaemonRequest.internal.replayTargetGuard`) for
 * annotated verified actions — never on live interactive commands.
 *
 * Local identity alone is insufficient: ADR path 6 isolates ONE member among
 * several nodes that share the same `{id, role, label}` using sibling /
 * region-scoped viewportOrder. If verification isolates duplicate A but
 * dispatch's occlusion/visibility filtering selects duplicate B with the same
 * local identity, a local-identity-only guard would pass and tap the wrong
 * element. The structural denotation is the discriminator that catches that
 * split BEFORE the device action.
 */
export type ExpectedResolvedTarget = ReplayTargetGuardDenotation;

/**
 * Compares the resolution winner (pre-promotion: hittable-ancestor promotion
 * deliberately retargets to the same LEAF's actionable container and must not
 * trip the guard — duplicates are distinct leaves with distinct structural
 * denotations, so comparing the leaf is exactly right) against the verified
 * member's local identity AND structural denotation; throws pre-action when
 * EITHER differs.
 */
export function assertExpectedResolvedTarget(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  expected: ExpectedResolvedTarget | undefined,
  action: string,
  targetRole?: 'source' | 'destination',
): void {
  if (!expected) return;
  const observedIdentity = readNodeLocalIdentity(node);
  const observedStructural = readNodeStructuralDenotation(node, nodes);
  if (
    localIdentitiesEqual(observedIdentity, expected.identity) &&
    structuralDenotationsEqual(observedStructural, expected.structural)
  ) {
    return;
  }
  throw new AppError(
    'COMMAND_FAILED',
    `${action} resolved to a different element than replay verification isolated; the action was not sent`,
    {
      reason: REPLAY_TARGET_GUARD_MISMATCH_REASON,
      observed: observedIdentity,
      observedStructural,
      expected: expected.identity,
      expectedStructural: expected.structural,
      ...(targetRole ? { targetRole } : {}),
    },
  );
}

export type InteractionAction =
  | 'click'
  | 'press'
  | 'fill'
  | 'focus'
  | 'longPress'
  | 'hover'
  | 'scroll'
  | 'swipe'
  | 'pinch'
  | 'pan'
  | 'drag'
  | 'fling'
  | 'rotate'
  | 'transform';

export type InteractionSnapshot = {
  snapshot: SnapshotState;
};

type ResolveInteractionTargetParams = {
  action: InteractionAction;
  requireInteractive: boolean;
  /**
   * The structural pipeline this action runs (#1656): occlusion, off-screen,
   * and hittable-ancestor promotion are the row's decisions. `promotedTarget`
   * for tap-shaped actions, `resolvedTarget` for the actions that must keep
   * the element they resolved.
   */
  pipeline: ActingPipelinePolicy;
  /**
   * `--verify` (#1047): also capture the pre-action node set for a `point` target
   * so `changedFromBefore` evidence has a baseline. Ref/selector targets already
   * capture a snapshot to resolve the target, so this is a no-op cost for them —
   * their nodes are attached below regardless of this flag. For point targets,
   * which normally skip capture entirely, this opts into one extra capture, only
   * when the caller explicitly asked for verify evidence. Defaults to false.
   */
  captureEvidenceBaseline?: boolean;
  /** ADR 0012 step 4 post-resolution guard; see `ExpectedResolvedTarget`. */
  expectedResolvedTarget?: ExpectedResolvedTarget;
  /** Identifies one endpoint when a multi-target replay guard refuses. */
  replayTargetRole?: 'source' | 'destination';
  /**
   * #1654: the caller already resolved this `@ref` against its own capture, so
   * the ref branch adopts that node instead of looking the ref up again. Ref
   * targets only — a selector target has nothing pre-resolved to adopt.
   */
  preresolvedTarget?: PreresolvedInteractionTarget;
};

export async function resolveInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  await assertSupportedInteractionSurface(runtime, options, params.action);

  if (options.target.kind === 'point') {
    return await resolvePointInteractionTarget(runtime, options, options.target, params);
  }

  if (options.target.kind === 'ref') {
    return await resolveRefInteractionTarget(runtime, options, options.target, params);
  }

  return await resolveSelectorInteractionTarget(runtime, options, options.target, params);
}

async function tryResolveOutOfBoundsPointWarning(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: PointTarget,
): Promise<string | undefined> {
  const sessionName = options.session ?? 'default';
  const session = await runtime.sessions.get(sessionName);
  if (!session?.snapshot) return undefined;

  // Create a synthetic rect from the point for viewport lookup
  const pointRect = { x: target.x, y: target.y, width: 0, height: 0 };
  const viewport = resolveViewportRect(session.snapshot.nodes, pointRect);
  if (!viewport) return undefined;

  const point = { x: target.x, y: target.y };
  if (containsPoint(viewport, point.x, point.y)) return undefined;

  return `Coordinates (${point.x}, ${point.y}) are outside the last-known viewport (${viewport.width}x${viewport.height}). The tap will be forwarded anyway; take a fresh snapshot if the screen changed.`;
}

async function resolvePointInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: PointTarget,
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  const warning = await tryResolveOutOfBoundsPointWarning(runtime, options, target);
  if (!params.captureEvidenceBaseline) {
    return {
      kind: 'point',
      point: { x: target.x, y: target.y },
      ...(warning ? { warning } : {}),
    };
  }
  const preActionNodes = await tryCaptureEvidenceBaseline(runtime, options);
  return {
    kind: 'point',
    point: { x: target.x, y: target.y },
    ...(preActionNodes ? { preActionNodes } : {}),
    ...(warning ? { warning } : {}),
  };
}

async function tryCaptureEvidenceBaseline(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
): Promise<SnapshotNode[] | undefined> {
  try {
    const capture = await captureInteractionSnapshot(runtime, options, true);
    return capture.snapshot.nodes;
  } catch {
    // Evidence is best-effort: a failed baseline capture must not fail the
    // action itself. Post-action evidence (if any) will simply omit
    // changedFromBefore.
    return undefined;
  }
}

/** The node a ref target acts on, plus the tree the shared guards read it against. */
type RefResolution = { nodes: SnapshotState['nodes']; resolved: ResolvedRefNode };

/**
 * #1654: adopt the node the caller already resolved instead of resolving the
 * same `@ref` a second time. This replaces the LOOKUP only — every guard below
 * still runs, against the caller's tree, at the symbols the ADR 0011
 * `runtime-ref` cells name.
 *
 * `exact` is truthful only when all three pieces of carried provenance agree:
 * the positional ref, the payload ref, and the node's own ref. Fail closed if
 * future internal plumbing lets them drift.
 */
function adoptPreresolvedRefTarget(
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  preresolved: PreresolvedInteractionTarget,
): RefResolution {
  const ref = normalizeRef(target.ref);
  if (!ref) throw new AppError('INVALID_ARGS', `Invalid ref: ${target.ref}`);
  const carriedRef = normalizeRef(preresolved.ref);
  const nodeRef = preresolved.node.ref ? normalizeRef(preresolved.node.ref) : null;
  if (carriedRef !== ref || nodeRef !== ref || !preresolved.nodes.includes(preresolved.node)) {
    throw new AppError(
      'COMMAND_FAILED',
      'Internal find target provenance does not match the interaction ref',
    );
  }
  return {
    nodes: preresolved.nodes,
    resolved: buildRefResolution(ref, preresolved.node, 'exact'),
  };
}

async function readRefResolution(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
): Promise<RefResolution> {
  const capture = await resolveSnapshotForRef(runtime, options, target);
  return { nodes: capture.snapshot.nodes, resolved: capture.resolved };
}

async function resolveRefInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  const { nodes, resolved } = params.preresolvedTarget
    ? adoptPreresolvedRefTarget(target, params.preresolvedTarget)
    : await readRefResolution(runtime, options, target);
  // #1542: point/response read from the returned (possibly rescue-patched) node.
  const visibleNode = await runInteractionPipelineStages({
    policy: params.pipeline,
    nodes,
    node: resolved.node,
    action: params.action,
    label: `Ref ${target.ref}`,
    hooks: {
      onResolved: (node, tree) => assertReplayTargetResolution(node, tree, params),
      offscreen: async (node, tree) =>
        await assertVisibleRefTarget(runtime, options, node, tree, target.ref, params),
    },
  });
  const point = resolveNodeTouchPoint(visibleNode, nodes, {
    invalidMessage: `Ref ${target.ref} not found or has invalid bounds`,
    blockedTargetLabel: `Ref ${target.ref}`,
    blockedTargetDetails: { ref: `@${normalizeRef(target.ref) ?? visibleNode.ref}` },
  });
  return {
    kind: 'ref',
    point,
    target: { kind: 'ref', ref: `@${resolved.ref}` },
    ...describeResolvedInteractionNode(
      runtime,
      visibleNode,
      nodes,
      params.action,
      resolved.resolution,
    ),
  };
}

async function resolveSelectorInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'selector' }>,
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  const selectorExpression = target.selector;
  let capture = await captureInteractionSnapshot(runtime, options, params.requireInteractive);
  let resolved = resolveActionSelector(
    capture.snapshot.nodes,
    selectorExpression,
    runtime.backend.platform,
    params.pipeline,
  );
  if ((!resolved || !resolved.node.rect) && params.requireInteractive) {
    capture = await captureInteractionSnapshot(runtime, options, false);
    resolved = resolveActionSelector(
      capture.snapshot.nodes,
      selectorExpression,
      runtime.backend.platform,
      params.pipeline,
    );
  }
  if (!resolved || !resolved.node.rect) {
    throw await selectorInteractionFailure({
      runtime,
      nodes: capture.snapshot.nodes,
      selectorExpression,
      action: params.action,
      resolved,
    });
  }
  // #1542: see the ref-target twin above.
  const selected = resolved;
  const visibleNode = await runInteractionPipelineStages({
    policy: params.pipeline,
    nodes: capture.snapshot.nodes,
    node: selected.node,
    action: params.action,
    label: `Selector ${selected.selector}`,
    hooks: {
      onResolved: (node, tree) => assertReplayTargetResolution(node, tree, params),
      offscreen: async (node, tree) =>
        await assertVisibleSelectorTarget(runtime, options, node, tree, selected.selector, params),
    },
  });
  const point = resolveNodeTouchPoint(visibleNode, capture.snapshot.nodes, {
    invalidMessage: `Selector ${resolved.selector} resolved to invalid bounds`,
    blockedTargetLabel: `Selector ${selectorExpression}`,
    blockedTargetDetails: { selector: selectorExpression },
  });
  return {
    kind: 'selector',
    point,
    target: { kind: 'selector', selector: resolved.selector },
    ...describeResolvedInteractionNode(
      runtime,
      visibleNode,
      capture.snapshot.nodes,
      params.action,
      buildSelectorResolutionDisclosure(resolved, capture.snapshot.nodes),
    ),
  };
}

/**
 * No usable acting target. Before reporting "did not match", re-probe the same
 * tree through the diagnosis row: a selector that DOES match but landed on a
 * covered node is a different failure with a different recovery, and the
 * acting row — rect-required, candidates rejected — cannot tell the caller
 * that. Both probes name a policy row, so the two contracts stay visible side
 * by side instead of as two sets of engine knobs (#1630).
 */
async function selectorInteractionFailure(params: {
  runtime: AgentDeviceRuntime;
  nodes: SnapshotState['nodes'];
  selectorExpression: string;
  action: InteractionAction;
  resolved: SelectorResolution | null;
}): Promise<AppError> {
  const { runtime, nodes, selectorExpression, action, resolved } = params;
  // The diagnosis row keeps covered nodes as candidates precisely so its
  // occlusion stage can report them: "matched but covered" is a different
  // failure with a different recovery than "did not match".
  const covered = await resolveSelectorPipeline(
    SELECTOR_PIPELINE_POLICIES.coveredDiagnosis,
    nodes,
    selectorExpression,
    { platform: runtime.backend.platform },
  );
  if (covered.kind === 'occluded') {
    return buildCoveredInteractionError({
      label: `Selector ${covered.selector}`,
      node: covered.node,
      action,
      selector: covered.selector,
    });
  }
  const diagnostics = resolved?.diagnostics ?? [];
  return new AppError(
    'COMMAND_FAILED',
    formatSelectorFailure(selectorExpression, diagnostics, { unique: true }),
    { hint: selectorFailureHint(diagnostics) },
  );
}

function assertReplayTargetResolution(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  params: ResolveInteractionTargetParams,
): void {
  assertExpectedResolvedTarget(
    node,
    nodes,
    params.expectedResolvedTarget,
    params.action,
    params.replayTargetRole,
  );
}

// ADR 0012 decision 2 bounds: diagnostic strings and losing alternatives.
const RESOLUTION_DIAGNOSTIC_STRING_BYTE_CAP = 256;
const MAX_RESOLUTION_ALTERNATIVES = 5;

/**
 * A successful `@ref` lookup names exactly one node; label recovery discloses label-fallback instead.
 * Exported as an ADR 0011 registry anchor: interaction-guarantees.ts cites it as a `via`
 * symbol and the gate test imports it dynamically, which fallow cannot trace statically.
 */
// fallow-ignore-next-line unused-export
export const EXACT_REF_RESOLUTION: ResolutionDisclosure = {
  source: 'ref',
  phase: 'pre-action',
  kind: 'exact',
};

const LABEL_FALLBACK_REF_RESOLUTION: ResolutionDisclosure = {
  source: 'ref',
  phase: 'pre-action',
  kind: 'label-fallback',
};

/** Shared construction site for every runtime-ref resolution disclosure. */
export function buildRefResolution(
  ref: string,
  node: SnapshotNode,
  kind: 'exact' | 'label-fallback',
): ResolvedRefNode {
  return {
    ref,
    node,
    resolution: kind === 'exact' ? EXACT_REF_RESOLUTION : LABEL_FALLBACK_REF_RESOLUTION,
  };
}

const UNIQUE_RUNTIME_RESOLUTION: ResolutionDisclosure = {
  source: 'runtime',
  phase: 'pre-action',
  kind: 'unique',
};

// Disclosure only: the winner stays resolveSelectorChain's pick (ADR 0012).
function buildSelectorResolutionDisclosure(
  resolved: SelectorResolution,
  nodes: SnapshotState['nodes'],
): ResolutionDisclosure {
  if (!resolved.disambiguation) return UNIQUE_RUNTIME_RESOLUTION;
  return {
    source: 'runtime',
    phase: 'pre-action',
    kind: 'disambiguated',
    matchCount: resolved.disambiguation.matchCount,
    winnerDiagnostic: buildResolutionDiagnosticEntry(resolved.node, nodes),
    tiebreak: resolved.disambiguation.tiebreak,
    alternatives: resolved.disambiguation.alternatives
      .slice(0, MAX_RESOLUTION_ALTERNATIVES)
      .map((node) => buildResolutionDiagnosticEntry(node, nodes)),
  };
}

function buildResolutionDiagnosticEntry(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
): ResolutionDiagnosticEntry {
  const role = normalizeType(node.type ?? '');
  const label = resolveRefLabel(node, nodes);
  return {
    diagnosticRef: `diag-${node.ref}`,
    ...(role ? { role: truncateUtf8(role, RESOLUTION_DIAGNOSTIC_STRING_BYTE_CAP) } : {}),
    ...(label !== undefined
      ? { label: truncateUtf8(label, RESOLUTION_DIAGNOSTIC_STRING_BYTE_CAP) }
      : {}),
  };
}

// Shared tail of a resolved ref/selector interaction target: the node itself
// plus everything derived from it for the response. Every response field
// describes the DISPATCHED node — the #1280 retarget rides only on the
// `recordingTarget` side channel below.
function describeResolvedInteractionNode(
  runtime: AgentDeviceRuntime,
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  action: InteractionAction,
  resolution: ResolutionDisclosure,
): {
  node: SnapshotNode;
  selectorChain: string[];
  refLabel: string | undefined;
  targetHittable?: boolean;
  hint?: string;
  preActionNodes: SnapshotState['nodes'];
  resolution: ResolutionDisclosure;
  recordingTarget?: RecordingTargetOverride;
} {
  return {
    node,
    selectorChain: buildSelectorChainForNode(node, runtime.backend.platform, {
      action: action === 'fill' ? 'fill' : 'click',
      nodes,
    }),
    refLabel: resolveRefLabel(node, nodes),
    ...describeNonHittableTarget(node, action),
    preActionNodes: nodes,
    resolution,
    ...pressRecordingTargetOverride(runtime, node, nodes, action),
  };
}

/**
 * #1280 (ADR 0012 decision 3 amendment): the recording-only side channel.
 * When a click/press resolves to an identity-empty container, the RECORDED
 * step retargets to its first labeled descendant — node, chain, and
 * ref-label computed together here so the recorded action entry and its
 * `target-v1` evidence can never half-retarget. The response payloads never
 * consume this (see `interaction-touch-response.ts`). `fill` is deliberately
 * excluded: its chain carries `editable=true` constraints a label descendant
 * cannot satisfy, which would record an unreplayable selector.
 */
function pressRecordingTargetOverride(
  runtime: AgentDeviceRuntime,
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  action: InteractionAction,
): { recordingTarget?: RecordingTargetOverride } {
  if (action !== 'click' && action !== 'press') return {};
  const recordingNode = resolvePressRecordingTarget(node, nodes);
  if (recordingNode === node) return {};
  return {
    recordingTarget: {
      node: recordingNode,
      selectorChain: buildSelectorChainForNode(recordingNode, runtime.backend.platform, {
        action: 'click',
        nodes,
      }),
      refLabel: resolveRefLabel(recordingNode, nodes),
    },
  };
}

/**
 * iOS AX `hittable` flags are unreliable on deep React Native trees (see #1037:
 * a map-pin annotation exact-matched a longer recents row label and reported tap
 * success while doing nothing visible). We deliberately do NOT fail or filter on
 * this signal — that would break selectors that only ever resolve to nodes the
 * platform marks non-hittable. Instead, surface it so the caller can notice a
 * likely no-op tap and re-target with a ref or a more specific selector/longer text.
 */
function describeNonHittableTarget(
  node: SnapshotNode,
  action: InteractionAction,
): { targetHittable?: boolean; hint?: string } {
  if (node.hittable !== false) return {};
  return {
    targetHittable: false,
    hint: `The resolved element reports hittable: false, so this ${action} may have had no visible effect. Verify with a snapshot, or prefer a @ref or a longer/more specific selector to target the intended element.`,
  };
}

/**
 * Every node stage this action's row declares, plus the covered refusal the
 * interaction runtime owns. Which stages run is the row's decision; every
 * acting path — selector, ref, and the native-ref preflight — enters them here.
 */
async function runInteractionPipelineStages(params: {
  policy: SelectorPipelinePolicy;
  nodes: SnapshotState['nodes'];
  node: SnapshotNode;
  action: InteractionAction;
  label: string;
  hooks: SelectorPipelineHooks;
}): Promise<SnapshotNode> {
  const target = await runNodePipelineStages(
    params.policy,
    params.nodes,
    params.node,
    params.hooks,
  );
  if (target.kind === 'occluded') {
    throw buildCoveredInteractionError({
      label: params.label,
      node: target.node,
      action: params.action,
    });
  }
  return target.node;
}

function buildCoveredInteractionError(params: {
  label: string;
  node: SnapshotNode;
  action: InteractionAction;
  selector?: string;
}): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${params.label} is covered by another visible element and cannot ${interactionVerb(params.action)} safely`,
    {
      hint: 'Use a different visible target, scroll it clear of the overlay, or inspect with snapshot/screenshot before retrying.',
      ...(params.selector ? { selector: params.selector } : {}),
      ref: `@${params.node.ref}`,
      interactionBlocked: params.node.interactionBlocked,
    },
  );
}

function interactionVerb(action: InteractionAction): string {
  switch (action) {
    case 'fill':
      return 'be filled';
    case 'focus':
      return 'be focused';
    case 'longPress':
      return 'be long-pressed';
    case 'hover':
      return 'be hovered';
    default:
      return 'be tapped';
  }
}

export async function captureInteractionSnapshot(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  interactiveOnly: boolean,
): Promise<InteractionSnapshot> {
  if (!runtime.backend.captureSnapshot) {
    throw new AppError('UNSUPPORTED_OPERATION', 'snapshot is not supported by this backend');
  }
  const sessionName = options.session ?? 'default';
  const session = await runtime.sessions.get(sessionName);
  if (!session) throw new AppError('SESSION_NOT_FOUND', 'No active session. Run open first.');
  const result = await runtime.backend.captureSnapshot(toBackendContext(runtime, options), {
    interactiveOnly,
    includeRects: true,
  });
  const snapshot =
    result.snapshot ??
    ({
      nodes: result.nodes ?? [],
      truncated: result.truncated,
      backend: result.backend as SnapshotState['backend'],
      createdAt: now(runtime),
    } satisfies SnapshotState);
  await runtime.sessions.set({ ...session, snapshot });
  return { snapshot };
}

export async function assertSupportedInteractionSurface(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  action: InteractionAction,
): Promise<void> {
  if (runtime.backend.platform !== 'macos') return;
  const surface = await resolveInteractionSurface(runtime, options);
  if (surface !== 'desktop' && surface !== 'menubar') return;
  // Menu bar button activation is supported by the existing daemon path; text entry is not.
  if (surface === 'menubar' && (action === 'click' || action === 'press')) return;
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `${action} is not supported on macOS ${surface} sessions yet. Open an app session to act, or use the ${surface} surface to inspect.`,
  );
}

async function resolveInteractionSurface(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
): Promise<unknown> {
  const session = await runtime.sessions.get(options.session ?? 'default');
  return session?.metadata?.surface;
}

async function resolveSnapshotForRef(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
): Promise<InteractionSnapshot & { resolved: ResolvedRefNode }> {
  const { session, snapshot: frameTree } = await requireSnapshotSession(runtime, options.session);

  const fallbackLabel = target.fallbackLabel ?? '';
  const authorized = tryResolveRefNode(frameTree.nodes, target.ref, {
    fallbackLabel,
  });
  // ADR 0014: missing authorized-frame evidence FAILS. It must not fall through
  // to a fresh capture and accept the same ref body from a newer tree — that is
  // exactly the positional-coincidence retarget the frame model forbids. A stale
  // read is observable and recoverable; a stale mutation can act on the wrong
  // element. The caller re-observes (snapshot) or uses a selector.
  if (!authorized) {
    throw new AppError('COMMAND_FAILED', `Ref ${target.ref} not found or has no bounds`, {
      hint: STALE_REF_HINT,
    });
  }
  return reconcileFreshObservation({
    session,
    frameTree,
    target,
    fallbackLabel,
    authorized,
  });
}

/**
 * ADR 0014 step 5: decouple Android freshness from ref authorization. The frame
 * tree names WHICH node `@eN` authorizes. When a freshness (or other read-only)
 * capture has advanced the operational observation past the frame, adopt the
 * observation's node — its fresh on-screen coordinates — ONLY when its local
 * identity still matches the authorized node. That covers the legitimate case of
 * an element that merely moved. If the identity differs (a different element now
 * sits at that index) or the ref is absent from the observation, keep the
 * authorized frame node so a positional coincidence cannot retarget the action.
 */
function reconcileFreshObservation(params: {
  session: CommandSessionRecord;
  frameTree: SnapshotState;
  target: Extract<InteractionTarget, { kind: 'ref' }>;
  fallbackLabel: string;
  authorized: ResolvedRefNode;
}): InteractionSnapshot & { resolved: ResolvedRefNode } {
  const { session, frameTree, target, fallbackLabel, authorized } = params;
  const observation = session.snapshot;
  if (!observation || observation === frameTree) {
    return { snapshot: frameTree, resolved: authorized };
  }
  const observed = tryResolveRefNode(observation.nodes, target.ref, { fallbackLabel });
  if (
    observed &&
    localIdentitiesEqual(
      readNodeLocalIdentity(authorized.node),
      readNodeLocalIdentity(observed.node),
    )
  ) {
    return { snapshot: observation, resolved: observed };
  }
  return { snapshot: frameTree, resolved: authorized };
}

/** The runtime-ref resolver: `exact` for a resolved `@ref`, `label-fallback` for trailing-label recovery. */
export function tryResolveRefNode(
  nodes: SnapshotState['nodes'],
  refInput: string,
  options: {
    fallbackLabel: string;
  },
): ResolvedRefNode | null {
  const ref = normalizeRef(refInput);
  if (!ref) throw new AppError('INVALID_ARGS', `Invalid ref: ${refInput}`);
  const refNode = findNodeByRef(nodes, ref);
  if (isUsableResolvedNode(refNode)) {
    return buildRefResolution(ref, refNode, 'exact');
  }
  const fallbackNode =
    options.fallbackLabel.length > 0 ? findNodeByLabel(nodes, options.fallbackLabel) : null;
  if (isUsableResolvedNode(fallbackNode)) {
    return buildRefResolution(ref, fallbackNode, 'label-fallback');
  }
  return null;
}

type ResolvedRefNode = {
  ref: string;
  node: SnapshotNode;
  resolution: ResolutionDisclosure;
};

function resolveNodeTouchPoint(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  failure: {
    invalidMessage: string;
    blockedTargetLabel: string;
    blockedTargetDetails: { ref: string } | { selector: string };
  },
): Point {
  const effectiveViewport = resolveEffectiveViewportRect(node, nodes);
  const rootViewport = node.rect ? resolveViewportRect(nodes, node.rect) : null;
  const resolution = resolveInteractionTouchPoint(nodes, node, {
    bounds: [effectiveViewport, rootViewport].filter((rect) => rect !== null),
  });
  if (resolution.kind === 'resolved') return resolution.point;
  if (resolution.kind === 'invalid') {
    throw new AppError('COMMAND_FAILED', failure.invalidMessage);
  }
  throw new AppError(
    'COMMAND_FAILED',
    `${failure.blockedTargetLabel} has no parent-owned touch point outside its interactive descendants`,
    {
      reason: 'covered_by_interactive_descendants',
      ...failure.blockedTargetDetails,
      competitorRefs: resolution.competitorRefs.slice(0, 5).map((ref) => `@${ref}`),
      competitorCount: resolution.competitorRefs.length,
      hint: 'Tap the specific interactive child you intend, or use a more specific selector. Every safely tappable region of the parent belongs to one of its child controls.',
    },
  );
}

function isUsableResolvedNode(node: SnapshotNode | null | undefined): node is SnapshotNode {
  if (!node) return false;
  return resolveRectCenter(node.rect) !== null;
}

/**
 * The off-screen stage's refusal shape. Reached only through the pipeline
 * owner, and only for rows whose off-screen stage refuses — the row's decision
 * is made there, so this builds the message and never re-decides.
 */
type OffscreenStageParams = { action: InteractionAction; pipeline: SelectorPipelinePolicy };

// Selector parity for the @ref off-screen guard: without it, a selector
// resolving to a closed drawer/carousel item "succeeds" by tapping coordinates
// outside the viewport (observed as `Tapped (-161, 265)` against Bluesky's
// closed drawer) while the same node via @ref is refused.
async function assertVisibleSelectorTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  selector: string,
  { action }: OffscreenStageParams,
): Promise<SnapshotNode> {
  return await throwIfOffscreenInteractionTarget(runtime, options, node, nodes, {
    message: `Selector ${selector} resolved to an off-screen element and is not safe to ${action}`,
    details: { reason: 'offscreen_selector', selector },
    // A selector re-resolves against a fresh snapshot on every attempt, so the
    // recovery is: move the named direction, then retry THIS selector — no
    // separate snapshot step, and no @ref (a scroll expires the ref frame,
    // #1366). Naming the direction stops the wrong-way / retry-the-same-ref loop;
    // bounded steps stop the overshoot loop — a single large scroll (fling
    // momentum on iOS) can sail past the target, so a short gesture pan lands it.
    hint: (direction) =>
      `${scrollRevealClause(direction)} in small steps, retrying ${action} with the same selector after each (it re-resolves against a fresh snapshot). A single large scroll can overshoot the target; a short bounded gesture pan lands it more reliably. If it is inside a closed drawer or another tab, open that container first.`,
  });
}

async function assertVisibleRefTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  refInput: string,
  { action }: OffscreenStageParams,
): Promise<SnapshotNode> {
  return await throwIfOffscreenInteractionTarget(runtime, options, node, nodes, {
    message: `Ref ${refInput} is off-screen and not safe to ${action}`,
    details: { reason: 'offscreen_ref', ref: normalizeRef(refInput) },
    // The scroll that reveals the target expires the ref frame (#1366, ADR
    // 0014), so retrying this @ref would be rejected next. Steer to a selector,
    // which re-resolves against a fresh snapshot and bypasses the ref-frame guard.
    hint: (direction) =>
      `${scrollRevealClause(direction)} in small steps (a single large scroll can overshoot; a short bounded gesture pan lands it more reliably), then retry ${action} with a selector (e.g. text=/id=) rather than this @ref — the scroll expires the ref frame, so re-run snapshot -i before reusing any @ref.`,
  });
}

// Shared lead-in for both off-screen hints. Names the concrete `scroll <dir>`
// when the geometry gives one, and falls back to the generic phrasing when the
// target is off more than one edge in a way that has no single reveal. Callers
// append the bounded-steps guidance: a single large scroll (fling momentum on
// iOS) can sail past the target, so small bounded moves are what actually land.
function scrollRevealClause(direction: OffscreenScrollDirection | null): string {
  return direction ? `Scroll ${direction} toward it` : 'Scroll toward it';
}

/**
 * ADR 0011 native-ref preflight: `click @ref` / `fill @ref` fast paths
 * dispatch straight to `backend.tapTarget`/`fillTarget`, and a backend fast
 * path can silently "succeed" — delegation-on-error never triggers there. The
 * ref came from the stored session snapshot, so the node is already in hand:
 * run the SAME shared guards the runtime path uses against it before the
 * backend call — occlusion (`isSnapshotNodeInteractionBlocked` via
 * `assertInteractionNotBlocked`) and offscreen (`isNodeVisibleOnScreen` via
 * `assertVisibleRefTarget`) ERROR with the runtime path's exact shapes, and
 * the non-hittable annotation is returned for the fast-path result.
 *
 * Zero extra round trips by construction on the accept path: no session, no
 * stored snapshot, an unresolvable/invalid ref, or a node without a usable
 * rect all make the preflight a no-op and the fast path proceeds exactly as
 * before. Promotion to a hittable ancestor stays a runtime-path behavior —
 * the preflight never changes which element the backend acts on. Exception:
 * a would-be off-screen refusal may spend one extra iOS runner round trip
 * (#1542's double-check) before erroring — cost only on the path that was
 * about to fail anyway.
 *
 * Exported as an ADR 0011 registry anchor (interaction-guarantees.ts `via`
 * symbol, imported dynamically by the gate test); production callers reach
 * it through `dispatchNativeRefInteraction`.
 */
// fallow-ignore-next-line unused-export
export async function preflightNativeRefInteraction(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  action: InteractionAction,
): Promise<{
  targetHittable?: boolean;
  hint?: string;
  node?: SnapshotNode;
  preActionNodes?: SnapshotNode[];
}> {
  const session = await runtime.sessions.get(options.session ?? 'default');
  const nodes = session?.snapshot?.nodes;
  if (!nodes || normalizeRef(target.ref) === null) return {};
  const resolved = tryResolveRefNode(nodes, target.ref, {
    fallbackLabel: target.fallbackLabel ?? '',
  });
  if (!resolved) return {};
  // `resolvedTarget` whatever the command: its `none` promotion is what holds
  // ADR 0011's "the preflight never changes which element the backend acts on".
  const pipeline = SELECTOR_PIPELINE_POLICIES.resolvedTarget;
  // #1542: dispatches by REF, not coordinate, so no point to re-derive — but
  // evidence/annotation below still describes the returned (visible) node.
  const visibleNode = await runInteractionPipelineStages({
    policy: pipeline,
    nodes,
    node: resolved.node,
    action,
    label: `Ref ${target.ref}`,
    hooks: {
      offscreen: async (node, tree) =>
        await assertVisibleRefTarget(runtime, options, node, tree, target.ref, {
          action,
          pipeline,
        }),
    },
  });
  return {
    ...describeNonHittableTarget(visibleNode, action),
    // ADR 0012 decision 3: the guard lookup above doubles as the record-time
    // evidence source for the fast path, at zero extra capture cost.
    node: visibleNode,
    preActionNodes: nodes,
  };
}

/**
 * ADR 0011 native-ref dispatch, shared by click/fill/hover @ref: run the
 * preflight guards against the stored node, hand the ref to the backend as
 * its own element handle, and return the exact-ref result envelope. Callers
 * decide WHEN the path applies (backend capability, no non-default options,
 * no replay guard, no settle baseline); this owns only the dispatch itself so
 * the three commands cannot drift on preflight or disclosure.
 */
export async function dispatchNativeRefInteraction(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  action: InteractionAction,
  dispatch: (
    context: BackendCommandContext,
    refTarget: BackendRefTarget,
  ) => Promise<BackendActionResult>,
): Promise<
  Extract<ResolvedInteractionTarget, { kind: 'ref' }> & { backendResult?: Record<string, unknown> }
> {
  const preflight = await preflightNativeRefInteraction(runtime, options, target, action);
  const backendResult = await dispatch(toBackendContext(runtime, options), {
    kind: 'ref',
    ref: target.ref,
    ...(target.fallbackLabel ? { fallbackLabel: target.fallbackLabel } : {}),
  });
  const formattedBackendResult = toBackendResult(backendResult);
  return {
    kind: 'ref',
    target: { kind: 'ref', ref: target.ref },
    resolution: EXACT_REF_RESOLUTION,
    ...preflight,
    ...(formattedBackendResult ? { backendResult: formattedBackendResult } : {}),
  };
}

// isNodeVisibleOnScreen (not the effective-viewport form): items inside an
// off-screen scrollable container (closed drawer) must also count as
// off-screen, not just items scrolled out of an on-screen container.
//
// #1542: once the bulk tree says off-screen, the guard gives iOS one chance
// to rescue a FALSE refusal via the optional backend.confirmOffscreenTargetVisible
// hook — a stale/corrupted bulk tree can say off-screen while the app is
// visually fine (zero cost on the accept path; runs only here). A confirmed
// rescue returns the node PATCHED WITH THE LIVE RECT: the caller must act on
// that returned node, never the original, because in the frozen-bulk-tree
// manifestation the original rect can be stale even when the rescue verdict
// is correct — tapping it would silently land at the wrong coordinate. The
// hook fails closed (null) on anything short of a positive confirmation, so
// a genuine refusal, or any backend without the hook, is unchanged.
//
// Exported (not just for callers here) for ADR 0011 registry honesty:
// interaction-guarantees.ts's `offscreen` cells point their `via` at this
// function, not at isNodeVisibleOnScreen alone, since this is the actual
// end-to-end enforcement point.
export async function throwIfOffscreenInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  failure: {
    message: string;
    details: Record<string, unknown>;
    hint: (direction: OffscreenScrollDirection | null) => string;
  },
): Promise<SnapshotNode> {
  const viewport = node.rect ? resolveEffectiveViewportRect(node, nodes) : null;
  if (!node.rect || !viewport || isNodeVisibleOnScreen(node, nodes)) return node;
  const rootViewport = resolveViewportRect(nodes, node.rect);
  const liveRect = await runtime.backend.confirmOffscreenTargetVisible?.(
    toBackendContext(runtime, options),
    node,
    rootViewport,
  );
  if (liveRect) return { ...node, rect: liveRect };
  // The direction that scrolls this off-screen target into view. Named in the
  // hint (and surfaced as a machine-readable detail) so the recovery is a single
  // deterministic move instead of a guess (#1366). Derived from the same
  // boundary the rejection above used, so partial clips and off-screen
  // containers get a direction too, not just fully-scrolled-out items.
  const scrollDirection = classifyOffscreenScrollDirection(node, nodes);
  throw new AppError('COMMAND_FAILED', failure.message, {
    ...failure.details,
    rect: node.rect,
    viewport,
    ...(scrollDirection ? { scrollDirection } : {}),
    hint: failure.hint(scrollDirection),
  });
}
