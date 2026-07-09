import type { SnapshotNode } from '../../../kernel/snapshot.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { isSparseSnapshotQualityVerdict } from '../../../snapshot/snapshot-quality.ts';
import { buildSnapshotDiff } from '../../../snapshot/snapshot-diff.ts';
import { displayLabel, formatRole } from '../../../snapshot/snapshot-lines.ts';
import { summarizeAxEvidence } from '../../../utils/ax-digest.ts';
import type {
  InteractionEvidence,
  ResolvedInteractionTarget,
  SettleObservation,
  SettleParams,
  SettleTailEntry,
} from '../../../contracts/interaction.ts';
import type { CapturedSnapshot } from './selector-read-shared.ts';
import {
  DEFAULT_STABLE_QUIET_MS,
  DEFAULT_STABLE_TIMEOUT_MS,
  runStableCaptureLoop,
  TINY_STABLE_TREE_HINT,
  TINY_STABLE_TREE_NODE_COUNT,
} from './stable-capture.ts';

/**
 * `--settle` (#1101): after a mutating interaction, wait for the UI to go
 * quiet (wait stable's loop, shared via stable-capture.ts) and return the
 * settled DIFF against the pre-action tree in the same response — one round
 * trip instead of the interact → observe pair.
 *
 * Best-effort by contract: this module never throws. The action already
 * succeeded when it runs; observation quality is advisory (same principle as
 * `--verify` evidence).
 */

export type SettleOutcome = {
  observation: SettleObservation;
  /** Nodes of the final capture; doubles as the `--verify` evidence source. */
  settledNodes?: SnapshotNode[];
};

// Changed-lines bound: the settled diff is the response payload, and unbounded
// added/removed lists on a full screen transition would crowd out everything
// else. The summary always carries the true counts.
const MAX_SETTLE_DIFF_LINES = 80;

// Unchanged-interactive-tail bound: same token-budget principle as the diff
// line cap, sized smaller since the tail is a fallback list, not the primary
// payload.
const MAX_SETTLE_TAIL_ENTRIES = 20;

export const NEVER_SETTLED_HINT =
  'The UI kept changing for the whole settle budget (animation, carousel, or ticker?), so no settled diff is shown. Raise --timeout, wait for specific content, or take a fresh snapshot.';

const SETTLE_CAPTURE_STALLED_HINT =
  'A snapshot capture stalled past the settle budget, so no settled diff is shown. The action itself succeeded; observe with wait stable or snapshot.';

export async function settleAfterInteraction(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  params: SettleParams & { resolved: ResolvedInteractionTarget },
): Promise<SettleOutcome> {
  const quietMs = params.quietMs ?? DEFAULT_STABLE_QUIET_MS;
  const timeoutMs = params.timeoutMs ?? DEFAULT_STABLE_TIMEOUT_MS;
  const base: SettleObservation = { settled: false, waitedMs: 0, captures: 0, quietMs, timeoutMs };
  try {
    const outcome = await runStableCaptureLoop(runtime, options, {
      quietMs,
      timeoutMs,
      resetBudgetOnPrivateAxRecovery: true,
    });
    const observation: SettleObservation = {
      ...base,
      settled: outcome.settled,
      waitedMs: outcome.waitedMs,
      captures: outcome.captures,
    };
    if (!outcome.lastCapture) {
      return {
        observation: {
          ...observation,
          hint: outcome.stalled ? SETTLE_CAPTURE_STALLED_HINT : NEVER_SETTLED_HINT,
        },
      };
    }
    const stored = await storeSettledSnapshot(runtime, options, outcome.lastCapture);
    const settledNodes = outcome.lastCapture.snapshot.nodes;
    return {
      observation: {
        ...observation,
        // The diff (with its added-line refs) is only attached when the settled
        // tree actually became the stored session snapshot: those refs must be
        // valid against the tree the next @ref command resolves on. The daemon
        // treats `diff` presence as "this response issues refs". Unsettled
        // captures are intentionally diff-less: they are not a stable
        // observation, so surfacing refs would invite agents to act on
        // advisory state.
        ...(outcome.settled && stored
          ? buildSettleDiffAndTail(resolveBaselineNodes(params.resolved), settledNodes)
          : {}),
        ...resolveSettleHint(outcome, stored, settledNodes.length),
      },
      settledNodes,
    };
  } catch (error) {
    // Never fail the action over the observation: report that settling itself
    // broke and let the caller fall back to an explicit snapshot.
    return {
      observation: {
        ...base,
        hint: `Settle observation unavailable (${error instanceof Error ? error.message : String(error)}). The action itself succeeded; take a snapshot to observe the result.`,
      },
    };
  }
}

