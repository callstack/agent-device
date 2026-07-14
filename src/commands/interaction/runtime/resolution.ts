import { AppError } from '../../../kernel/errors.ts';
import type { Point, SnapshotNode, SnapshotState } from '../../../kernel/snapshot.ts';
import { findNodeByRef, normalizeRef } from '../../../kernel/snapshot.ts';
import { resolveRectCenter } from '../../../utils/rect-center.ts';
import type {
  AgentDeviceRuntime,
  CommandContext,
  CommandSessionRecord,
} from '../../../runtime-contract.ts';
import { parseSelectorChain } from '../../../selectors/parse.ts';
import {
  formatSelectorFailure,
  resolveSelectorChain,
  selectorFailureHint,
  STALE_REF_HINT,
  type SelectorResolution,
} from '../../../selectors/index.ts';
import { buildSelectorChainForNode } from '../../../selectors/build.ts';
import {
  findNodeByLabel,
  normalizeType,
  resolveRefLabel,
} from '../../../snapshot/snapshot-processing.ts';
import {
  isNodeVisibleOnScreen,
  resolveEffectiveViewportRect,
} from '../../../snapshot/mobile-snapshot-semantics.ts';
import { containsPoint, resolveViewportRect } from '../../../utils/rect-visibility.ts';
import { isSnapshotNodeInteractionBlocked } from '../../../snapshot/snapshot-occlusion.ts';
import { truncateUtf8 } from '../../../utils/truncate-utf8.ts';
import type {
  InteractionTarget,
  PointTarget,
  ResolutionDiagnosticEntry,
  ResolutionDisclosure,
  ResolvedInteractionTarget,
} from '../../../contracts/interaction.ts';
import { now, toBackendContext } from '../../runtime-common.ts';
import { resolveActionableTouchResolution } from '../../../core/interaction-targeting.ts';
import {
  localIdentitiesEqual,
  readNodeLocalIdentity,
  readNodeStructuralDenotation,
  structuralDenotationsEqual,
  REPLAY_TARGET_GUARD_MISMATCH_REASON,
  type ReplayTargetGuardDenotation,
} from '../../../replay/target-identity-node.ts';

export type { InteractionTarget, PointTarget, ResolvedInteractionTarget };

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
    },
  );
}

export type InteractionAction =
  | 'click'
  | 'press'
  | 'fill'
  | 'focus'
  | 'longPress'
  | 'scroll'
  | 'swipe'
  | 'pinch'
  | 'pan'
  | 'fling'
  | 'rotate'
  | 'transform';

export type CapturedSnapshot = {
  snapshot: SnapshotState;
};

type ResolveInteractionTargetParams = {
  action: InteractionAction;
  requireInteractive: boolean;
  promoteToHittableAncestor: boolean;
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

async function resolveRefInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  const capture = await resolveSnapshotForRef(runtime, options, target);
  const resolved = capture.resolved;
  assertExpectedResolvedTarget(
    resolved.node,
    capture.snapshot.nodes,
    params.expectedResolvedTarget,
    params.action,
  );
  const node = params.promoteToHittableAncestor
    ? resolveActionableNodeOrThrow(capture.snapshot.nodes, resolved.node, {
        action: params.action,
        label: `Ref ${target.ref}`,
      })
    : resolved.node;
  assertInteractionNotBlocked(node, `Ref ${target.ref}`, params.action);
  assertVisibleRefTarget(node, capture.snapshot.nodes, target.ref, params.action);
  const point = resolveNodeCenter(node, `Ref ${target.ref} not found or has invalid bounds`);
  return {
    kind: 'ref',
    point,
    target: { kind: 'ref', ref: `@${resolved.ref}` },
    ...describeResolvedInteractionNode(
      runtime,
      node,
      capture.snapshot.nodes,
      params.action,
      resolved.resolution,
    ),
  };
}

