import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  SELECTOR_RESOLUTION_POLICIES,
  type SelectorResolutionPolicy,
} from '@agent-device/selectors';
import { isSnapshotNodeInteractionBlocked } from '../snapshot/snapshot-occlusion.ts';
import {
  isRootInteractionContainer,
  resolveActionableTouchResolution,
} from './interaction-targeting.ts';

/**
 * The structural half of the per-caller selector policy (#1656), companion to
 * the ambiguity matrix in `@agent-device/selectors` (#1630/#1649).
 *
 * A caller names ONE row here and gets its whole pipeline shape: which
 * ambiguity contract resolves the selector (`resolution`, the matrix row), and
 * which structural stages run around that resolution — occlusion, off-screen,
 * hittable-ancestor promotion, and the poll budget. Those four stages used to
 * be per-caller pipeline code, so "`is` never consults occlusion" was true only
 * as an ABSENCE of code: nothing declared it and nothing could fail if a later
 * edit added it. Here it is a value, and the stage runners below are the only
 * door to each stage, so the value decides.
 *
 * Rule of this table, inherited from the #1649 review: a row may only declare
 * what these runners enforce. Every field is read by the runner named in its
 * doc comment, and every row — including the ones whose stages are skips — is
 * driven through those runners in selector-pipeline-policy.test.ts, so flipping
 * any cell changes an assertion. Do not add a column until its runner exists;
 * an unconsumed column reads as truth while being free to drift.
 */

/**
 * Consumed by `selectorPipelineCandidates` (which nodes may match at all) and
 * by `resolveSelectorPipelineTarget` (whether a covered target refuses).
 *
 * - `exclude-and-refuse` — covered nodes never become candidates, AND a covered
 *   target refuses. Acting paths: tapping something an overlay covers is the
 *   wrong-element bug the annotation exists to prevent.
 * - `refuse` — candidacy is unfiltered, but a covered target refuses. Mutating
 *   `find`, whose match ranking wants to SEE covered nodes, and the post-miss
 *   diagnosis probe, whose whole question is "matched but covered?".
 * - `ignore` — never consulted. Reads and `wait` answer about the tree as
 *   captured; a covered element still exists, still has text, and still
 *   satisfies a presence wait.
 */
export type SelectorOcclusionStage = 'exclude-and-refuse' | 'refuse' | 'ignore';

/**
 * Consumed by `throwIfOffscreenInteractionTarget`
 * (commands/interaction/runtime/resolution.ts), the end-to-end enforcement
 * point including the iOS live-rect rescue probe (#1542).
 *
 * - `refuse` — a target whose tap point lies outside the viewport refuses
 *   instead of tapping coordinates nothing occupies.
 * - `ignore` — reads, `wait`, the diagnosis probe, and mutating `find` (whose
 *   click/fill re-enter the interaction leaf, where the acting row refuses).
 */
export type SelectorOffscreenStage = 'refuse' | 'ignore';

/**
 * Consumed by `resolveSelectorPipelineTarget`.
 *
 * - `hittable-ancestor` — retarget a non-tappable match to the actionable node
 *   that owns it (`resolveActionableTouchResolution`). Tap-shaped commands.
 * - `hittable-ancestor-below-root` — the same promotion, except a promotion
 *   that lands on the viewport root container keeps the original match:
 *   `find` ranks matches across the whole tree, and a root-sized target is a
 *   tap on "the screen", not on the thing that matched.
 * - `none` — act on the resolved node itself. `fill`/`focus` need the element
 *   that takes the text or the focus, gesture endpoints name contact points,
 *   and reads must not answer about an ancestor the caller did not select.
 */
export type SelectorPromotionStage = 'hittable-ancestor' | 'hittable-ancestor-below-root' | 'none';

/** The poll budget of a row that polls, consumed by `selectorPollBudget`. */
export type SelectorPollBudget = {
  /** Used when the caller passes no explicit timeout. */
  defaultTimeoutMs: number;
  /** Delay between polls, clamped to the remaining budget. */
  intervalMs: number;
};

/**
 * Consumed by `selectorPollBudget`, which `createWaitPolling` derives its
 * deadline and sleep from. `'none'` is a real answer, not an omission: a row
 * that resolves against one capture has no polling contract, and asking for
 * its budget is a bug rather than a defaulting opportunity.
 */
export type SelectorPollStage = SelectorPollBudget | 'none';

export type SelectorPipelinePolicy = {
  /** The ambiguity contract this row resolves under (#1630). */
  resolution: SelectorResolutionPolicy;
  occlusion: SelectorOcclusionStage;
  offscreen: SelectorOffscreenStage;
  promotion: SelectorPromotionStage;
  poll: SelectorPollStage;
};

/** Shared by both wait loops; they differ only in what each poll resolves. */
const WAIT_POLL_BUDGET: SelectorPollBudget = { defaultTimeoutMs: 10_000, intervalMs: 300 };

