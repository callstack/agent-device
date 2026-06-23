import { AppError } from '../../../utils/errors.ts';
import type { Point, SnapshotNode, SnapshotState } from '../../../utils/snapshot.ts';
import { findNodeByRef, normalizeRef } from '../../../utils/snapshot.ts';
import { resolveRectCenter } from '../../../utils/rect-center.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import {
  formatSelectorFailure,
  parseSelectorChain,
  resolveSelectorChain,
} from '../../../selectors.ts';
import { buildSelectorChainForNode } from '../../../utils/selector-build.ts';
import { findNodeByLabel, resolveRefLabel } from '../../../utils/snapshot-processing.ts';
import {
  isNodeVisibleInEffectiveViewport,
  resolveEffectiveViewportRect,
} from '../../../utils/mobile-snapshot-semantics.ts';
import { isSnapshotNodeInteractionBlocked } from '../../../utils/snapshot-occlusion.ts';
import type {
  InteractionTarget,
  PointTarget,
  ResolvedInteractionTarget,
} from '../../../contracts/interaction.ts';
import { now, toBackendContext } from '../../runtime-common.ts';
import { resolveActionableTouchResolution } from '../../../core/interaction-targeting.ts';

export type { InteractionTarget, PointTarget, ResolvedInteractionTarget };

export type InteractionAction =
  | 'click'
  | 'press'
  | 'fill'
  | 'focus'
  | 'longPress'
  | 'scroll'
  | 'swipe'
  | 'pinch';

export type CapturedSnapshot = {
  snapshot: SnapshotState;
};

type ResolveInteractionTargetParams = {
  action: InteractionAction;
  requireInteractive: boolean;
  promoteToHittableAncestor: boolean;
};

export async function resolveInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext & { target: InteractionTarget },
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  await assertSupportedInteractionSurface(runtime, options, params.action);

  if (options.target.kind === 'point') {
    return resolvePointInteractionTarget(options.target);
  }

  if (options.target.kind === 'ref') {
    return await resolveRefInteractionTarget(runtime, options, options.target, params);
  }

  return await resolveSelectorInteractionTarget(runtime, options, options.target, params);
}

function resolvePointInteractionTarget(target: PointTarget): ResolvedInteractionTarget {
  return {
    kind: 'point',
    point: { x: target.x, y: target.y },
  };
}

async function resolveRefInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'ref' }>,
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  const capture = await resolveSnapshotForRef(runtime, options, target);
  const resolved = capture.resolved;
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
    node,
    selectorChain: buildSelectorChainForNode(node, runtime.backend.platform, {
      action: params.action === 'fill' ? 'fill' : 'click',
    }),
    refLabel: resolveRefLabel(node, capture.snapshot.nodes),
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
    );
  }
  const node = params.promoteToHittableAncestor
    ? resolveActionableNodeOrThrow(capture.snapshot.nodes, resolved.node, {
        action: params.action,
        label: `Selector ${resolved.selector.raw}`,
      })
    : resolved.node;
  assertInteractionNotBlocked(node, `Selector ${resolved.selector.raw}`, params.action);
  const point = resolveNodeCenter(
    node,
    `Selector ${resolved.selector.raw} resolved to invalid bounds`,
  );
  return {
    kind: 'selector',
    point,
    target: { kind: 'selector', selector: resolved.selector.raw },
    node,
    selectorChain: buildSelectorChainForNode(node, runtime.backend.platform, {
      action: params.action === 'fill' ? 'fill' : 'click',
    }),
    refLabel: resolveRefLabel(node, capture.snapshot.nodes),
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
): Promise<CapturedSnapshot & { resolved: { ref: string; node: SnapshotNode } }> {
  const sessionName = options.session ?? 'default';
  const session = await runtime.sessions.get(sessionName);
  if (!session) throw new AppError('SESSION_NOT_FOUND', 'No active session. Run open first.');
  if (!session.snapshot) {
    throw new AppError('INVALID_ARGS', 'No snapshot in session. Run snapshot first.');
  }

  const fallbackLabel = target.fallbackLabel ?? '';
  const stored = tryResolveRefNode(session.snapshot.nodes, target.ref, {
    fallbackLabel,
  });
  if (stored) {
    return { snapshot: session.snapshot, resolved: stored };
  }

  const capture = await captureInteractionSnapshot(runtime, options, true);
  const refreshed = tryResolveRefNode(capture.snapshot.nodes, target.ref, {
    fallbackLabel,
  });
  if (!refreshed) {
    throw new AppError('COMMAND_FAILED', `Ref ${target.ref} not found or has no bounds`);
  }
  return { ...capture, resolved: refreshed };
}

function tryResolveRefNode(
  nodes: SnapshotState['nodes'],
  refInput: string,
  options: {
    fallbackLabel: string;
  },
): { ref: string; node: SnapshotNode } | null {
  const ref = normalizeRef(refInput);
  if (!ref) throw new AppError('INVALID_ARGS', `Invalid ref: ${refInput}`);
  const refNode = findNodeByRef(nodes, ref);
  if (isUsableResolvedNode(refNode)) return { ref, node: refNode };
  const fallbackNode =
    options.fallbackLabel.length > 0 ? findNodeByLabel(nodes, options.fallbackLabel) : null;
  if (isUsableResolvedNode(fallbackNode)) {
    return { ref, node: fallbackNode };
  }
  return null;
}

function resolveNodeCenter(node: SnapshotNode, message: string): Point {
  const point = resolveRectCenter(node.rect);
  if (!point) throw new AppError('COMMAND_FAILED', message);
  return point;
}

function isUsableResolvedNode(node: SnapshotNode | null | undefined): node is SnapshotNode {
  if (!node) return false;
  return resolveRectCenter(node.rect) !== null;
}

function assertVisibleRefTarget(
  node: SnapshotNode,
  nodes: SnapshotState['nodes'],
  refInput: string,
  action: InteractionAction,
): void {
  const viewport = node.rect ? resolveEffectiveViewportRect(node, nodes) : null;
  if (!node.rect || !viewport || isNodeVisibleInEffectiveViewport(node, nodes)) return;
  throw new AppError('COMMAND_FAILED', `Ref ${refInput} is off-screen and not safe to ${action}`, {
    reason: 'offscreen_ref',
    ref: normalizeRef(refInput),
    rect: node.rect,
    viewport,
    hint: `Use scroll with the direction from the off-screen summary, take a fresh snapshot, then retry ${action} with the new ref or a selector.`,
  });
}
