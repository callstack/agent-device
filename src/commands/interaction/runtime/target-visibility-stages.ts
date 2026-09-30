import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import type {
  Point,
  SnapshotKeyboardBandFact,
  SnapshotNode,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { normalizeRef } from '@agent-device/kernel/snapshot';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import {
  runNodePipelineStages,
  type SelectorPipelineHooks,
} from '@agent-device/selectors/selector-pipeline';
import type { SelectorPipelinePolicy } from '@agent-device/selectors/selector-pipeline-policy';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import {
  classifyOffscreenScrollDirection,
  type OffscreenScrollDirection,
} from '@agent-device/capture-kit/mobile-snapshot-semantics';
import { toBackendContext } from '../../runtime-common.ts';
import { assertTapTargetClearOfVisibleKeyboard } from './keyboard-occlusion.ts';
import { interactionVerb } from './interaction-verb.ts';
import type { InteractionAction } from './interaction-resolution-request.ts';

/**
 * The one construction site for "covered by another visible element" refusals, shared by the
 * node-stage runner below (ref, selector, native-ref preflight) and `selector-readiness.ts`'s
 * covered-target diagnosis probe.
 */
export function buildCoveredInteractionError(params: {
  label: string;
  node: SnapshotNode;
  action: InteractionAction;
  selector?: string;
}): AppError {
  return discloseDispatch(
    new AppError(
      'COMMAND_FAILED',
      `${params.label} is covered by another visible element and cannot ${interactionVerb(params.action)} safely`,
      {
        reason: INTERACTION_ERROR_REASONS.targetCovered,
        hint: 'Use a different visible target, scroll it clear of the overlay, or inspect with snapshot/screenshot before retrying.',
        ...(params.selector ? { selector: params.selector } : {}),
        ref: `@${params.node.ref}`,
        interactionBlocked: params.node.interactionBlocked,
      },
    ),
    'no',
  );
}

/**
 * Every node stage this action's row declares, plus the covered and keyboard refusals the
 * interaction runtime owns. Which stages run is the row's decision; every acting path — selector,
 * ref, and the native-ref preflight — enters them here, which is what keeps the native-ref fast
 * path from succeeding on a target the shared rules would refuse.
 *
 * Each path hands in the resolver that produces the point it taps with, and taps the point that
 * comes back, so the keyboard guard measures the coordinate the interaction is actually made of and no
 * path derives a second one. A path whose point can fail to exist — the native-ref fast path taps by
 * ref, reading the rect center the platform aims at — says so in its resolver's return type.
 */
export async function runInteractionPipelineStages<TPoint extends Point | null>(params: {
  policy: SelectorPipelinePolicy;
  nodes: SnapshotState['nodes'];
  /** The keyboard band `nodes`' capture measured, when it measured one (#2660). */
  keyboard?: SnapshotKeyboardBandFact;
  node: SnapshotNode;
  action: InteractionAction;
  label: string;
  hooks: SelectorPipelineHooks;
  resolveTapPoint: (node: SnapshotNode) => TPoint;
}): Promise<{ node: SnapshotNode; tapPoint: TPoint }> {
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
  const tapPoint = params.resolveTapPoint(target.node);
  assertTapTargetClearOfVisibleKeyboard({
    nodes: params.nodes,
    node: target.node,
    action: params.action,
    label: params.label,
    ...(params.keyboard ? { keyboard: params.keyboard } : {}),
    tapPoint,
  });
  return { node: target.node, tapPoint };
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
export async function assertVisibleSelectorTarget(
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
    // #1366). `--until` is that whole loop as one command: it checks the same
    // selector between passes, which is also what keeps a large step from
    // overshooting, so the hint no longer has to trade distance for accuracy.
    hint: (direction) =>
      `${scrollRevealClause(direction, selector)} then retry ${action} with the same selector. --until checks the selector between passes, so it stops on the target rather than sailing past it. If it is inside a closed drawer or another tab, open that container first.`,
  });
}

export async function assertVisibleRefTarget(
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
    // which re-resolves against a fresh snapshot and bypasses the ref-frame guard
    // — and which `--until` can then check between passes.
    hint: (direction) =>
      `${scrollRevealClause(direction, null)} then retry ${action} with a selector (e.g. text=/id=) rather than this @ref — the scroll expires the ref frame, so re-run snapshot -i before reusing any @ref.`,
  });
}

/**
 * Shared lead-in for both off-screen hints: the one command that reveals the target.
 *
 * When the geometry names a direction AND the caller has a selector to check, this is a complete
 * `scroll <dir> --until <selector>` — one request that stops on the target instead of the
 * scroll-then-look-again loop the hint used to prescribe. Without a selector to check (an @ref
 * refusal) or without a single reveal direction (off more than one edge), it degrades to naming
 * the move and leaves the stop condition to the caller's own next step.
 */
function scrollRevealClause(
  direction: OffscreenScrollDirection | null,
  selector: string | null,
): string {
  if (!direction) return 'Scroll toward it,';
  if (!selector) return `Scroll ${direction} toward it,`;
  return `Run scroll ${direction} --until '${selector}' to bring it on screen,`;
}

// Full on-screen visibility (not only the effective-viewport form): items inside an
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
// function, not at the contracts predicate alone, since this is the actual
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
  const visibility = createSnapshotVisibility(nodes);
  const viewport = node.rect ? visibility.resolveEffectiveViewport(node) : null;
  if (!node.rect || !viewport || visibility.isVisibleOnScreen(node)) return node;
  const rootViewport = visibility.resolveViewport(node.rect);
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
  const scrollDirection = classifyOffscreenScrollDirection(node, visibility);
  throw discloseDispatch(
    new AppError('COMMAND_FAILED', failure.message, {
      ...failure.details,
      rect: node.rect,
      viewport,
      ...(scrollDirection ? { scrollDirection } : {}),
      hint: failure.hint(scrollDirection),
    }),
    'no',
  );
}