// fallow-ignore-next-line complexity
async function resolveSelectorInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'selector' }>,
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  const chain = parseSelectorChain(target.selector);
  let capture = await captureInteractionSnapshot(runtime, options, params.requireInteractive);
  let resolved = resolveSelectorChain(interactableSelectorNodes(capture.snapshot.nodes), chain, {
    platform: runtime.backend.platform,
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  if ((!resolved || !resolved.node.rect) && params.requireInteractive) {
    capture = await captureInteractionSnapshot(runtime, options, false);
    resolved = resolveSelectorChain(interactableSelectorNodes(capture.snapshot.nodes), chain, {
      platform: runtime.backend.platform,
      requireRect: true,
      requireUnique: true,
      disambiguateAmbiguous: true,
    });
  }
  if (!resolved || !resolved.node.rect) {
    const covered = resolveSelectorChain(capture.snapshot.nodes, chain, {
      platform: runtime.backend.platform,
      requireRect: true,
      requireUnique: false,
    });
    if (covered?.node && isSnapshotNodeInteractionBlocked(covered.node)) {
      throw buildCoveredInteractionError({
        label: `Selector ${covered.selector.raw}`,
        node: covered.node,
        action: params.action,
        selector: covered.selector.raw,
      });
    }
    throw new AppError(
      'COMMAND_FAILED',
      formatSelectorFailure(chain, resolved?.diagnostics ?? [], { unique: true }),
      { hint: selectorFailureHint(resolved?.diagnostics ?? []) },
    );
  }
  assertExpectedResolvedTarget(
    resolved.node,
    capture.snapshot.nodes,
    params.expectedResolvedTarget,
    params.action,
  );
  const node = params.promoteToHittableAncestor
    ? resolveActionableNodeOrThrow(capture.snapshot.nodes, resolved.node, {
        action: params.action,
        label: `Selector ${resolved.selector.raw}`,
      })
    : resolved.node;
  assertInteractionNotBlocked(node, `Selector ${resolved.selector.raw}`, params.action);
  assertVisibleSelectorTarget(node, capture.snapshot.nodes, resolved.selector.raw, params.action);
  const point = resolveNodeCenter(
    node,
    `Selector ${resolved.selector.raw} resolved to invalid bounds`,
  );
  return {
    kind: 'selector',
    point,
    target: { kind: 'selector', selector: resolved.selector.raw },
    ...describeResolvedInteractionNode(
      runtime,
      node,
      capture.snapshot.nodes,
      params.action,
      buildSelectorResolutionDisclosure(resolved, capture.snapshot.nodes),
    ),
  };
}

// ADR 0012 decision 2 bounds: diagnostic strings and losing alternatives.
const RESOLUTION_DIAGNOSTIC_STRING_BYTE_CAP = 256;
const MAX_RESOLUTION_ALTERNATIVES = 5;

/** A successful `@ref` lookup names exactly one node; label recovery discloses label-fallback instead. */
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
// plus everything derived from it for the response.
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
} {
  return {
    node,
    selectorChain: buildSelectorChainForNode(node, runtime.backend.platform, {
      action: action === 'fill' ? 'fill' : 'click',
    }),
    refLabel: resolveRefLabel(node, nodes),
    ...describeNonHittableTarget(node, action),
    preActionNodes: nodes,
    resolution,
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

function interactableSelectorNodes(nodes: SnapshotState['nodes']): SnapshotState['nodes'] {
  return nodes.filter((node) => !isSnapshotNodeInteractionBlocked(node));
}

function resolveActionableNodeOrThrow(
  nodes: SnapshotState['nodes'],
  node: SnapshotNode,
  options: { action: InteractionAction; label: string },
): SnapshotNode {
  const resolution = resolveActionableTouchResolution(nodes, node);
  if (resolution.reason === 'covered') {
    throw buildCoveredInteractionError({
      label: options.label,
      node,
      action: options.action,
    });
  }
  return resolution.node;
}

function assertInteractionNotBlocked(
  node: SnapshotNode,
  label: string,
  action: InteractionAction,
): void {
  if (!isSnapshotNodeInteractionBlocked(node)) return;
  throw buildCoveredInteractionError({ label, node, action });
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
    default:
      return 'be tapped';
  }
}

export async function captureInteractionSnapshot(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  interactiveOnly: boolean,
): Promise<CapturedSnapshot> {
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
): Promise<CapturedSnapshot & { resolved: ResolvedRefNode }> {
  const sessionName = options.session ?? 'default';
  const session = await runtime.sessions.get(sessionName);
  if (!session) throw new AppError('SESSION_NOT_FOUND', 'No active session. Run open first.');
  // ADR 0014: a ref resolves against the AUTHORIZED frame tree, not the latest
  // operational observation. They share the capture object until a read-only
  // capture (e.g. Android freshness) advances `snapshot` alone; from then on the
  // frame tree is the identity authority for `@eN`.
  const frameTree = session.refFrameSnapshot ?? session.snapshot;
  if (!frameTree) {
    throw new AppError('INVALID_ARGS', 'No snapshot in session. Run snapshot first.');
  }

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
}): CapturedSnapshot & { resolved: ResolvedRefNode } {
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
    return { ref, node: refNode, resolution: EXACT_REF_RESOLUTION };
  }
  const fallbackNode =
    options.fallbackLabel.length > 0 ? findNodeByLabel(nodes, options.fallbackLabel) : null;
  if (isUsableResolvedNode(fallbackNode)) {
    return { ref, node: fallbackNode, resolution: LABEL_FALLBACK_REF_RESOLUTION };
  }
  return null;
}

