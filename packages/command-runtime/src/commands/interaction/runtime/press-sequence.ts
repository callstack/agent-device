import type { Point } from '@agent-device/kernel/snapshot';
import { AppError, discloseDispatch } from '@agent-device/kernel/errors';
import { localIdentitiesEqual, readNodeLocalIdentity } from '@agent-device/ad-script';
import { SELECTOR_PIPELINE_POLICIES } from '@agent-device/selectors/selector-pipeline-policy';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { resolveNodeTouchPoint } from '@agent-device/selectors/node-touch-point';
import type { AgentDeviceRuntime } from '@agent-device/contracts/runtime-contract';
import type {
  PressSequenceSummary,
  ResolvedInteractionTarget,
  SurfaceScopedNodes,
} from '@agent-device/contracts/interaction';
import { attachResolvedInteractionTarget } from '@agent-device/host-kit/interaction-outcome';
import { surfaceScopedNodes } from '@agent-device/capture-kit/snapshot-baseline';
import { normalizeRef } from '@agent-device/kernel/snapshot';
import { sleep, toBackendContext } from '../../runtime-common.ts';
import { toBackendResult } from '../../runtime-types.ts';
import { resolveInteractionTarget } from './resolution.ts';
import { guardResolvedTargetAgainstMotion } from './moving-target-gate.ts';
import { captureInteractionSnapshot } from './interaction-snapshot-capture.ts';
import { requireSnapshotSession } from './selector-read-shared.ts';
import {
  assertVisibleRefTarget,
  pointObservationOf,
  runInteractionPipelineStages,
} from './target-visibility-stages.ts';
import { EXACT_REF_RESOLUTION, describeResolvedInteractionNode } from './resolution-disclosure.ts';
import type { ResolveInteractionTargetParams } from './interaction-resolution-request.ts';
import type { PressCommandOptions, PressCommandResult } from './interactions.ts';
import {
  applyPostActionObservation,
  type PostActionObservationPlan,
  planPostActionObservation,
} from './post-action-observation.ts';

/**
 * The multi-ref press sequence (`press @e13,@e14,@e15,@e16`): one command that
 * enters a fixed key plan — a PIN pad, a passcode grid — without a snapshot
 * between keys.
 *
 * ADR 0014 safety model, kept intact:
 *
 * - The whole plan is admitted BEFORE the first dispatch. Every member resolves
 *   through the ordinary ref path (`resolveInteractionTarget`), so frame
 *   authority, occlusion, visibility, bounds, and the replay identity guard all
 *   run per key. Any refusal ends the command with the frame untouched —
 *   nothing has been dispatched.
 * - The frame expires once, at the first dispatch, through the existing
 *   `backend.tap` seam. Later keys do not consume frame authority and the frame
 *   is never reactivated: the sequence is one logical command whose plan was
 *   minted once, the same shape ADR 0014 gives `press --count`.
 * - Unlike `--count` (one physical point, repeated), a later key's mint-time
 *   coordinates are NOT trusted. Before each later dispatch the command takes a
 *   fresh read-only capture and re-finds the planned key by LOCAL IDENTITY —
 *   role/id/label, the same vocabulary the replay guard and the Android
 *   reconciliation read — requiring exactly one carrier, then re-runs the
 *   shared guard pipeline and dispatches at the fresh point. A key whose
 *   element left the screen, or whose identity now names several nodes, refuses
 *   with `sequence_ref_unmatched` instead of tapping a stale coordinate: the
 *   false-success-on-the-new-screen outcome ADR 0014 exists to prevent.
 *
 * Same-point repetition knobs (`--count`, `--hold-ms`, `--jitter-px`,
 * `--double-tap`, a non-primary button) are refused: they describe one target's
 * repetition schedule, which a multi-key plan does not have. `--interval-ms` is
 * accepted and sleeps between keys.
 */

/** The sequence form applies to ref plans only; replay and `find` shapes are single-ref. */
export function isPressSequencePlan(options: PressCommandOptions): boolean {
  return (
    (options.refs?.length ?? 0) > 1 &&
    options.target.kind === 'ref' &&
    !options.expectedResolvedTarget &&
    !options.preresolvedTarget
  );
}

/** One admitted plan member: the ref body, its mint-time resolution, and identity. */
type MintedKey = {
  ref: string;
  resolved: ResolvedInteractionTarget;
  identity: ReturnType<typeof readNodeLocalIdentity>;
};

/** The same-point repetition options a multi-key plan refuses, by flag name. */
function sequenceConflictingOption(options: PressCommandOptions): string | undefined {
  if (options.count !== undefined) return 'count';
  if (options.holdMs !== undefined) return 'hold-ms';
  if (options.jitterPx !== undefined) return 'jitter-px';
  if (options.doubleTap !== undefined) return 'double-tap';
  if (options.button !== undefined && options.button !== 'primary') return 'button';
  return undefined;
}

