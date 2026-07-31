import { AppError } from '@agent-device/kernel/errors';
import { findNodeByRef, normalizeRef, type SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  readNodeLocalIdentity,
  WAIT_LANDMARK_MISMATCH_REASON,
  type WaitLandmarkMismatchEvidence,
} from '../../../replay/target-identity-node.ts';
import {
  buildAncestryChain,
  buildIndexMap,
  filterIdentitySet,
} from '../../../replay/target-evidence-tree.ts';
import { annotationLocalIdentity } from '../../../replay/target-identity.ts';
import type { TargetAnnotationV1 } from '@agent-device/ad-script';
import type { PublicPlatform } from '@agent-device/kernel/device';
import { checkWaitText } from '../../../selectors/arguments.ts';
import { listSelectorChainMatches } from '../../../selectors/index.ts';
import { parseSelectorChain } from '../../../selectors/parse.ts';
import type { SelectorChainMatchList } from '../../../selectors/resolve.ts';
import { deriveSelectorCapturePolicy } from './selector-capture-policy.ts';
import { findNodeByLabel, resolveRefLabel } from './selector-read-utils.ts';
import {
  createWaitPolling,
  DEFAULT_WAIT_TIMEOUT_MS,
  type WaitPollDeadline,
  waitCaptureStalledError,
  waitDeadlineExceededError,
} from './wait-polling.ts';

type WaitCommandContext = {
  session?: string;
  requestId?: string;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
};

type SelectorSnapshotOptions = {
  depth?: number;
  scope?: string;
  raw?: boolean;
};

export type WaitCommandOptions = WaitCommandContext &
  SelectorSnapshotOptions & {
    target:
      | { kind: 'sleep'; durationMs: number }
      | { kind: 'text'; text: string; timeoutMs?: number | null }
      | { kind: 'ref'; ref: string; timeoutMs?: number | null }
      | {
          kind: 'selector';
          selector: string;
          timeoutMs?: number | null;
          /**
           * ADR 0012 / #1349, replay-only: the recorded landmark identity this
           * wait must observe before reporting success. Polling is unchanged —
           * the loop keeps waiting while no selector match carries this
           * identity, and a timeout with rejected candidates throws the
           * `WAIT_LANDMARK_MISMATCH_REASON` refusal instead of success.
           */
          recordedLandmark?: TargetAnnotationV1;
        }
      | { kind: 'stable'; quietMs?: number | null; timeoutMs?: number | null };
  };

export type WaitCommandResult =
  | { kind: 'sleep'; waitedMs: number }
  | { kind: 'text'; waitedMs: number; text: string }
  | {
      kind: 'selector';
      waitedMs: number;
      selector: string;
      /** ADR 0012 decision 3: the satisfying match and the tree it came from, for record-time evidence. */
      node?: SnapshotNode;
      preActionNodes?: SnapshotNode[];
    }
  | {
      kind: 'stable';
      waitedMs: number;
      captures: number;
      nodeCount: number;
      hint?: string;
    };

export type WaitForTextCommandOptions = WaitCommandContext &
  SelectorSnapshotOptions & {
    text: string;
    timeoutMs?: number | null;
  };

type SelectorWaitRuntime = {
  backend: {
    platform: PublicPlatform;
    findText?: (context: WaitCommandContext, text: string) => Promise<{ found: boolean }>;
  };
  clock?: {
    now(): number;
    sleep(ms: number): Promise<void>;
  };
  signal?: AbortSignal;
};

type StableCaptureResult = {
  settled: boolean;
  stalled: boolean;
  waitedMs: number;
  captures: number;
  nodeCount: number;
};

export type SelectorWaitOperations<Runtime extends SelectorWaitRuntime> = {
  captureSnapshot: (
    runtime: Runtime,
    options: WaitCommandContext & SelectorSnapshotOptions,
    captureOptions: {
      updateSession: boolean;
      scope?: string;
      includeRects?: boolean;
      interactiveOnly?: boolean;
      includeHiddenContentHints?: boolean;
    },
  ) => Promise<{ snapshot: { nodes: SnapshotNode[] } }>;
  requireSnapshot: (
    runtime: Runtime,
    requestedName: string | undefined,
  ) => Promise<{ snapshot: { nodes: SnapshotNode[] } }>;
  stable: {
    defaultQuietMs: number;
    tinyTreeHint: string;
    tinyTreeNodeCount: number;
    capture: (
      runtime: Runtime,
      options: WaitCommandContext & SelectorSnapshotOptions,
      params: { quietMs: number; timeoutMs: number },
    ) => Promise<StableCaptureResult>;
  };
};