type ResolvedRefNode = {
  ref: string;
  node: SnapshotNode;
  resolution: ResolutionDisclosure;
};

function resolveNodeCenter(node: SnapshotNode, message: string): Point {
  const point = resolveRectCenter(node.rect);
  if (!point) throw new AppError('COMMAND_FAILED', message);
  return point;
}

function isUsableResolvedNode(node: SnapshotNode | null | undefined): node is SnapshotNode {
  if (!node) return false;
  return resolveRectCenter(node.rect) !== null;
}

// Selector parity for the @ref off-screen guard: without it, a selector
// resolving to a closed drawer/carousel item "succeeds" by tapping coordinates
// outside the viewport (observed as `Tapped (-161, 265)` against Bluesky's
// closed drawer) while the same node via @ref is refused.
function assertVisibleSelectorTarget(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  selector: string,
  action: InteractionAction,
): void {
  throwIfOffscreenInteractionTarget(node, nodes, {
    message: `Selector ${selector} resolved to an off-screen element and is not safe to ${action}`,
    details: { reason: 'offscreen_selector', selector },
    hint: `The element is outside the visible viewport — likely inside a closed drawer, another tab, or scrolled content. Scroll toward it or open its container, take a fresh snapshot, then retry ${action}.`,
  });
}

function assertVisibleRefTarget(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  refInput: string,
  action: InteractionAction,
): void {
  throwIfOffscreenInteractionTarget(node, nodes, {
    message: `Ref ${refInput} is off-screen and not safe to ${action}`,
    details: { reason: 'offscreen_ref', ref: normalizeRef(refInput) },
    hint: `Use scroll with the direction from the off-screen summary, take a fresh snapshot, then retry ${action} with the new ref or a selector.`,
  });
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
 * Zero extra round trips by construction: no session, no stored snapshot, an
 * unresolvable/invalid ref, or a node without a usable rect all make the
 * preflight a no-op and the fast path proceeds exactly as before. Promotion
 * to a hittable ancestor stays a runtime-path behavior — the preflight never
 * changes which element the backend acts on.
 */
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
  assertInteractionNotBlocked(resolved.node, `Ref ${target.ref}`, action);
  assertVisibleRefTarget(resolved.node, nodes, target.ref, action);
  return {
    ...describeNonHittableTarget(resolved.node, action),
    // ADR 0012 decision 3: the guard lookup above doubles as the record-time
    // evidence source for the fast path, at zero extra capture cost.
    node: resolved.node,
    preActionNodes: nodes,
  };
}

// isNodeVisibleOnScreen (not the effective-viewport form): items inside an
// off-screen scrollable container (closed drawer) must also count as
// off-screen, not just items scrolled out of an on-screen container.
function throwIfOffscreenInteractionTarget(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  failure: { message: string; details: Record<string, unknown>; hint: string },
): void {
  const viewport = node.rect ? resolveEffectiveViewportRect(node, nodes) : null;
  if (!node.rect || !viewport || isNodeVisibleOnScreen(node, nodes)) return;
  throw new AppError('COMMAND_FAILED', failure.message, {
    ...failure.details,
    rect: node.rect,
    viewport,
    hint: failure.hint,
  });
}