export const SELECTOR_PIPELINE_POLICIES = {
  /** `click`/`press`/`longpress`: the tap lands on the actionable owner of the match. */
  promotedTarget: {
    resolution: SELECTOR_RESOLUTION_POLICIES.act,
    occlusion: 'exclude-and-refuse',
    offscreen: 'refuse',
    promotion: 'hittable-ancestor',
    poll: 'none',
  },
  /**
   * `fill`/`focus`/`scroll`/gesture endpoints, and the native-ref preflight —
   * every acting path that must keep the element it resolved. The preflight
   * shares this row deliberately: it guards the backend fast path without ever
   * changing which element the backend acts on (ADR 0011).
   */
  resolvedTarget: {
    resolution: SELECTOR_RESOLUTION_POLICIES.act,
    occlusion: 'exclude-and-refuse',
    offscreen: 'refuse',
    promotion: 'none',
    poll: 'none',
  },
  /** The post-miss probe deciding "no match" vs "matched but covered". */
  coveredDiagnosis: {
    resolution: SELECTOR_RESOLUTION_POLICIES.actCoveredDiagnosis,
    occlusion: 'refuse',
    offscreen: 'ignore',
    promotion: 'none',
    poll: 'none',
  },
  /** `get text`. */
  readText: {
    resolution: SELECTOR_RESOLUTION_POLICIES.readText,
    occlusion: 'ignore',
    offscreen: 'ignore',
    promotion: 'none',
    poll: 'none',
  },
  /** `is` non-exists predicates and `get attrs`. */
  readUnique: {
    resolution: SELECTOR_RESOLUTION_POLICIES.readUnique,
    occlusion: 'ignore',
    offscreen: 'ignore',
    promotion: 'none',
    poll: 'none',
  },
  /** `is exists` and find's read-only actions. */
  readAny: {
    resolution: SELECTOR_RESOLUTION_POLICIES.readAny,
    occlusion: 'ignore',
    offscreen: 'ignore',
    promotion: 'none',
    poll: 'none',
  },
  /** `find <q> wait`: the read row above, re-resolved under the wait budget. */
  findWait: {
    resolution: SELECTOR_RESOLUTION_POLICIES.readAny,
    occlusion: 'ignore',
    offscreen: 'ignore',
    promotion: 'none',
    poll: WAIT_POLL_BUDGET,
  },
  /** `wait` (selector and text targets). */
  wait: {
    resolution: SELECTOR_RESOLUTION_POLICIES.wait,
    occlusion: 'ignore',
    offscreen: 'ignore',
    promotion: 'none',
    poll: WAIT_POLL_BUDGET,
  },
  /** Mutating `find` (#1625). */
  findAct: {
    resolution: SELECTOR_RESOLUTION_POLICIES.findAct,
    occlusion: 'refuse',
    offscreen: 'ignore',
    promotion: 'hittable-ancestor-below-root',
    poll: 'none',
  },
} as const satisfies Record<string, SelectorPipelinePolicy>;

export type SelectorPipelinePolicyName = keyof typeof SELECTOR_PIPELINE_POLICIES;

/**
 * The rows an acting interaction may consume. Naming them as a type keeps
 * `resolveInteractionTarget` from being pointed at a read row, which would
 * silently drop the occlusion and off-screen stages from a device action.
 */
export type ActingPipelinePolicy = (typeof SELECTOR_PIPELINE_POLICIES)[
  | 'promotedTarget'
  | 'resolvedTarget'];

/** Stage 1: the nodes this row lets a selector match against. */
export function selectorPipelineCandidates(
  policy: SelectorPipelinePolicy,
  nodes: SnapshotNode[],
): SnapshotNode[] {
  if (policy.occlusion !== 'exclude-and-refuse') return nodes;
  return nodes.filter((node) => !isSnapshotNodeInteractionBlocked(node));
}

/**
 * Stage 2, post-resolution: promotion, then the occlusion verdict on what
 * promotion produced — the order every acting caller ran by hand.
 *
 * `occluded` carries the node to NAME in the refusal, which is the promotion
 * input when the match itself is covered (promotion declines to retarget away
 * from a covered node) and the promotion output otherwise. The refusal shape
 * stays with the caller: the same verdict is a thrown interaction error, a
 * daemon response, or a diagnosis, and those are not interchangeable.
 */
export type SelectorPipelineTarget =
  | { kind: 'target'; node: SnapshotNode }
  | { kind: 'occluded'; node: SnapshotNode };

export function resolveSelectorPipelineTarget(
  policy: SelectorPipelinePolicy,
  nodes: SnapshotNode[],
  node: SnapshotNode,
): SelectorPipelineTarget {
  const promoted = promoteSelectorTarget(policy.promotion, nodes, node);
  if (policy.occlusion === 'ignore') return { kind: 'target', node: promoted.node };
  if (promoted.covered || isSnapshotNodeInteractionBlocked(promoted.node)) {
    return { kind: 'occluded', node: promoted.node };
  }
  return { kind: 'target', node: promoted.node };
}

function promoteSelectorTarget(
  stage: SelectorPromotionStage,
  nodes: SnapshotNode[],
  node: SnapshotNode,
): { node: SnapshotNode; covered: boolean } {
  if (stage === 'none') return { node, covered: false };
  const resolution = resolveActionableTouchResolution(nodes, node);
  if (resolution.reason === 'covered') return { node: resolution.node, covered: true };
  if (
    stage === 'hittable-ancestor-below-root' &&
    isRootInteractionContainer(resolution.node, nodes[0]) &&
    node.rect
  ) {
    return { node, covered: false };
  }
  return { node: resolution.node, covered: false };
}

/** Stage 3 is `throwIfOffscreenInteractionTarget`; this is the decision it reads. */
export function selectorPipelineRefusesOffscreen(policy: SelectorPipelinePolicy): boolean {
  return policy.offscreen === 'refuse';
}

/** Stage 4: the poll budget, for the rows that have one. */
export function selectorPollBudget(policy: SelectorPipelinePolicy): SelectorPollBudget {
  if (policy.poll === 'none') {
    throw new Error(
      'selector pipeline row resolves against one capture and declares no poll budget',
    );
  }
  return policy.poll;
}
