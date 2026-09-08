import {
  SELECTOR_RESOLUTION_POLICIES,
  type SelectorResolutionPolicy,
} from '@agent-device/selectors';

/**
 * The structural half of the per-caller selector policy (#1656), companion to
 * the ambiguity matrix in `@agent-device/selectors` (#1630/#1649).
 *
 * A caller names ONE row here and gets its whole pipeline shape: which
 * ambiguity contract resolves the selector (`resolution`, the matrix row), and
 * which structural stages run around that resolution — occlusion, off-screen,
 * hittable-ancestor promotion, and the poll budget. The runners below are the
 * only door to each stage, so a row that skips one still says so as a value:
 * making `is` consult occlusion means editing this table, not adding a call.
 *
 * A row may only declare what these runners enforce (#1649 review). Every row,
 * skips included, is driven through every runner in
 * selector-pipeline-policy.test.ts, so flipping any cell changes an assertion —
 * add a column only once a runner reads it.
 */

/**
 * Read by the pipeline owner's candidacy stage (which nodes may match at all)
 * and by its node stages (whether a covered target refuses).
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
 * Read by the pipeline owner's promotion stage.
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

/** The poll budget of a row that polls, read by `selectorPollBudget`. */
export type SelectorPollBudget = {
  /** Used when the caller passes no explicit timeout. */
  defaultTimeoutMs: number;
  /** Delay between polls, clamped to the remaining budget. */
  intervalMs: number;
};

/**
 * Consumed by `selectorPollBudget`, which `createWaitPolling` derives its
 * deadline and sleep from. `'none'` is an answer, not an omission: a row that
 * resolves against one capture has no polling contract, so asking for its
 * budget is a caller bug — never a place to default one in.
 */
export type SelectorPollStage = SelectorPollBudget | 'none';

/**
 * A row whose result is the candidate SET, not a target: `find <q> list`.
 * Only two stages can apply — which nodes are candidates, and how the matches
 * are gathered — so those are the only two it may declare. Promotion, the
 * off-screen guard, and a poll budget all presuppose a single element to
 * retarget, keep on screen, or wait for; a listing has none, and declaring
 * them here would be a claim no listing flow could execute (#1656 review).
 *
 * The narrower shape is load-bearing, not documentation: `runNodePipelineStages`
 * and `selectorPollBudget` take the full row, so handing them a listing row is
 * a compile error rather than a silently skipped stage.
 */
export type SelectorListPolicy = {
  /** The ambiguity contract this row resolves under (#1630). */
  resolution: SelectorResolutionPolicy;
  occlusion: SelectorOcclusionStage;
};

/** A row whose result is ONE target, and therefore runs the node stages too. */
export type SelectorPipelinePolicy = SelectorListPolicy & {
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
  /** `is` predicates other than `exists`/`absent`, and `get attrs`. */
  readUnique: {
    resolution: SELECTOR_RESOLUTION_POLICIES.readUnique,
    occlusion: 'ignore',
    offscreen: 'ignore',
    promotion: 'none',
    poll: 'none',
  },
  /** `is exists`/`absent` and find's read-only actions. */
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
  /** `find <q> list`: enumerate matches; never narrows, never acts. */
  readList: {
    resolution: SELECTOR_RESOLUTION_POLICIES.readList,
    occlusion: 'ignore',
  },
  /** Mutating `find` (#1625). */
  findAct: {
    resolution: SELECTOR_RESOLUTION_POLICIES.findAct,
    occlusion: 'refuse',
    offscreen: 'ignore',
    promotion: 'hittable-ancestor-below-root',
    poll: 'none',
  },
  /** `screenshot --crop-on`: crops the capture to the resolved node's frame. */
  cropTarget: {
    resolution: SELECTOR_RESOLUTION_POLICIES.cropTarget,
    occlusion: 'ignore',
    offscreen: 'ignore',
    promotion: 'none',
    poll: 'none',
  },
} as const satisfies Record<string, SelectorPipelinePolicy | SelectorListPolicy>;

export type SelectorPipelinePolicyName = keyof typeof SELECTOR_PIPELINE_POLICIES;

/**
 * The two questions a row asks the engine, derived from its ambiguity contract
 * rather than from a hand-kept list of row names: `reject-candidates` rows go
 * through `listSelectorPipelineMatches` (the caller narrows or refuses), every
 * other row through `resolveSelectorPipeline`. Pointing a route at the wrong
 * family is a compile error, so a row cannot quietly change which door it uses.
 */
type PipelineRow = (typeof SELECTOR_PIPELINE_POLICIES)[SelectorPipelinePolicyName];

export type CandidateSetPipelinePolicy = Extract<
  PipelineRow,
  { resolution: { ambiguity: 'reject-candidates' } }
>;

export type SingleTargetPipelinePolicy = Exclude<PipelineRow, CandidateSetPipelinePolicy>;

/**
 * The rows an acting interaction may consume. Naming them as a type keeps
 * `resolveInteractionTarget` from being pointed at a read row, which would
 * drop the occlusion and off-screen stages from a device action.
 */
export type ActingPipelinePolicy = (typeof SELECTOR_PIPELINE_POLICIES)[
  | 'promotedTarget'
  | 'resolvedTarget'];