export async function tapRefSequenceCommand(
  runtime: AgentDeviceRuntime,
  options: PressCommandOptions,
  action: 'click' | 'press',
): Promise<PressCommandResult> {
  const refs = options.refs ?? [];
  const conflicting = sequenceConflictingOption(options);
  if (conflicting) {
    throw new AppError(
      'INVALID_ARGS',
      `A multi-ref press sequence cannot take --${conflicting}: each key is pressed once, in plan order.`,
      {
        reason: 'sequence_option_conflict',
        option: conflicting,
        hint: 'Drop the repetition option, or issue one press per key with it.',
      },
    );
  }
  if (options.target.kind !== 'ref') {
    throw new AppError('INVALID_ARGS', 'A multi-ref press sequence requires ref targets.');
  }
  if (!runtime.backend.tap) {
    throw new AppError('UNSUPPORTED_OPERATION', 'tap is not supported by this backend');
  }

  const observation = planPostActionObservation(options);
  const minted = await mintSequencePlan(runtime, options, action, refs, observation);

  // One request shape per key so any moving-target recheck asks the same
  // question the mint resolution asked.
  const resolutionRequest: ResolveInteractionTargetParams = {
    action,
    requireInteractive: true,
    pipeline: SELECTOR_PIPELINE_POLICIES.promotedTarget,
  };

  // Key 1 keeps the ordinary press path: the motion gate judges it against the
  // session's last mutation, then the dispatch crosses the frame-expiry seam
  // inside `backend.tap`.
  const atRest = await guardResolvedTargetAgainstMotion(
    runtime,
    { ...options, target: { kind: 'ref', ref: `@${minted[0]!.ref}` } },
    resolutionRequest,
    minted[0]!.resolved,
  );
  const dispatched: Point[] = [requirePoint(atRest, minted[0]!.ref)];
  let lastResolved = atRest;
  let lastBackendResult: Record<string, unknown> | undefined;
  try {
    const firstResult = await runtime.backend.tap(
      toBackendContext(runtime, options),
      dispatched[0]!,
      tapOptions(atRest),
    );
    lastBackendResult = toBackendResult(firstResult);
  } catch (error) {
    attachResolvedInteractionTarget(error, atRest);
    throw error;
  }

  // Later keys re-find on a fresh capture; the capture's presentation follows
  // the frame tree's so the carrier comparison reads the node set the plan
  // minted from (the moving-target gate's presentation-parity rule).
  const interactiveOnly = await readFramePresentation(runtime, options.session ?? 'default');
  for (const key of minted.slice(1)) {
    if (options.intervalMs !== undefined) await sleep(runtime, options.intervalMs);
    const resolved = await refindSequenceKey(runtime, options, key, action, interactiveOnly);
    const point = requirePoint(resolved, key.ref);
    try {
      const backendResult = await runtime.backend.tap(
        toBackendContext(runtime, options),
        point,
        tapOptions(resolved),
      );
      lastBackendResult = toBackendResult(backendResult);
    } catch (error) {
      attachResolvedInteractionTarget(error, resolved);
      throw error;
    }
    dispatched.push(point);
    lastResolved = resolved;
  }

  const sequence: PressSequenceSummary = {
    pressed: dispatched.length,
    refs: minted.map((key) => `@${key.ref}`),
    points: dispatched,
  };
  // `--verify`/`--settle` describe the whole command: the baseline is the
  // pre-command capture the first mint resolution took, and the reported
  // target is the last key the plan dispatched.
  return await applyPostActionObservation(
    runtime,
    options,
    withMintBaseline(lastResolved, minted[0]!.resolved),
    {
      ...lastResolved,
      ...(lastBackendResult ? { backendResult: lastBackendResult } : {}),
      sequence,
    },
    observation,
  );
}

/**
 * Admit every plan member through the ordinary ref resolution path before any
 * dispatch. A resolution that captures the evidence baseline (`--verify`/
 * `--settle`) runs on the FIRST member only: the pre-command tree is the
 * baseline, and later mint resolutions must not advance the observation
 * mid-plan.
 */
async function mintSequencePlan(
  runtime: AgentDeviceRuntime,
  options: PressCommandOptions,
  action: 'click' | 'press',
  refs: readonly string[],
  observation: PostActionObservationPlan,
): Promise<MintedKey[]> {
  const minted: MintedKey[] = [];
  for (const ref of refs) {
    if (normalizeRef(ref) !== ref) {
      throw new AppError(
        'INVALID_ARGS',
        `Invalid sequence ref "${ref}" — expected a snapshot ref body like e13.`,
      );
    }
    const resolved = await resolveInteractionTarget(
      runtime,
      { ...options, target: { kind: 'ref', ref: `@${ref}` } },
      {
        action,
        requireInteractive: true,
        pipeline: SELECTOR_PIPELINE_POLICIES.promotedTarget,
        captureEvidenceBaseline: observation.needsPreActionBaseline && minted.length === 0,
      },
    );
    if (resolved.kind === 'point' || !resolved.node) {
      throw new AppError(
        'COMMAND_FAILED',
        `Ref @${ref} resolved without a node to re-identify between keys`,
        { reason: INTERACTION_ERROR_REASONS.refNotFound, ref },
      );
    }
    minted.push({ ref, resolved, identity: readNodeLocalIdentity(resolved.node) });
  }
  return minted;
}

