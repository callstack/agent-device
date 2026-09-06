import { AppError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  annotationLocalIdentity,
  buildAncestryChain,
  buildIndexMap,
  filterIdentitySet,
  readNodeLocalIdentity,
} from '@agent-device/ad-script';
import {
  WAIT_LANDMARK_MISMATCH_REASON,
  type TargetAnnotationV1,
  type WaitLandmarkMismatchEvidence,
} from '@agent-device/contracts/replay';
import type { SelectorChainMatchList } from '@agent-device/selectors';
import {
  resolveSelectorPipeline,
  type SelectorPipelineOutcome,
} from '../../../core/selector-pipeline.ts';
import { SELECTOR_PIPELINE_POLICIES } from '../../../core/selector-pipeline-policy.ts';
import { deriveSelectorCapturePolicy } from './selector-capture-policy.ts';
import type {
  SelectorWaitOperations,
  SelectorWaitRuntime,
  WaitCommandOptions,
  WaitCommandResult,
} from './selector-wait.ts';
import { createWaitPolling, type WaitPollDeadline, waitTimeoutError } from './wait-polling.ts';

/**
 * The landmark check (#1349) needs the full candidate set, which the pipeline
 * outcome carries in either shape. Wait's row never refuses, so this only ever
 * adapts — it does not re-decide anything.
 */
function policyMatchList(outcome: SelectorPipelineOutcome): SelectorChainMatchList | undefined {
  if (outcome.kind === 'ambiguous') {
    return {
      selector: outcome.selector,
      selectorIndex: outcome.selectorIndex,
      matchedNodes: outcome.matchedNodes,
    };
  }
  if (outcome.kind === 'target') {
    return {
      selector: outcome.selector,
      selectorIndex: outcome.selectorIndex,
      // Every candidate, not just the winner: the landmark check is satisfied
      // when SOME match carries the recorded identity, so a first impostor
      // must not hide a later genuine landmark (#1349).
      matchedNodes: outcome.matchedNodes,
    };
  }
  return undefined;
}

export async function waitForSelector<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  selectorExpression: string,
  timeoutMs: number | null | undefined,
  recordedLandmark: TargetAnnotationV1 | undefined,
): Promise<Extract<WaitCommandResult, { kind: 'selector' }>> {
  const polling = createWaitPolling(runtime, options, timeoutMs, SELECTOR_PIPELINE_POLICIES.wait);
  const capturePolicy = deriveSelectorCapturePolicy();
  // ADR 0012 / #1349: the LAST poll whose capture matched the recorded
  // selector without any match carrying the recorded landmark identity. A
  // transient same-selector impostor (the previous screen mid-transition)
  // must not abort a wait whose job is to wait through it, so the loop keeps
  // polling; only the deadline turns this into the fail-closed refusal.
  let landmarkMismatch: WaitLandmarkMismatchEvidence | undefined;
  let deadline: WaitPollDeadline | undefined;
  while (polling.hasTimeRemaining()) {
    // Presence-only poll: skip scroll-hint derivation (#1270), same as waitForFindMatch.
    const poll = await polling.capture(
      async (signal) =>
        await operations.captureSnapshot(
          runtime,
          { ...options, signal },
          {
            updateSession: true,
            includeHiddenContentHints: false,
            ...capturePolicy,
          },
        ),
    );
    if (poll.timedOut) {
      deadline = poll.deadline;
      break;
    }
    const capture = poll.value;
    if (capture) {
      const nodes = capture.snapshot.nodes;
      // The wait row ignores occlusion and off-screen: a covered or scrolled-out
      // element is present, and presence is the question this loop asks.
      const outcome = await resolveSelectorPipeline(
        SELECTOR_PIPELINE_POLICIES.wait,
        nodes,
        selectorExpression,
        { platform: runtime.backend.platform },
      );
      // The wait row is `first-match`, so a multi-match screen resolves rather
      // than refusing; the landmark check below is what decides satisfaction.
      const matchList = policyMatchList(outcome);
      if (matchList) {
        const landmark = resolveLandmarkMatch(nodes, matchList, recordedLandmark);
        if (landmark.kind === 'satisfied') {
          return {
            kind: 'selector',
            selector: matchList.selector,
            waitedMs: polling.waitedMs(),
            node: landmark.node,
            preActionNodes: nodes,
          };
        }
        landmarkMismatch = landmark.evidence;
      }
    }
    await polling.sleepUntilNextPoll();
  }
  if (deadline !== 'capture-stalled' && landmarkMismatch) {
    // The refusal keeps the poll evidence a plain timeout would carry, including a runner
    // restart on the final poll: the mismatch is the verdict, not the whole story of the wait.
    throw new AppError(
      'COMMAND_FAILED',
      `wait matched selector ${selectorExpression} but no candidate carried the recorded landmark identity`,
      { reason: WAIT_LANDMARK_MISMATCH_REASON, ...polling.failureEvidence(), ...landmarkMismatch },
    );
  }
  throw waitTimeoutError(`wait timed out for selector: ${selectorExpression}`, polling, deadline);
}

type LandmarkMatchOutcome =
  | { kind: 'satisfied'; node: SnapshotNode }
  | { kind: 'identity-mismatch'; evidence: WaitLandmarkMismatchEvidence };

/**
 * #1349 landmark check: the wait is satisfied when SOME selector match
 * carries the recorded identity (local identity + leaf-anchored ancestry
 * prefix). Positional disambiguation signals are deliberately not consulted —
 * a destination guard proves the landmark exists on the ready screen, not
 * that it kept its list position.
 */
function resolveLandmarkMatch(
  nodes: SnapshotNode[],
  matchList: SelectorChainMatchList,
  recorded: TargetAnnotationV1 | undefined,
): LandmarkMatchOutcome {
  const firstMatch = matchList.matchedNodes[0]!;
  if (!recorded) return { kind: 'satisfied', node: firstMatch };
  const byIndex = buildIndexMap(nodes);
  const identitySet = filterIdentitySet(
    matchList.matchedNodes,
    byIndex,
    annotationLocalIdentity(recorded),
    recorded.ancestry,
  );
  const member = identitySet[0];
  if (member) return { kind: 'satisfied', node: member };
  return {
    kind: 'identity-mismatch',
    evidence: {
      matchCount: matchList.matchedNodes.length,
      observed: readNodeLocalIdentity(firstMatch),
      observedAncestry: buildAncestryChain(
        firstMatch,
        byIndex,
        Math.max(recorded.ancestry.length, 1),
      ).chain,
    },
  };
}