export function createSelectorWaitCommands<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
): {
  waitCommand: (runtime: Runtime, options: WaitCommandOptions) => Promise<WaitCommandResult>;
  waitForTextCommand: (
    runtime: Runtime,
    options: WaitForTextCommandOptions,
  ) => Promise<Extract<WaitCommandResult, { kind: 'text' }>>;
} {
  const waitCommand = async (
    runtime: Runtime,
    options: WaitCommandOptions,
  ): Promise<WaitCommandResult> => {
    if (options.target.kind === 'sleep') {
      await sleep(runtime, options.target.durationMs);
      return { kind: 'sleep', waitedMs: options.target.durationMs };
    }
    if (options.target.kind === 'ref') {
      const capture = await operations.requireSnapshot(runtime, options.session);
      const ref = normalizeRef(options.target.ref);
      if (!ref) throw new AppError('INVALID_ARGS', `Invalid ref: ${options.target.ref}`);
      const node = findNodeByRef(capture.snapshot.nodes, ref);
      const text = node ? resolveRefLabel(node, capture.snapshot.nodes) : undefined;
      if (!text) {
        throw new AppError('COMMAND_FAILED', `Ref ${options.target.ref} not found or has no label`);
      }
      return await waitForText(operations, runtime, options, text, options.target.timeoutMs);
    }
    if (options.target.kind === 'selector') {
      return await waitForSelector(
        operations,
        runtime,
        options,
        options.target.selector,
        options.target.timeoutMs,
        options.target.recordedLandmark,
      );
    }
    if (options.target.kind === 'stable') {
      return await waitForStable(
        operations,
        runtime,
        options,
        options.target.quietMs,
        options.target.timeoutMs,
      );
    }
    const waitText = checkWaitText(options.target.text);
    if (!waitText.ok) throw new AppError(waitText.code, waitText.message);
    return await waitForText(
      operations,
      runtime,
      options,
      options.target.text,
      options.target.timeoutMs,
    );
  };

  const waitForTextCommand = async (
    runtime: Runtime,
    options: WaitForTextCommandOptions,
  ): Promise<Extract<WaitCommandResult, { kind: 'text' }>> => {
    const result = await waitCommand(runtime, {
      ...options,
      target: { kind: 'text', text: options.text, timeoutMs: options.timeoutMs },
    });
    if (result.kind !== 'text') {
      throw new AppError('COMMAND_FAILED', 'waitForText returned non-text result');
    }
    return result;
  };

  return { waitCommand, waitForTextCommand };
}

