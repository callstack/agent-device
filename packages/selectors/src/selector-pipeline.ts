import {
  hasSnapshotRef,
  type SnapshotAddressableNode,
  type SnapshotNode,
} from '@agent-device/kernel/snapshot';
import type {
  SelectorChainMatchList,
  SelectorMatchOptions,
  SelectorResolution,
} from '@agent-device/selectors';
import {
  listSelectorChainMatches,
  resolveSelectorChainWithPolicy,
} from '@agent-device/selectors/engine';
import { isSnapshotNodeInteractionBlocked } from '@agent-device/capture-kit/snapshot-occlusion';
import {
  classifyActionableTouchCandidates,
  isRootInteractionContainer,
  resolveActionableTouchResolution,
  resolveElementReportedTwice,
} from './interaction-targeting.ts';
import type {
  ActingPipelinePolicy,
  CandidateSetPipelinePolicy,
  SelectorListPolicy,
  SelectorPipelinePolicy,
  SelectorPromotionStage,
  SingleTargetPipelinePolicy,
  WaitPollBudget,
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
 * - `resolveActionSelectorPipeline` — acting rows whose candidate set may
 *   collapse through actionable equivalence; the collapse stays inside this
 *   owner so addressability is checked at the same exit as every other row.
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

export type SelectorPipelineNodeForPolicy<TPolicy extends SelectorListPolicy> = TPolicy extends {
  resolution: { requireRect: true };
}
  ? SnapshotAddressableNode
  : SnapshotNode;

export type SelectorPipelineTarget<TNode extends SnapshotNode = SnapshotNode> =
  | { kind: 'target'; node: TNode }
  | { kind: 'occluded'; node: TNode };

export type SelectorPipelineOutcome<TNode extends SnapshotNode = SnapshotNode> =
  | { kind: 'none' }
  | { kind: 'ambiguous'; selector: string; selectorIndex: number; matchedNodes: SnapshotNode[] }
  /** `selector` is the ALTERNATIVE that matched, which is what a refusal names. */
  | { kind: 'occluded'; node: TNode; selector: string }
  | {
      kind: 'target';
      node: TNode;
      selector: string;
      selectorIndex: number;
      matches: number;
      matchedNodes: SnapshotNode[];
    };

/** Rows that resolve one target: candidacy, ambiguity, then every node stage. */
export async function resolveSelectorPipeline<const TPolicy extends SingleTargetPipelinePolicy>(
  policy: TPolicy,
  nodes: SnapshotNode[],
  selector: string,
  match: SelectorMatchOptions,
  hooks: SelectorPipelineHooks = {},
): Promise<SelectorPipelineOutcome<SelectorPipelineNodeForPolicy<TPolicy>>> {
  const outcome = resolveSelectorChainWithPolicy(
    pipelineCandidates(policy, nodes),
    selector,
    policy.resolution,
    match,
  );
  if (outcome.kind === 'none') return { kind: 'none' };
  if (outcome.kind === 'resolved') {
    return await stageResolvedRow(
      policy,
      nodes,
      {
        node: outcome.resolution.node,
        selector: outcome.resolution.selector,
        selectorIndex: outcome.resolution.selectorIndex,
        matches: outcome.resolution.matches,
        matchedNodes: outcome.matchedNodes,
      },
      hooks,
    );
  }
  const equivalent = resolveEquivalentControlTarget(nodes, outcome);
  return equivalent ? await stageResolvedRow(policy, nodes, equivalent, hooks) : outcome;
}

/**
 * A resolved target plus the candidate set the engine reported with it: the
 * first alternative that matched anything, which a uniqueness row can resolve
 * past (`AstSelectorResolution`'s contract), so pair `selector` with
 * `matchedNodes` before reading them as one set.
 */
type ResolvedRowTarget = {
  node: SnapshotNode;
  selector: string;
  selectorIndex: number;
  matches: number;
  matchedNodes: SnapshotNode[];
};

/**
 * Several matches refused where the candidate set is really ONE element the
 * platform reported twice — a control under its own accessibility wrapper (#2498),
 * or an authored text reporter and the accessibility element mirroring it (#2870):
 * there is nothing to choose among, and
 * `is <predicate>`/`get attrs`/`screenshot --crop-on` answer about that element
 * instead of reporting no match for something plainly on screen. A row that ranks or
 * takes the document-order head resolves on its own and never reaches here —
 * a wrapper chain has distinct depths, which is what its tiebreak decides on —
 * and an acting row collapses inside `classifyActionableTouchCandidates`, which
 * additionally has to settle a touch point.
 *
 * The RN text pair is the same decision the interactive snapshot already makes:
 * `collectIosRepeatedStaticSuppression` keeps the outer reporter and suppresses its
 * repeated descendant, so `snapshot -i` has always shown that line once. The read
 * door now answers about the node that snapshot row names.
 */
function resolveEquivalentControlTarget(
  nodes: SnapshotNode[],
  refused: { selector: string; selectorIndex: number; matchedNodes: SnapshotNode[] },
): ResolvedRowTarget | null {
  const control = resolveElementReportedTwice(nodes, refused.matchedNodes);
  if (!control) return null;
  return {
    node: control,
    selector: refused.selector,
    selectorIndex: refused.selectorIndex,
    matches: refused.matchedNodes.length,
    matchedNodes: refused.matchedNodes,
  };
}

/** Every node stage this row declares, applied to a resolved target. */
async function stageResolvedRow<const TPolicy extends SingleTargetPipelinePolicy>(
  policy: TPolicy,
  nodes: SnapshotNode[],
  resolved: ResolvedRowTarget,
  hooks: SelectorPipelineHooks,
): Promise<SelectorPipelineOutcome<SelectorPipelineNodeForPolicy<TPolicy>>> {
  const staged = await runNodePipelineStages(policy, nodes, resolved.node, hooks);
  if (staged.kind === 'occluded') {
    return { kind: 'occluded', node: staged.node, selector: resolved.selector };
  }
  return { ...resolved, kind: 'target', node: staged.node };
}

/**
 * `reject-candidates` rows: the caller gets the whole candidate set of the
 * first matching alternative and must narrow or refuse it, then bring the node
 * it chose back through `runNodePipelineStages`.
 *
 * `candidates` is the node set as this row lets selectors see it. Acting
 * equivalence still receives the full tree for structural ancestry, then
 * brings the winning node back through the checked pipeline exit.
 */
export type SelectorPipelineMatches<TNode extends SnapshotNode = SnapshotNode> = {
  candidates: SnapshotNode[];
  list: (Omit<SelectorChainMatchList, 'matchedNodes'> & { matchedNodes: TNode[] }) | null;
};

export type SelectorActionPipelineOutcome<TNode extends SnapshotNode = SnapshotNode> =
  | { kind: 'none' }
  | { kind: 'ambiguous'; selector: string; candidates: SnapshotNode[] }
  | { kind: 'resolved'; resolution: SelectorResolution<TNode> };

export function listSelectorPipelineMatches<const TPolicy extends CandidateSetPipelinePolicy>(
  policy: TPolicy,
  nodes: SnapshotNode[],
  selector: string,
  match: SelectorMatchOptions,
): SelectorPipelineMatches<SelectorPipelineNodeForPolicy<TPolicy>> {
  const candidates = pipelineCandidates(policy, nodes);
  const list = listSelectorChainMatches(candidates, selector, {
    ...match,
    requireRect: policy.resolution.requireRect,
  });
  return {
    candidates,
    list: pipelineMatchListForPolicy(policy, list),
  };
}

export function resolveActionSelectorPipeline<const TPolicy extends ActingPipelinePolicy>(
  policy: TPolicy,
  nodes: SnapshotNode[],
  selectorExpression: string,
  match: SelectorMatchOptions,
): SelectorActionPipelineOutcome<SelectorPipelineNodeForPolicy<TPolicy>> {
  const { list } = listSelectorPipelineMatches(policy, nodes, selectorExpression, match);
  const matched = list?.matchedNodes ?? [];
  if (!list || matched.length === 0) return { kind: 'none' };

  const diagnostics = [{ selector: list.selector, matches: matched.length }];
  if (matched.length === 1) {
    return {
      kind: 'resolved',
      resolution: {
        node: matched[0]!,
        selector: list.selector,
        selectorIndex: list.selectorIndex,
        matches: 1,
        diagnostics,
      },
    };
  }

  const classification = classifyActionableTouchCandidates(nodes, matched);
  if (classification.kind === 'ambiguous') {
    return { kind: 'ambiguous', selector: list.selector, candidates: classification.candidates };
  }

  return {
    kind: 'resolved',
    resolution: {
      node: nodeForPolicy(policy, classification.node),
      selector: list.selector,
      selectorIndex: list.selectorIndex,
      matches: matched.length,
      diagnostics,
      disambiguation: {
        matchCount: matched.length,
        tiebreak: 'structural-equivalence',
        alternatives: matched.filter((candidate) => candidate.index !== classification.node.index),
      },
    },
  };
}

/** Every node stage this row declares, in the order acting routes need them. */
export async function runNodePipelineStages<const TPolicy extends SelectorPipelinePolicy>(
  policy: TPolicy,
  nodes: SnapshotNode[],
  node: SnapshotNode,
  hooks: SelectorPipelineHooks = {},
): Promise<SelectorPipelineTarget<SelectorPipelineNodeForPolicy<TPolicy>>> {
  hooks.onResolved?.(node, nodes);
  const promoted = promoteTarget(policy.promotion, nodes, node);
  if (policy.occlusion !== 'ignore') {
    if (promoted.covered || isSnapshotNodeInteractionBlocked(promoted.node)) {
      return { kind: 'occluded', node: nodeForPolicy(policy, promoted.node) };
    }
  }
  return {
    kind: 'target',
    node: nodeForPolicy(policy, await guardOffscreen(policy, nodes, promoted.node, hooks)),
  };
}

function nodeForPolicy<TPolicy extends SelectorListPolicy>(
  policy: TPolicy,
  node: SnapshotNode,
): SelectorPipelineNodeForPolicy<TPolicy> {
  if (policy.resolution.requireRect && !hasSnapshotRef(node)) {
    throw new Error(
      'selector pipeline row requires an addressable target, but resolved a ref-less node',
    );
  }
  return node as SelectorPipelineNodeForPolicy<TPolicy>;
}

function pipelineMatchListForPolicy<TPolicy extends SelectorListPolicy>(
  policy: TPolicy,
  list: SelectorChainMatchList | null,
): SelectorPipelineMatches<SelectorPipelineNodeForPolicy<TPolicy>>['list'] {
  if (!list) return null;
  return {
    ...list,
    matchedNodes: list.matchedNodes.map((node) => nodeForPolicy(policy, node)),
  };
}

/** The nodes this row lets a selector match against. */
function pipelineCandidates(policy: SelectorListPolicy, nodes: SnapshotNode[]): SnapshotNode[] {
  const addressableCandidates = policy.resolution.requireRect
    ? nodes.filter(hasSnapshotRef)
    : nodes;
  if (policy.occlusion !== 'exclude-and-refuse') return addressableCandidates;
  return addressableCandidates.filter((candidate) => !isSnapshotNodeInteractionBlocked(candidate));
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

/**
 * The poll stage: the caller-default budget `createWaitPolling` runs a wait-shaped row under.
 * `promotedTarget`'s row polls too, but under a caller-supplied, row-capped budget rather than a
 * row-owned default — it has no `defaultTimeoutMs` to hand back, so it is not a legal input here.
 */
export function selectorPollBudget(policy: SelectorPipelinePolicy): WaitPollBudget {
  if (policy.poll === 'none') {
    throw new Error(
      'selector pipeline row resolves against one capture and declares no poll budget',
    );
  }
  if (!('defaultTimeoutMs' in policy.poll)) {
    throw new Error(
      'selector pipeline row polls under a caller-capped readiness budget, not a caller-default one',
    );
  }
  return policy.poll;
}