/**
 * `--settle --verify` composition: the settle loop's final capture doubles as
 * the verify evidence source, so the pair costs zero extra captures. Without a
 * final capture there is no evidence — best-effort, like verify itself.
 */
export function settleEvidence(
  settledNodes: SnapshotNode[] | undefined,
  preActionNodes: SnapshotNode[] | undefined,
): InteractionEvidence | undefined {
  if (!settledNodes) return undefined;
  const after = summarizeAxEvidence(settledNodes);
  const changedFromBefore =
    preActionNodes !== undefined && after.digest !== summarizeAxEvidence(preActionNodes).digest;
  return { ...after, changedFromBefore };
}

function resolveBaselineNodes(resolved: ResolvedInteractionTarget): SnapshotNode[] {
  return 'preActionNodes' in resolved && resolved.preActionNodes ? resolved.preActionNodes : [];
}

function buildSettleDiff(
  baselineNodes: SnapshotNode[],
  settledNodes: SnapshotNode[],
): NonNullable<SettleObservation['diff']> {
  // Flattened compare, like `diff -i`: both sides are interactive-flavored
  // captures and depth jitter across captures should not read as change. When
  // the baseline came from a richer stored tree (ref targets reuse the session
  // snapshot), extra baseline-only lines surface as removals — advisory noise,
  // the same baseline caveat --verify's changedFromBefore already accepts.
  const diff = buildSnapshotDiff(
    withoutKeyboardKeys(baselineNodes),
    withoutKeyboardKeys(settledNodes),
    { flatten: true, withRefs: true },
  );
  const changed = diff.lines.filter((line) => line.kind !== 'unchanged');
  const lines = capSettleDiffLines(changed).map((line) => ({
    kind: line.kind as 'added' | 'removed',
    text: line.text,
    ...(line.ref ? { ref: line.ref } : {}),
  }));
  return {
    summary: diff.summary,
    lines,
    ...(changed.length > lines.length ? { truncated: true as const } : {}),
  };
}

function buildSettleDiffAndTail(
  baselineNodes: SnapshotNode[],
  settledNodes: SnapshotNode[],
): Pick<SettleObservation, 'diff' | 'tail' | 'tailTruncated'> {
  const diff = buildSettleDiff(baselineNodes, settledNodes);
  return { diff, ...buildSettleTail(diff, settledNodes) };
}

/**
 * Unchanged interactive refs tail: attached ONLY when the settled diff carries
 * zero added-line refs (a modal-dismiss/toast-only diff shows removals but
 * nothing added, so the next actionable target is otherwise invisible). Every
 * hittable, uncovered element on the settled tree is a candidate; refs already
 * present on the diff's added lines are excluded so the tail never repeats
 * what the diff already handed the caller.
 */
function buildSettleTail(
  diff: NonNullable<SettleObservation['diff']>,
  settledNodes: SnapshotNode[],
): Pick<SettleObservation, 'tail' | 'tailTruncated'> {
  const addedRefs = new Set(
    diff.lines.filter((line) => line.kind === 'added' && line.ref).map((line) => line.ref),
  );
  if (addedRefs.size > 0) return {};
  return buildSettleTailEntries(settledNodes, addedRefs);
}

/**
 * The filtering/cap step behind `buildSettleTail`, split out so the dedup
 * rule (excludeRefs) is unit-testable independent of the trigger condition
 * above.
 */
