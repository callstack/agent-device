import { AppError } from '@agent-device/kernel/errors';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import type { SelectorResolution } from '@agent-device/selectors';
import { readinessScheduleFor } from '@agent-device/selectors/selector-pipeline-policy';
import {
  attemptSelectorResolution,
  pollForSelectorReadiness,
  type SelectorReadinessWait,
  selectorInteractionFailure,
} from './selector-readiness.ts';
import {
  captureInteractionSnapshot,
  type InteractionSnapshot,
} from './interaction-snapshot-capture.ts';
import { containsPoint } from '@agent-device/kernel/rect';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import { surfaceScopedNodes } from './post-action-surface.ts';
import type {
  InteractionTarget,
  PointTarget,
  ResolvedInteractionTarget,
  SurfaceScopedNodes,
} from '@agent-device/contracts/interaction';
import { describeKeyboardOccludedPointWarning } from './keyboard-occlusion.ts';
import { assertReplayTargetResolution } from './replay-target-guard.ts';
import type {
  InteractionAction,
  ResolveInteractionTargetParams,
} from './interaction-resolution-request.ts';
import { resolveRefInteractionTarget } from './ref-target-resolution.ts';
import {
  buildSelectorResolutionDisclosure,
  describeResolvedInteractionNode,
} from './resolution-disclosure.ts';
import {
  assertVisibleSelectorTarget,
  runInteractionPipelineStages,
} from './target-visibility-stages.ts';
import { resolveNodeTouchPoint } from './resolution-touch-point.ts';

export type { InteractionTarget, ResolvedInteractionTarget };

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

/**
 * The one warning a raw-coordinate tap can earn from the last-known tree: the point is outside the
 * viewport that tree captured, or the keyboard it captured covers the point. Both are disclosures,
 * not refusals — see `describeKeyboardOccludedPointWarning`.
 */
async function resolvePointTargetWarning(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: PointTarget,
): Promise<string | undefined> {
  const session = await runtime.sessions.get(options.session ?? 'default');
  const snapshot = session?.snapshot;
  const nodes = snapshot?.nodes;
  if (!nodes) return undefined;
  const point = { x: target.x, y: target.y };

  // The point carries no extent, so the zero-area rect only keys the viewport lookup off it.
  const viewport = createSnapshotVisibility(nodes).resolveViewport({
    x: point.x,
    y: point.y,
    width: 0,
    height: 0,
  });
  if (viewport && !containsPoint(viewport, point.x, point.y)) {
    return `Coordinates (${point.x}, ${point.y}) are outside the last-known viewport (${viewport.width}x${viewport.height}). The tap will be forwarded anyway; take a fresh snapshot if the screen changed.`;
  }
  return describeKeyboardOccludedPointWarning({
    nodes,
    point,
    viewport,
    ...(snapshot?.keyboard ? { keyboard: snapshot.keyboard } : {}),
  });
}

async function resolvePointInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: PointTarget,
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  const warning = await resolvePointTargetWarning(runtime, options, target);
  if (!params.captureEvidenceBaseline) {
    return {
      kind: 'point',
      point: { x: target.x, y: target.y },
      ...(warning ? { warning } : {}),
    };
  }
  const baseline = await tryCaptureEvidenceBaseline(runtime, options);
  return {
    kind: 'point',
    point: { x: target.x, y: target.y },
    ...(baseline ? { preAction: baseline } : {}),
    ...(warning ? { warning } : {}),
  };
}

async function tryCaptureEvidenceBaseline(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
): Promise<SurfaceScopedNodes | undefined> {
  try {
    const capture = await captureInteractionSnapshot(runtime, options, true);
    return surfaceScopedNodes(capture.snapshot);
  } catch {
    // Evidence is best-effort: a failed baseline capture must not fail the
    // action itself. Post-action evidence (if any) will simply omit
    // changedFromBefore.
    return undefined;
  }
}

async function resolveSelectorInteractionTarget(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  target: Extract<InteractionTarget, { kind: 'selector' }>,
  params: ResolveInteractionTargetParams,
): Promise<ResolvedInteractionTarget> {
  const selectorExpression = target.selector;
  let capture: InteractionSnapshot;
  let resolved: SelectorResolution | null;
  let readiness: SelectorReadinessWait | undefined;
  const readinessSchedule = readinessScheduleFor(params.pipeline.poll, params.readinessTimeoutMs);
  if (!readinessSchedule) {
    const attempt = await attemptSelectorResolution(runtime, options, selectorExpression, params);
    capture = attempt.capture;
    resolved = attempt.resolved;
    if (!resolved || !resolved.node.rect) {
      throw await selectorInteractionFailure({
        runtime,
        nodes: capture.snapshot.nodes,
        selectorExpression,
        action: params.action,
        resolved,
      });
    }
  } else {
    const ready = await pollForSelectorReadiness(
      runtime,
      options,
      selectorExpression,
      params,
      readinessSchedule,
    );
    capture = ready.capture;
    resolved = ready.resolved;
    readiness = ready.readiness;
  }
  // #1542: see the ref-target twin in ref-target-resolution.ts.
  const selected = resolved;
  const { node: visibleNode, tapPoint: point } = await runInteractionPipelineStages({
    policy: params.pipeline,
    nodes: capture.snapshot.nodes,
    ...(capture.snapshot.keyboard ? { keyboard: capture.snapshot.keyboard } : {}),
    node: selected.node,
    action: params.action,
    label: `Selector ${selected.selector}`,
    hooks: {
      onResolved: (node, tree) => assertReplayTargetResolution(node, tree, params),
      offscreen: async (node, tree) =>
        await assertVisibleSelectorTarget(runtime, options, node, tree, selected.selector, params),
    },
    resolveTapPoint: (node) =>
      resolveNodeTouchPoint(node, capture.snapshot.nodes, {
        invalidMessage: `Selector ${resolved.selector} resolved to invalid bounds`,
        blockedTargetLabel: `Selector ${selectorExpression}`,
        blockedTargetDetails: { selector: selectorExpression },
      }),
  });
  return {
    kind: 'selector',
    point,
    target: { kind: 'selector', selector: resolved.selector },
    ...(readiness ? { readiness } : {}),
    ...describeResolvedInteractionNode(
      runtime,
      visibleNode,
      surfaceScopedNodes(capture.snapshot),
      params.action,
      buildSelectorResolutionDisclosure(resolved, capture.snapshot.nodes),
    ),
  };
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
