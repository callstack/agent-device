import type { CommandFlags } from '@agent-device/contracts/command';
import type { SettleObservation, SettleParams } from '@agent-device/contracts/interaction';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { commandSupportsSettleObservation } from '../core/command-descriptor/registry.ts';
import {
  captureSnapshotForSession,
  createInteractionRuntime,
  readSettleRequest,
  settleFlagGuardResponse,
} from './interaction/index.ts';
import type { BoundContextFromFlags } from './context.ts';
import { issueSettleRefs } from './session-snapshot.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';

/**
 * `--settle` on the generic daemon route (#1638): `scroll` and `back` change
 * the screen without resolving an element, so they never reach the interaction
 * handler that owns the touch commands' settle wiring — but scroll-then-observe
 * and back-then-observe are exactly the pairs an agent wants collapsed into one
 * call. This module is the generic route's half of that contract.
 *
 * It is reached through a LAZY SEAM (`await import`) from
 * request-generic-dispatch, and hands back a CLOSURE rather than a plan object,
 * so that dispatcher needs no static edge here — not even a type-only one. That
 * is not incidental: observing a settled screen runs the interaction runtime, a
 * subgraph the generic dispatcher otherwise never touches, and a static edge
 * folds all ~18 of its files into the daemon-server type cycle (R10 caught
 * exactly that). An ordinary scroll/back pays neither the import nor the
 * comprehension cost.
 *
 * Two seams, and the order between them is load-bearing:
 *
 * 1. {@link planGenericSettleObservation} runs BEFORE the command dispatches and
 *    freezes the diff baseline. The baseline is the session's STORED pre-action
 *    tree, so the diff reads "settled tree vs the last tree you observed" — it
 *    may be several commands old, unlike press's freshly resolved pre-action
 *    capture. That is the honest #1101 contract for a route with no resolution
 *    step, and the settle loop's own captures overwrite `session.snapshot`, so
 *    reading it afterwards would compare the settled tree against itself.
 * 2. The returned observer runs AFTER the command AND after
 *    `markDeferredInteractionOutcome`. Marking first is what lets settle's very
 *    first capture fold in the #1542 post-gesture stabilization instead of
 *    racing it — every capture on this path goes through the same deferred
 *    outcome resolution a plain snapshot would.
 */

/** Runs the settle loop and returns the observation to attach as `data.settle`. */
export type GenericSettleObserver = () => Promise<SettleObservation | undefined>;

export type GenericSettlePlan = { response: DaemonResponse } | { observe?: GenericSettleObserver };

type GenericSettleContext = {
  req: DaemonRequest;
  session: SessionState;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  contextFromFlags: BoundContextFromFlags;
};

/**
 * Rejects an orphaned `--settle-quiet` up front (the shared flag grammar), and
 * otherwise returns the observer this dispatch owes — with the pre-action
 * baseline already captured.
 */
export function planGenericSettleObservation(
  params: GenericSettleContext & { command: string; flags: CommandFlags | undefined },
): GenericSettlePlan {
  if (!commandSupportsSettleObservation(params.command)) return {};
  const invalidSettleFlags = settleFlagGuardResponse(params.command, params.flags);
  if (invalidSettleFlags) return { response: invalidSettleFlags };
  const settle = readSettleRequest(params.flags);
  if (!settle) return {};
  const baselineNodes = params.session.snapshot?.nodes ?? [];
  return { observe: async () => await observeSettled(params, settle, baselineNodes) };
}

/**
 * Best-effort like the settle engine itself: the action already succeeded, so a
 * runtime that cannot even be constructed (session evicted mid-request)
 * degrades to no observation rather than failing the response. `refsGeneration`
 * is folded in when the settled diff actually published refs (ADR 0014 — see
 * `settle-ref-issuance.ts`).
 */
async function observeSettled(
  context: GenericSettleContext,
  settle: SettleParams,
  baselineNodes: SnapshotNode[],
): Promise<SettleObservation | undefined> {
  const runtime = createGenericSettleRuntime(context);
  if (!runtime) return undefined;
  // R2: the daemon reaches the settle engine through the runtime command
  // surface, never by importing `commands/` — the same seam the touch handlers
  // use for press/fill.
  const observation = await runtime.interactions.settleObservation({
    ...settle,
    baselineNodes,
    session: context.sessionName,
    requestId: context.req.meta?.requestId,
  });
  const refsGeneration = issueSettleRefs(context.session, observation);
  return refsGeneration === undefined ? observation : { ...observation, refsGeneration };
}

function createGenericSettleRuntime(
  context: GenericSettleContext,
): ReturnType<typeof createInteractionRuntime> | undefined {
  try {
    return createInteractionRuntime({
      req: context.req,
      sessionName: context.sessionName,
      logPath: context.logPath,
      sessionStore: context.sessionStore,
      contextFromFlags: context.contextFromFlags,
      captureSnapshotForSession,
    });
  } catch {
    return undefined;
  }
}