/**
 * Re-find one planned key on a fresh observation and resolve it through the
 * shared guard pipeline. Identity is the mint-time node's role/id/label read
 * over the fresh capture's scoped nodes; zero carriers (the element left the
 * screen) and several carriers (the identity no longer names one control) both
 * refuse — never a positional-coincidence dispatch.
 */
async function refindSequenceKey(
  runtime: AgentDeviceRuntime,
  options: PressCommandOptions,
  key: MintedKey,
  action: 'click' | 'press',
  interactiveOnly: boolean,
): Promise<ResolvedInteractionTarget> {
  const { snapshot } = await captureInteractionSnapshot(runtime, options, interactiveOnly);
  const scoped = surfaceScopedNodes(snapshot);
  const carriers = scoped.nodes.filter((candidate) =>
    localIdentitiesEqual(key.identity, readNodeLocalIdentity(candidate)),
  );
  if (carriers.length !== 1) throw sequenceKeyRefusal(key, carriers.length, scoped);
  const { node, tapPoint } = await runInteractionPipelineStages({
    policy: SELECTOR_PIPELINE_POLICIES.promotedTarget,
    nodes: scoped.nodes,
    ...(snapshot.keyboard ? { keyboard: snapshot.keyboard } : {}),
    node: carriers[0]!,
    action,
    label: `Ref @${key.ref}`,
    hooks: {
      offscreen: async (target, tree) =>
        await assertVisibleRefTarget(runtime, options, target, tree, `@${key.ref}`, {
          action,
          pipeline: SELECTOR_PIPELINE_POLICIES.promotedTarget,
        }),
    },
    resolveTapPoint: (target) =>
      resolveNodeTouchPoint(target, scoped.nodes, {
        invalidMessage: `Ref @${key.ref} has no usable bounds`,
        blockedTargetLabel: `Ref @${key.ref}`,
        blockedTargetDetails: { ref: `@${key.ref}` },
      }),
  });
  return {
    kind: 'ref',
    point: tapPoint,
    target: { kind: 'ref', ref: `@${key.ref}` },
    adoptedFrom: 'observation',
    ...describeResolvedInteractionNode(runtime, node, scoped, action, EXACT_REF_RESOLUTION),
  };
}

/** The typed refusal for a planned key the fresh screen can no longer name exactly once. */
function sequenceKeyRefusal(
  key: MintedKey,
  carrierCount: number,
  scoped: SurfaceScopedNodes,
): AppError {
  return discloseDispatch(
    new AppError(
      'COMMAND_FAILED',
      carrierCount === 0
        ? `Ref @${key.ref} no longer names a node with its planned identity`
        : `Ref @${key.ref}'s identity now names ${carrierCount} nodes; the plan cannot tell them apart`,
      {
        reason: INTERACTION_ERROR_REASONS.sequenceRefUnmatched,
        ref: `@${key.ref}`,
        identity: key.identity,
        surfaceBundleId: scoped.surfaceBundleId,
        hint: 'Keys already dispatched may have changed the screen; run snapshot -i and rebuild the remaining plan.',
      },
    ),
    'no',
  );
}

function requirePoint(resolved: ResolvedInteractionTarget, ref: string): Point {
  if (!resolved.point) {
    throw new AppError('COMMAND_FAILED', `Ref @${ref} resolved without coordinates`);
  }
  return resolved.point;
}

/**
 * The tap options each key dispatches with. A sequence takes no repetition
 * option, so the only member is the point observation: the capture that
 * measured this key's dispatched point, which a backend may draw evidence
 * about the tap from (the ordinary press path's rule).
 */
function tapOptions(resolved: ResolvedInteractionTarget): {
  pointObservation?: SurfaceScopedNodes;
} {
  const observation = pointObservationOf(resolved);
  return observation ? { pointObservation: observation } : {};
}

/**
 * The observation that measured a dispatched key's point is the key's own fresh
 * capture. `--verify`/`--settle` compare the PRE-COMMAND tree, so the final
 * observation composition carries the first mint resolution's baseline.
 */
function withMintBaseline(
  lastResolved: ResolvedInteractionTarget,
  firstMinted: ResolvedInteractionTarget,
): ResolvedInteractionTarget {
  if (!firstMinted.preAction || lastResolved.preAction === firstMinted.preAction) {
    return lastResolved;
  }
  return { ...lastResolved, preAction: firstMinted.preAction };
}

/**
 * Whether the frame tree was captured interactive-only, so the per-key re-find
 * captures read the same node vocabulary the plan minted from. Absent
 * presentation means the full tree.
 */
async function readFramePresentation(
  runtime: AgentDeviceRuntime,
  sessionName: string,
): Promise<boolean> {
  const { snapshot } = await requireSnapshotSession(runtime, sessionName);
  return snapshot.presentation?.interactiveOnly === true;
}
