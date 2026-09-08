import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { SelectorChainMatchList, SelectorMatchOptions } from '@agent-device/selectors';
import {
  listSelectorChainMatches,
  resolveSelectorChainWithPolicy,
} from '@agent-device/selectors/engine';
import { isSnapshotNodeInteractionBlocked } from '@agent-device/capture-kit/snapshot-occlusion';
import {
  isRootInteractionContainer,
  resolveActionableTouchResolution,
} from './interaction-targeting.ts';
import type {
  CandidateSetPipelinePolicy,
  SelectorListPolicy,
  SelectorPipelinePolicy,
  SelectorPollBudget,
  SelectorPromotionStage,
  SingleTargetPipelinePolicy,
} from './selector-pipeline-policy.ts';

/**
 * The owner of selector resolution (#1656). Every native route reaches the
 * matching engine and the structural stages ONLY through the entries below,
 * which take a policy row and run what it declares — including the stages it
 * declares as skips. The stage functions themselves are private to this
 * module, so a caller cannot run three stages and forget the fourth, and
 * cannot pair one row's candidate set with another row's ambiguity contract:
 * the row enters once, at the top.
 *
 * That containment is what makes a cell falsifiable. A route that composes the
 * stages itself can declare `promotion: 'none'` and be believed without
 * executing anything, which is true of the table and unprovable in production;
 * because every route runs its row here instead of re-deriving it, flipping any
 * cell changes what `get`, `is`, `wait`, `find`, `click`, and `fill` do.
 * `scripts/layering/selector-pipeline-ownership.ts` keeps the raw engine
 * unreachable from anywhere else, so that stays true.
 *
 * Three entries, because the rows genuinely ask two different questions of the
 * engine and one route family never asks it at all:
 * - `resolveSelectorPipeline` — rows that want ONE target (reads, `wait`, the
 *   covered-diagnosis probe).
 * - `listSelectorPipelineMatches` — `reject-candidates` rows, whose contract is
 *   that the caller sees every candidate and narrows or refuses explicitly.
 *   A row whose RESULT is the candidate set (`find <q> list`) declares only the
 *   two stages a listing can run, so the node-stage entries below reject it at
 *   the type level rather than skipping stages it claimed.
 * - `runNodePipelineStages` — the node stages for a target that came from a
 *   non-chain matcher (`@ref` lookup, find's fuzzy locator) or from a narrowed
 *   candidate set. Not a bypass: it runs every stage the row declares.
 */

export type SelectorPipelineHooks = {
  /**
   * Runs on the resolution winner BEFORE promotion — the replay identity guard
   * (ADR 0012 step 4), which must compare the node the selector actually bound
   * to, not the container promotion may retarget to.
   */
  onResolved?: (node: SnapshotNode, nodes: SnapshotNode[]) => void;
  /**
   * The off-screen stage's refusal. Required by rows declaring
   * `offscreen: 'refuse'` and never called for rows that ignore it, so a row
   * flipped to refuse without giving its route a refusal shape fails loudly
   * instead of silently observing.
   */
  offscreen?: (node: SnapshotNode, nodes: SnapshotNode[]) => Promise<SnapshotNode>;
};

export type SelectorPipelineTarget =
  | { kind: 'target'; node: SnapshotNode }
  | { kind: 'occluded'; node: SnapshotNode };

export type SelectorPipelineOutcome =
  | { kind: 'none' }
  | { kind: 'ambiguous'; selector: string; selectorIndex: number; matchedNodes: SnapshotNode[] }
  /** `selector` is the ALTERNATIVE that matched, which is what a refusal names. */
  | { kind: 'occluded'; node: SnapshotNode; selector: string }
  | {
      kind: 'target';
      node: SnapshotNode;
      selector: string;
      selectorIndex: number;
      matches: number;
      matchedNodes: SnapshotNode[];
    };

