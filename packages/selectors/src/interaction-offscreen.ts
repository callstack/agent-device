import { shellQuote } from '@agent-device/kernel/device-shell';
import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import { normalizeRef, type Rect, type SnapshotNode } from '@agent-device/kernel/snapshot';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import {
  classifyOffscreenScrollDirection,
  type OffscreenScrollDirection,
} from '@agent-device/capture-kit/mobile-snapshot-semantics';
import type { InteractionAction } from './interaction-action.ts';

/**
 * The one off-screen rule every element-targeted dispatch applies: the acting runtime paths through
 * `throwIfOffscreenInteractionTarget`, and `find <locator> focus|type`, which dispatches its point
 * itself.
 *
 * Full on-screen visibility (not only the effective-viewport form): items inside an off-screen
 * scrollable container (closed drawer) must also count as off-screen, not just items scrolled out
 * of an on-screen container.
 *
 * #1542: once the bulk tree says off-screen, the caller's live read gets one chance to rescue a
 * FALSE refusal - a stale/corrupted bulk tree can say off-screen while the app is visually fine
 * (zero cost on the accept path; runs only here). A confirmed rescue returns the node PATCHED WITH
 * THE LIVE RECT: the caller must act on that returned node, never the original, because in the
 * frozen-bulk-tree manifestation the original rect can be stale even when the rescue verdict is
 * correct. Without a live read, or when it does not confirm, the refusal is unchanged.
 */
export async function throwIfOffscreenTarget<TNode extends SnapshotNode>(
  node: TNode,
  nodes: SnapshotNode[],
  failure: {
    message: string;
    details: Record<string, unknown>;
    hint: (direction: OffscreenScrollDirection | null) => string;
  },
  /**
   * The optional live, tree-independent read that may overturn the verdict (#1542). It answers the
   * target's live rect only on a positive confirmation, and `null` on anything else.
   */
  confirmVisible?: (node: SnapshotNode, rootViewport: Rect | null) => Promise<Rect | null>,
): Promise<TNode> {
  const visibility = createSnapshotVisibility(nodes);
  const viewport = node.rect ? visibility.resolveEffectiveViewport(node) : null;
  if (!node.rect || !viewport || visibility.isVisibleOnScreen(node)) return node;
  const rootViewport = visibility.resolveViewport(node.rect);
  const liveRect = await confirmVisible?.(node, rootViewport);
  if (liveRect) return { ...node, rect: liveRect, hittable: true };
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

// Selector parity for the @ref off-screen guard: without it, a selector
// resolving to a closed drawer/carousel item "succeeds" by tapping coordinates
// outside the viewport (observed as `Tapped (-161, 265)` against Bluesky's
// closed drawer) while the same node via @ref is refused.
export function offscreenSelectorFailure(
  selector: string,
  action: InteractionAction,
): Parameters<typeof throwIfOffscreenTarget>[2] {
  return {
    message: `Selector ${selector} resolved to an off-screen element and is not safe to ${action}`,
    details: { reason: 'offscreen_selector', selector },
    // A selector re-resolves against a fresh snapshot on every attempt, so the
    // recovery is: move the named direction, then retry THIS selector - no
    // separate snapshot step, and no @ref (a scroll expires the ref frame,
    // #1366). `--until` is that whole loop as one command: it checks the same
    // selector between passes, which is also what keeps a large step from
    // overshooting, so the hint no longer has to trade distance for accuracy.
    hint: (direction) =>
      `${scrollRevealClause(direction, selector)} then retry ${action} with the same selector. --until checks the selector between passes, so it stops on the target rather than sailing past it. If it is inside a closed drawer or another tab, open that container first.`,
  };
}

export function offscreenRefFailure(
  refInput: string,
  action: InteractionAction,
): Parameters<typeof throwIfOffscreenTarget>[2] {
  return {
    message: `Ref ${refInput} is off-screen and not safe to ${action}`,
    details: { reason: 'offscreen_ref', ref: normalizeRef(refInput) },
    // The scroll that reveals the target expires the ref frame (#1366, ADR
    // 0014), so retrying this @ref would be rejected next. Steer to a selector,
    // which re-resolves against a fresh snapshot and bypasses the ref-frame guard
    // - and which `--until` can then check between passes.
    hint: (direction) =>
      `${scrollRevealClause(direction, null)} then retry ${action} with a selector (e.g. text=/id=) rather than this @ref — the scroll expires the ref frame, so re-run snapshot -i before reusing any @ref.`,
  };
}

/**
 * Shared lead-in for both off-screen hints: the one command that reveals the target.
 *
 * When the geometry names a direction AND the caller has a selector to check, this is a complete
 * `scroll <dir> --until <selector>` - one request that stops on the target instead of the
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
  return `Run scroll ${direction} --until ${shellQuote(selector)} to bring it on screen,`;
}