export function buildSettleTailEntries(
  settledNodes: SnapshotNode[],
  excludeRefs: ReadonlySet<string | undefined>,
): Pick<SettleObservation, 'tail' | 'tailTruncated'> {
  const candidates = settledNodes.filter(
    (node) =>
      node.ref &&
      node.hittable === true &&
      node.interactionBlocked !== 'covered' &&
      !excludeRefs.has(node.ref),
  );
  if (candidates.length === 0) return {};
  const tail: SettleTailEntry[] = candidates.slice(0, MAX_SETTLE_TAIL_ENTRIES).map((node) => {
    const role = formatRole(node.type ?? 'Element');
    const label = displayLabel(node, role);
    return { ref: node.ref, role, ...(label ? { label } : {}) };
  });
  return {
    tail,
    ...(candidates.length > tail.length ? { tailTruncated: true as const } : {}),
  };
}

// The iOS QWERTY keyboard is ~50 Key nodes; a fill that summons it would spend
// most of the capped line budget spelling out the keyboard instead of the
// content change the agent actually asked to observe. The Keyboard container
// node stays, so "keyboard appeared/left" remains one visible diff line.
function withoutKeyboardKeys(nodes: SnapshotNode[]): SnapshotNode[] {
  return nodes.filter((node) => node.type !== 'Key');
}

/**
 * Truncation policy: added lines win. They carry the settled tree's fresh
 * refs — the actionable half of the diff — while removals only describe what
 * left the screen (the summary still counts them). Relative order within each
 * kind is preserved; removals fill whatever budget the additions leave.
 */
function capSettleDiffLines<T extends { kind: string }>(changed: T[]): T[] {
  if (changed.length <= MAX_SETTLE_DIFF_LINES) return changed;
  const added = changed.filter((line) => line.kind === 'added');
  const keptAdded = new Set(added.slice(0, MAX_SETTLE_DIFF_LINES));
  let removedBudget = MAX_SETTLE_DIFF_LINES - keptAdded.size;
  const kept: T[] = [];
  for (const line of changed) {
    if (keptAdded.has(line)) {
      kept.push(line);
    } else if (line.kind === 'removed' && removedBudget > 0) {
      kept.push(line);
      removedBudget -= 1;
    }
  }
  return kept;
}

function resolveSettleHint(
  outcome: { settled: boolean; stalled: boolean },
  stored: boolean,
  settledNodeCount: number,
): { hint?: string } {
  if (outcome.stalled) return { hint: SETTLE_CAPTURE_STALLED_HINT };
  if (!outcome.settled) return { hint: NEVER_SETTLED_HINT };
  if (!stored) {
    return {
      hint: 'Settled on a sparse, unreadable tree — the diff is omitted. Use screenshot as visual truth before interacting further.',
    };
  }
  // Same weak-readiness signal wait stable reports: a settled-but-tiny tree
  // usually means a splash/loading surface, not real content.
  if (settledNodeCount < TINY_STABLE_TREE_NODE_COUNT) return { hint: TINY_STABLE_TREE_HINT };
  return {};
}

// The settle loop itself captures with updateSession: false (a capture that
// later stalls must not race a session write past the response). The FINAL
// capture is stored so follow-up snapshots/selectors see the latest surface.
// Only settled captures issue a diff/ref payload; unsettled stored captures
// conservatively mark prior refs stale through the runtime session writer.
// Sparse-quality captures are not stored (mirroring captureSelectorSnapshot)
// and therefore issue no refs.
async function storeSettledSnapshot(
  runtime: AgentDeviceRuntime,
  options: CommandContext,
  capture: CapturedSnapshot,
): Promise<boolean> {
  if (isSparseSnapshotQualityVerdict(capture.snapshot.snapshotQuality)) return false;
  const session = await runtime.sessions.get(options.session ?? 'default');
  if (!session) return false;
  await runtime.sessions.set({ ...session, snapshot: capture.snapshot });
  return true;
}