/** Rows that resolve one target: candidacy, ambiguity, then every node stage. */
export async function resolveSelectorPipeline(
  policy: SingleTargetPipelinePolicy,
  nodes: SnapshotNode[],
  selector: string,
  match: SelectorMatchOptions,
  hooks: SelectorPipelineHooks = {},
): Promise<SelectorPipelineOutcome> {
  const outcome = resolveSelectorChainWithPolicy(
    pipelineCandidates(policy, nodes),
    selector,
    policy.resolution,
    match,
  );
  if (outcome.kind === 'none') return { kind: 'none' };
  if (outcome.kind === 'ambiguous') {
    return {
      kind: 'ambiguous',
      selector: outcome.selector,
      selectorIndex: outcome.selectorIndex,
      matchedNodes: outcome.matchedNodes,
    };
  }
  const resolution = outcome.resolution;
  const staged = await runNodePipelineStages(policy, nodes, resolution.node, hooks);
  if (staged.kind === 'occluded') {
    return { kind: 'occluded', node: staged.node, selector: resolution.selector };
  }
  return {
    kind: 'target',
    node: staged.node,
    selector: resolution.selector,
    selectorIndex: resolution.selectorIndex,
    matches: resolution.matches,
    matchedNodes: outcome.matchedNodes,
  };
}

/**
 * `reject-candidates` rows: the caller gets the whole candidate set of the
 * first matching alternative and must narrow or refuse it, then bring the node
 * it chose back through `runNodePipelineStages`.
 *
 * `candidates` is the tree as this row sees it — the candidacy stage's output.
 * A caller that reasons about the surroundings of a match (find's ranking, the
 * acting equivalence classification) must reason about THAT tree, or an
 * overlay-covered node would come back as a competitor the row already excluded.
 */
export type SelectorPipelineMatches = {
  candidates: SnapshotNode[];
  list: SelectorChainMatchList | null;
};

export function listSelectorPipelineMatches(
  policy: CandidateSetPipelinePolicy,
  nodes: SnapshotNode[],
  selector: string,
  match: SelectorMatchOptions,
): SelectorPipelineMatches {
  const candidates = pipelineCandidates(policy, nodes);
  return {
    candidates,
    list: listSelectorChainMatches(candidates, selector, {
      ...match,
      requireRect: policy.resolution.requireRect,
    }),
  };
}

/** Every node stage this row declares, in the order acting routes need them. */
export async function runNodePipelineStages(
  policy: SelectorPipelinePolicy,
  nodes: SnapshotNode[],
  node: SnapshotNode,
  hooks: SelectorPipelineHooks = {},
): Promise<SelectorPipelineTarget> {
  hooks.onResolved?.(node, nodes);
  const promoted = promoteTarget(policy.promotion, nodes, node);
  if (policy.occlusion !== 'ignore') {
    if (promoted.covered || isSnapshotNodeInteractionBlocked(promoted.node)) {
      return { kind: 'occluded', node: promoted.node };
    }
  }
  return { kind: 'target', node: await guardOffscreen(policy, nodes, promoted.node, hooks) };
}

/** The nodes this row lets a selector match against. */
function pipelineCandidates(policy: SelectorListPolicy, nodes: SnapshotNode[]): SnapshotNode[] {
  if (policy.occlusion !== 'exclude-and-refuse') return nodes;
  return nodes.filter((candidate) => !isSnapshotNodeInteractionBlocked(candidate));
}

/**
 * `covered` reports that the match itself is blocked: promotion declines to
 * retarget away from a covered node, so the caller names the node it asked
 * about rather than an ancestor it never selected.
 */
function promoteTarget(
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

async function guardOffscreen(
  policy: SelectorPipelinePolicy,
  nodes: SnapshotNode[],
  node: SnapshotNode,
  hooks: SelectorPipelineHooks,
): Promise<SnapshotNode> {
  if (policy.offscreen !== 'refuse') return node;
  if (!hooks.offscreen) {
    throw new Error(
      'selector pipeline row declares an off-screen refusal but this route supplies no refusal shape',
    );
  }
  return await hooks.offscreen(node, nodes);
}

/** The poll stage: the budget `createWaitPolling` runs the row under. */
export function selectorPollBudget(policy: SelectorPipelinePolicy): SelectorPollBudget {
  if (policy.poll === 'none') {
    throw new Error(
      'selector pipeline row resolves against one capture and declares no poll budget',
    );
  }
  return policy.poll;
}