async function waitForSelector<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  selectorExpression: string,
  timeoutMs: number | null | undefined,
  recordedLandmark: TargetAnnotationV1 | undefined,
): Promise<WaitCommandResult> {
  const polling = createWaitPolling(runtime, options, timeoutMs);
  const chain = parseSelectorChain(selectorExpression);
  const capturePolicy = deriveSelectorCapturePolicy({ selectorChain: chain });
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
      const matchList = listSelectorChainMatches(nodes, chain, {
        platform: runtime.backend.platform,
      });
      if (matchList) {
        const landmark = resolveLandmarkMatch(nodes, matchList, recordedLandmark);
        if (landmark.kind === 'satisfied') {
          return {
            kind: 'selector',
            selector: matchList.selector.raw,
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
  if (deadline === 'capture-stalled') {
    throw waitCaptureStalledError(
      `wait timed out for selector: ${selectorExpression}`,
      polling.timeoutMs,
    );
  }
  if (landmarkMismatch) {
    throw new AppError(
      'COMMAND_FAILED',
      `wait matched selector ${selectorExpression} but no candidate carried the recorded landmark identity`,
      { reason: WAIT_LANDMARK_MISMATCH_REASON, ...landmarkMismatch },
    );
  }
  if (deadline === 'capture-truncated') {
    throw waitDeadlineExceededError(
      `wait timed out for selector: ${selectorExpression}`,
      polling.timeoutMs,
      true,
    );
  }
  polling.rethrowIfNeverReadable();
  throw waitDeadlineExceededError(
    `wait timed out for selector: ${selectorExpression}`,
    polling.timeoutMs,
    false,
  );
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

async function waitForText<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  text: string,
  timeoutMs: number | null | undefined,
): Promise<WaitCommandResult> {
  const polling = createWaitPolling(runtime, options, timeoutMs);
  let deadline: WaitPollDeadline | undefined;
  while (polling.hasTimeRemaining()) {
    const poll = await polling.capture(async (signal) =>
      runtime.backend.findText
        ? (await runtime.backend.findText(backendContext(runtime, { ...options, signal }), text))
            .found
        : await snapshotContainsText(operations, runtime, { ...options, signal }, text),
    );
    if (poll.timedOut) {
      deadline = poll.deadline;
      break;
    }
    const found = poll.value;
    if (found) return { kind: 'text', text, waitedMs: polling.waitedMs() };
    await polling.sleepUntilNextPoll();
  }
  if (deadline === 'capture-stalled') {
    throw waitCaptureStalledError(`wait timed out for text: ${text}`, polling.timeoutMs);
  }
  if (deadline === 'capture-truncated') {
    throw waitDeadlineExceededError(`wait timed out for text: ${text}`, polling.timeoutMs, true);
  }
  polling.rethrowIfNeverReadable();
  throw waitDeadlineExceededError(`wait timed out for text: ${text}`, polling.timeoutMs, false);
}

async function snapshotContainsText<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  text: string,
): Promise<boolean> {
  // Presence-only poll: skip scroll-hint derivation (#1270), same as waitForFindMatch.
  const capture = await operations.captureSnapshot(runtime, options, {
    updateSession: true,
    includeHiddenContentHints: false,
  });
  return Boolean(findNodeByLabel(capture.snapshot.nodes, text));
}

// The quiet-window loop itself lives in stable-capture.ts and is shared with
// the interaction `--settle` flag (#1101); this wrapper maps the loop outcome
// to wait's throwing semantics.
async function waitForStable<Runtime extends SelectorWaitRuntime>(
  operations: SelectorWaitOperations<Runtime>,
  runtime: Runtime,
  options: WaitCommandOptions,
  quietMs: number | null | undefined,
  timeoutMs: number | null | undefined,
): Promise<Extract<WaitCommandResult, { kind: 'stable' }>> {
  const timeout = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const quiet = quietMs ?? operations.stable.defaultQuietMs;
  const outcome = await operations.stable.capture(runtime, options, {
    quietMs: quiet,
    timeoutMs: timeout,
  });
  if (!outcome.settled) {
    throw new AppError('COMMAND_FAILED', 'wait timed out waiting for a stable UI', {
      reason: 'wait_stable_timeout',
      ...(outcome.stalled ? { captureStalled: true } : {}),
      quietMs: quiet,
      timeoutMs: timeout,
      captures: outcome.captures,
      nodeCount: outcome.nodeCount,
      ...(outcome.stalled
        ? {
            hint: 'A snapshot capture stalled past the wait timeout, so no settle verdict is available. The UI may still be readable: retry, or use screenshot to inspect the surface.',
          }
        : {}),
    });
  }
  return {
    kind: 'stable',
    waitedMs: outcome.waitedMs,
    captures: outcome.captures,
    nodeCount: outcome.nodeCount,
    ...(outcome.nodeCount < operations.stable.tinyTreeNodeCount
      ? { hint: operations.stable.tinyTreeHint }
      : {}),
  };
}

function backendContext(
  runtime: SelectorWaitRuntime,
  options: WaitCommandContext,
): WaitCommandContext {
  return {
    session: options.session,
    requestId: options.requestId,
    signal: options.signal ?? runtime.signal,
    metadata: options.metadata,
  };
}

async function sleep(runtime: SelectorWaitRuntime, durationMs: number): Promise<void> {
  if (runtime.clock) await runtime.clock.sleep(durationMs);
  else await new Promise((resolve) => setTimeout(resolve, durationMs));
}
