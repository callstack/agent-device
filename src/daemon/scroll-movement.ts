import type { ScrollMovementObservation } from '@agent-device/contracts/scroll-command';
import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import type { SnapshotResult } from '@agent-device/contracts/interactor-types';
import type { CommandFlags } from '@agent-device/contracts/command';
import { isMobilePlatform, type DeviceInfo } from '@agent-device/kernel/device';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import {
  readScrollEdgeState,
  scrollNoProgressHint,
  verticalEdgeFor,
  type ScrollEdge,
} from '@agent-device/capture-kit/scroll-edge-state';
import { containsPoint } from '@agent-device/kernel/rect';
import { AppError } from '@agent-device/kernel/errors';
import type { Point, Rect, SnapshotState } from '@agent-device/kernel/snapshot';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { sleep } from '@agent-device/host-kit/retry';
import {
  areInteractionSurfaceSignaturesStable,
  buildInteractionSurfaceSignature,
  classifyBaselineSurfaceEvidence,
  discriminatingSurfaceChangedWithinRect,
  haveIdenticalDiscriminatingSurfaces,
  snapshotSurfaceComparisonKey,
  summarizeDiscriminatingSurfaceDivergence,
  type InteractionSurfaceChange,
  type InteractionSurfaceSignature,
} from './interaction-outcome-policy.ts';
import { refFrameState } from './ref-frame.ts';
import { isPostGestureStabilizationPending } from './deferred-interaction-outcome.ts';
import type { SessionState } from './session-state.ts';

/**
 * What one directional scroll saw after its gesture, and the only thing that can back the distance
 * the same response reports (#2714).
 *
 * `scroll <direction>` used to answer with the travel its gesture plan had computed. That number
 * describes the swipe that was dispatched, not the content that moved, so a scroll whose gesture
 * never reached the container reported success with a distance — repeatedly, on every retry, until a
 * later assertion failed for a reason no log explained. This module reads the difference the command
 * can actually observe: the tree the session already held before the gesture, and one tree after it.
 *
 * The evidence rules are not a second opinion on that pair. The signature, the subset-tolerant
 * baseline classifier, and the strict no-effect bar all belong to
 * `interaction-outcome-policy.ts`, the same comparators the deferred post-gesture stabilization
 * applies to every other gesture, so "that scroll did nothing" means one thing in this daemon.
 * What is new here is only WHEN the answer is owed: a directional scroll pays one capture to gate its
 * own reply instead of leaving the proof to the next command's snapshot.
 *
 * The shape of the loop is the mirror image of that stabilization: a surface that differs from the
 * baseline is answered on the first capture, so a scroll that worked pays nothing extra; only a
 * surface that looks untouched keeps polling (a mid-flight or stale read is indistinguishable from a
 * no-op until it either moves or goes quiet), and only an untouched surface at rest is ever reported.
 * The one exception is a baseline that already ended in the scrolled direction: there a differing
 * first read is an overscroll bounce until it holds still (`baselineEndsInDirection`).
 *
 * Nothing is classified before the two trees are established to be two views of one screen, and that
 * gate runs on every capture rather than only on the quiet path. The deferred loop can adopt a new
 * producer when a capture lineage changes under it and keep going, because its question is whether the
 * surface ever settles; this one compares against a pre-gesture tree, so a pair from different
 * lineages can never answer either way and the claim is withheld rather than re-based.
 */

/** How long a scroll keeps asking whether an untouched surface is really untouched (#1542's window). */
const MOVEMENT_VERDICT_BUDGET_MS = 1_500;
const MOVEMENT_POLL_MS = 200;

/** The pre-gesture surface, already in hand: no capture is spent to produce it. */
export type ScrollSurfaceBaseline = Readonly<{
  signature: InteractionSurfaceSignature;
  presentationKey: string | undefined;
  comparisonKey: string | undefined;
  /** The tree itself: whether the content already ended in the scrolled direction is asked of nodes. */
  nodes: SnapshotState['nodes'];
}>;

/** Why there is nothing honest to compare this scroll's effect against. */
export type ScrollSurfaceBaselineAbsence =
  | 'stored-surface-unusable'
  | 'stored-surface-not-current'
  | 'prior-gesture-unsettled';

/** Why this command owes no observation of its own effect. A reason, never text to match. */
export type ScrollMovementInapplicability =
  | 'owner-without-capture'
  | 'non-swipe-platform'
  | 'caller-declined-observation'
  | 'settle-observer-owns-outcome';

/**
 * Everything about this scroll's observation that is knowable before it dispatches, decided once, in
 * one place: whether the command owes the read at all, and what it gets to compare against.
 *
 * The declines are the device's and the caller's — a platform that moves content with a wheel or a JS
 * step instead of a synthesized swipe, a caller that pays for its own observation (Maestro's replay
 * loop), and `--settle`, which freezes its own baseline and already answers whether the surface
 * moved. Whether the bound runtime can read a screen at all is the one fact not knowable here, since
 * binding happens after this returns; that owner reports its own `owner-without-capture`.
 */
export type ScrollMovementPlan =
  | Readonly<{
      kind: 'declined';
      reason: Exclude<ScrollMovementInapplicability, 'owner-without-capture'>;
    }>
  | Readonly<{ kind: 'unobservable'; reason: ScrollSurfaceBaselineAbsence }>
  | Readonly<{ kind: 'observe'; baseline: ScrollSurfaceBaseline }>;

export function planScrollMovement(params: {
  device: DeviceInfo;
  flags: CommandFlags | undefined;
  session: SessionState;
}): ScrollMovementPlan {
  if (!isMobilePlatform(params.device)) return { kind: 'declined', reason: 'non-swipe-platform' };
  if (params.flags?.postGestureStabilization === false) {
    return { kind: 'declined', reason: 'caller-declined-observation' };
  }
  if (params.flags?.settle === true) {
    return { kind: 'declined', reason: 'settle-observer-owns-outcome' };
  }
  return freezeScrollSurfaceBaseline(params.session);
}

/** Where the swipe ran, so a container elsewhere on the screen cannot be blamed for the no-op. */
export type ScrollSwipeEvidence = Readonly<{
  /** Midpoint of the dispatched gesture, in the same space as a snapshot rect. */
  midpoint?: Point;
  /** The travel the gesture plan produced, reported on the refusal. */
  pixels?: number;
}>;

export function readScrollSurfaceBaseline(
  snapshot: SnapshotState | undefined,
): ScrollSurfaceBaseline | undefined {
  if (!snapshot || snapshot.nodes.length === 0) return undefined;
  const signature = buildInteractionSurfaceSignature(snapshot.nodes);
  if (signature.length === 0) return undefined;
  return {
    signature,
    presentationKey: snapshot.presentationKey,
    comparisonKey: snapshotSurfaceComparisonKey(snapshot),
    nodes: snapshot.nodes,
  };
}

/**
 * Freezes what a directional scroll can compare its own effect against, at the one moment that
 * answer is available: before the command dispatches.
 *
 * The tree the session stores is not automatically the screen as it stands — a mutation may have
 * happened since it was captured, and its own gesture is about to be another one. ADR 0014 already
 * encodes exactly that question: the ref frame stays `active` while no device side effect has
 * crossed since the last publication, which is while the stored tree still is the newest
 * observation. Anything else and there is nothing honest to compare against, so this names the reason
 * instead of letting a stale tree back a movement claim (#2714).
 */
function freezeScrollSurfaceBaseline(session: SessionState): ScrollMovementPlan {
  const baseline = readScrollSurfaceBaseline(session.snapshot);
  if (!baseline) return { kind: 'unobservable', reason: 'stored-surface-unusable' };
  if (refFrameState(session) !== 'active') {
    return { kind: 'unobservable', reason: 'stored-surface-not-current' };
  }
  if (isPostGestureStabilizationPending(session)) {
    // A gesture nobody has read yet may still be moving this tree, which would bill its motion to
    // the scroll being dispatched now.
    return { kind: 'unobservable', reason: 'prior-gesture-unsettled' };
  }
  return { kind: 'observe', baseline };
}

/**
 * Observes one directional scroll and returns the movement its response may claim.
 *
 * Throws `scroll_no_progress` when it proves the gesture did not land: the surface is byte-for-byte
 * what it was, the tree still names hidden content in the direction that was scrolled, and the swipe
 * ran inside that container. Every other untouched surface answers honestly instead — at the edge of
 * the content, in a direction with no end-of-content signal, or as `unobserved` when the evidence
 * would not support the claim either way.
 *
 * A capture that fails does not fail the scroll: the gesture already happened, so an unreadable tree
 * answers `unobserved` and leaves the caller's scroll succeeded.
 */
export async function observeScrollMovement(params: {
  direction: ScrollDirection;
  baseline: ScrollSurfaceBaseline;
  swipe: ScrollSwipeEvidence;
  capture: () => Promise<SnapshotResult>;
  /** The same two overrides `pollForScrollRest` takes: how long to ask, and how often. */
  budgetMs?: number;
  pollMs?: number;
}): Promise<ScrollMovementObservation> {
  const { direction, baseline, swipe } = params;
  const verdict = await pollForSurfaceVerdict(baseline, params);
  switch (verdict.kind) {
    case 'moved':
      return await claimMoved({ ...verdict, direction, baseline, swipe });
    case 'blind':
      return reportScrollMovementUnobserved(direction, verdict.reason, { swipe });
    case 'settled':
      return await decideUnchanged({ ...verdict, direction, baseline, swipe });
  }
}

/** What the polling could say about the surface, before any of it is interpreted. */
type SurfaceVerdict =
  | Readonly<{
      kind: 'moved';
      observed: ObservedSurface;
      attempts: number;
      startedAt: number;
    }>
  | Readonly<{ kind: 'blind'; reason: SurfaceBlindReason }>
  | Readonly<{
      kind: 'settled';
      observed: ObservedSurface;
      evidence: InteractionSurfaceChange;
      attempts: number;
      startedAt: number;
    }>;

/** Why this capture cannot be compared against the pre-gesture tree at all, movement included. */
type SurfaceBlindReason = 'capture-unreadable' | 'surface-unsettled' | ScrollSurfacePairDrift;

/**
 * Whether two captures describe one screen. Capture backends do not agree on which nodes exist, so a
 * pair across a lineage change — the XCTest-channel fallback swapping the producer mid-request
 * (#1569) — or across the interactive-only difference `snapshot -i` stores says nothing about
 * movement in either direction, however different the two trees look.
 */
type ScrollSurfacePairDrift = 'baseline-presentation-drift' | 'capture-lineage-drift';

function surfacePairDrift(
  baseline: ScrollSurfaceBaseline,
  observed: ObservedSurface,
): ScrollSurfacePairDrift | undefined {
  if (baseline.presentationKey !== observed.presentationKey) return 'baseline-presentation-drift';
  if (baseline.comparisonKey !== observed.comparisonKey) return 'capture-lineage-drift';
  return undefined;
}

/**
 * Polls until an untouched surface proves itself. A surface that differs from the baseline is a
 * verdict on the first capture, so a scroll that worked pays for one read, unless the baseline
 * already ended in the scrolled direction, where the change must hold still first
 * (`baselineEndsInDirection`). One that looks untouched
 * needs a quiet pair, because a gesture still in flight and a gesture that did nothing answer a
 * single read identically. A surface that never holds still expires as `surface-unsettled` rather
 * than being called a no-op — and that answer is worth a warning the others are not, since it spent
 * the whole budget confirming nothing.
 */
async function pollForSurfaceVerdict(
  baseline: ScrollSurfaceBaseline,
  params: {
    direction: ScrollDirection;
    capture: () => Promise<SnapshotResult>;
    budgetMs?: number;
    pollMs?: number;
    swipe: ScrollSwipeEvidence;
  },
): Promise<SurfaceVerdict> {
  const startedAt = Date.now();
  const deadline = startedAt + (params.budgetMs ?? MOVEMENT_VERDICT_BUDGET_MS);
  let previous: InteractionSurfaceSignature | undefined;
  let attempts = 0;
  let changeNeedsRest: boolean | undefined;

  while (true) {
    const reading = await readOneCapture(baseline, params.capture);
    attempts += 1;
    if (reading.kind === 'blind') return { kind: 'blind', reason: reading.reason };
    if (reading.kind === 'changed') {
      changeNeedsRest ??= await baselineEndsInDirection(baseline, params.direction, params.swipe);
    }
    const verdict = settledVerdict(reading, {
      previous,
      changeNeedsRest: changeNeedsRest === true,
      attempts,
      startedAt,
    });
    if (verdict) return verdict;
    if (Date.now() >= deadline) return budgetExpiredVerdict(params, attempts, startedAt);
    previous = reading.observed.signature;
    await sleep(params.pollMs ?? MOVEMENT_POLL_MS);
  }
}

/**
 * The verdict one readable capture supports, or nothing yet. A changed surface is movement on sight
 * unless the baseline already ended in that direction, where it must hold still first; an unchanged
 * surface is settled only as the second of a quiet pair.
 */
function settledVerdict(
  reading: Exclude<CaptureReading, { kind: 'blind' }>,
  poll: {
    previous: InteractionSurfaceSignature | undefined;
    changeNeedsRest: boolean;
    attempts: number;
    startedAt: number;
  },
): SurfaceVerdict | undefined {
  const atRest = surfaceIsAtRest(poll.previous, reading.observed.signature);
  const { attempts, startedAt } = poll;
  if (reading.kind === 'changed') {
    if (!poll.changeNeedsRest || atRest) {
      return { kind: 'moved', observed: reading.observed, attempts, startedAt };
    }
    return undefined;
  }
  if (!atRest) return undefined;
  return {
    kind: 'settled',
    observed: reading.observed,
    evidence: reading.evidence,
    attempts,
    startedAt,
  };
}

/**
 * Whether the pre-gesture tree already showed the end of the content in the scrolled direction. A
 * scroll past that edge on iOS rubber-bands: the first capture lands mid-bounce with every row shifted
 * by a few points and reads as `changed`, then the content springs back to exactly the baseline, which
 * is what the next command's stabilization later observes as a stale-accept (#2884). So a change against
 * a baseline that had nothing left to reveal is credited only once the surface holds still and still
 * differs; a scroll whose baseline still hid content keeps paying one read.
 */
async function baselineEndsInDirection(
  baseline: ScrollSurfaceBaseline,
  direction: ScrollDirection,
  swipe: ScrollSwipeEvidence,
): Promise<boolean> {
  const edge = verticalEdgeFor(direction);
  if (!edge) return false;
  // The question is asked of the scroller the swipe ran in, through the selection the edge verdict
  // uses: among the containers holding the point, the one that still hides content in that
  // direction. An inner list at its end inside an outer list with more below hands the gesture to
  // the outer list, so the outer list's edge is what gates the claim.
  const state = await readScrollEdgeState(baseline.nodes, edge, { point: swipe.midpoint });
  const ends = state.containerRect !== undefined && !state.canScroll;
  if (ends) {
    emitDiagnostic({
      level: 'debug',
      phase: 'scroll_movement_edge_rest_required',
      data: { direction, containerRect: state.containerRect },
    });
  }
  return ends;
}

/**
 * What a single capture says, on its own: nothing at all when the tree could not be read or comes from
 * another lineage, movement when the surface differs from the baseline, and otherwise the untouched
 * pair the loop has to prove is at rest before it can be reported.
 */
type CaptureReading =
  | Readonly<{ kind: 'blind'; reason: SurfaceBlindReason }>
  | Readonly<{ kind: 'changed'; observed: ObservedSurface }>
  | Readonly<{ kind: 'unchanged'; observed: ObservedSurface; evidence: InteractionSurfaceChange }>;

async function readOneCapture(
  baseline: ScrollSurfaceBaseline,
  capture: () => Promise<SnapshotResult>,
): Promise<CaptureReading> {
  const observed = await captureSurface(capture);
  if (!observed) return { kind: 'blind', reason: 'capture-unreadable' };
  const drift = surfacePairDrift(baseline, observed);
  if (drift) return { kind: 'blind', reason: drift };
  const evidence = classifyBaselineSurfaceEvidence(baseline.signature, observed.signature);
  if (evidence === 'changed') return { kind: 'changed', observed };
  return { kind: 'unchanged', observed, evidence };
}

/**
 * The surface never held still, so this command spent its whole budget confirming nothing. That answer
 * is worth a warning the others are not: it is also the one that cost the caller the most.
 */
function budgetExpiredVerdict(
  params: {
    direction: ScrollDirection;
    swipe: ScrollSwipeEvidence;
  },
  attempts: number,
  startedAt: number,
): SurfaceVerdict {
  emitDiagnostic({
    level: 'warn',
    phase: 'scroll_movement_budget_expired',
    data: {
      direction: params.direction,
      attempts,
      durationMs: Date.now() - startedAt,
      ...(params.swipe.pixels === undefined ? {} : { requestedPixels: params.swipe.pixels }),
    },
  });
  return { kind: 'blind', reason: 'surface-unsettled' };
}

function surfaceIsAtRest(
  previous: InteractionSurfaceSignature | undefined,
  next: InteractionSurfaceSignature,
): boolean {
  return previous !== undefined && areInteractionSurfaceSignaturesStable(previous, next);
}

type ObservedSurface = Readonly<{
  signature: InteractionSurfaceSignature;
  presentationKey: string | undefined;
  comparisonKey: string | undefined;
  /** The tree itself: the edge question is asked of nodes, not of the identity signature. */
  nodes: SnapshotState['nodes'];
}>;

async function captureSurface(
  capture: () => Promise<SnapshotResult>,
): Promise<ObservedSurface | undefined> {
  let result: SnapshotResult;
  try {
    result = await capture();
  } catch {
    // The gesture is already done; a tree this command cannot read withholds the claim, it does not
    // undo the scroll.
    return undefined;
  }
  const state = buildSnapshotState(result, undefined);
  return {
    signature: buildInteractionSurfaceSignature(state.nodes),
    presentationKey: state.presentationKey,
    comparisonKey: snapshotSurfaceComparisonKey(state),
    nodes: state.nodes,
  };
}

/**
 * A changed surface credits the gesture only when the change sits inside the scroller the swipe ran
 * in. The captured tree carries system chrome along with the app's content, and on Android the status
 * bar clocks and icons change on their own while a frozen list sits underneath them — measured on the
 * tester's `/catalog`, a battery icon alone turned the pair into "changed" over a list that never
 * moved. Without a container to confine the claim to (no scroller resolved, or the horizontal axis the
 * analyzer does not read) the whole-surface difference is all there is, and stays the answer.
 */
async function claimMoved(params: {
  direction: ScrollDirection;
  baseline: ScrollSurfaceBaseline;
  swipe: ScrollSwipeEvidence;
  observed: ObservedSurface;
  attempts: number;
  startedAt: number;
}): Promise<ScrollMovementObservation> {
  const { direction, baseline, swipe, observed } = params;
  const edge = verticalEdgeFor(direction);
  const containerRect = edge
    ? (await readScrollEdgeState(observed.nodes, edge)).containerRect
    : undefined;
  if (
    containerRect &&
    !discriminatingSurfaceChangedWithinRect(baseline.signature, observed.signature, containerRect)
  ) {
    return reportScrollMovementUnobserved(direction, 'change-outside-container', {
      swipe,
      containerRect,
    });
  }
  return reportObserved(direction, 'moved', swipe, params.attempts, params.startedAt);
}

async function decideUnchanged(params: {
  direction: ScrollDirection;
  baseline: ScrollSurfaceBaseline;
  swipe: ScrollSwipeEvidence;
  observed: ObservedSurface;
  evidence: InteractionSurfaceChange;
  attempts: number;
  startedAt: number;
}): Promise<ScrollMovementObservation> {
  const { direction, baseline, observed, evidence, swipe } = params;
  const comparison = settledPairBlindness(baseline, observed, evidence);
  if (comparison)
    return reportScrollMovementUnobserved(direction, comparison.reason, {
      swipe,
      divergence: comparison.divergence,
    });
  return await decideEdgeVerdict(params);
}

type SurfaceComparison = Readonly<{
  reason: 'no-comparable-content' | 'surface-divergence';
  divergence?: Record<string, unknown>;
}>;

/**
 * What a pair already known comparable still cannot say about being untouched. The subset-tolerant
 * classifier is 'unchanged' for a narrower capture of the same screen, so the no-effect claim needs
 * the strict both-directions bar (#1601 review P1): a scroll that replaced every list cell under
 * fixed chrome must not be readable as a gesture that did nothing.
 */
function settledPairBlindness(
  baseline: ScrollSurfaceBaseline,
  observed: ObservedSurface,
  evidence: InteractionSurfaceChange,
): SurfaceComparison | undefined {
  if (evidence === 'ambiguous') return { reason: 'no-comparable-content' };
  if (!haveIdenticalDiscriminatingSurfaces(baseline.signature, observed.signature)) {
    return {
      reason: 'surface-divergence',
      divergence: summarizeDiscriminatingSurfaceDivergence(baseline.signature, observed.signature),
    };
  }
  return undefined;
}

/** What an untouched surface is: the end of the content, a direction with no edge to read, or a gesture that never landed. */
async function decideEdgeVerdict(params: {
  direction: ScrollDirection;
  swipe: ScrollSwipeEvidence;
  observed: ObservedSurface;
  attempts: number;
  startedAt: number;
}): Promise<ScrollMovementObservation> {
  const { direction, observed, swipe } = params;
  const edge = verticalEdgeFor(direction);
  if (!edge) {
    // The hidden-content analyzer reads the vertical axis only, so a horizontal scroll that moved
    // nothing cannot tell a pager at its end from a list that ignored the swipe. It reports what it
    // measured and leaves the two apart, rather than guessing.
    return reportObserved(direction, 'unchanged', swipe, params.attempts, params.startedAt);
  }

  const edgeState = await readScrollEdgeState(observed.nodes, edge);
  const containerRect = edgeState.containerRect;
  if (!containerRect) {
    // `canScroll: false` here means the tree named no scroll container at all, which says nothing
    // about where the content ends.
    return reportScrollMovementUnobserved(direction, 'no-scroll-container', { swipe });
  }
  if (swipe.midpoint && !containerHoldsSwipe(containerRect, swipe.midpoint)) {
    return reportScrollMovementUnobserved(direction, 'container-outside-swipe', {
      swipe,
      containerRect,
    });
  }
  if (edgeState.canScroll) {
    throw scrollNoProgressError(direction, edge, swipe, containerRect);
  }
  return reportObserved(direction, 'at-edge', swipe, params.attempts, params.startedAt);
}

function containerHoldsSwipe(containerRect: Rect, midpoint: Point): boolean {
  return containsPoint(containerRect, midpoint.x, midpoint.y);
}

/**
 * The gesture did not reach the container: hidden content is still there, and the surface never
 * moved. Same typed family as `scroll_edge_no_progress` and `scroll_until_no_progress`, and the same
 * hint, because the caller's next move is the same whichever loop noticed.
 */
function scrollNoProgressError(
  direction: ScrollDirection,
  edge: ScrollEdge,
  swipe: ScrollSwipeEvidence,
  containerRect: Rect,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `scroll ${direction} moved nothing: the container still reports hidden content ${
      edge === 'bottom' ? 'below' : 'above'
    } and its contents never shifted`,
    {
      reason: 'scroll_no_progress',
      direction,
      hiddenContentAt: edge,
      containerRect,
      ...(swipe.pixels === undefined ? {} : { requestedPixels: swipe.pixels }),
      hint: scrollNoProgressHint({
        targetDirectly: `with scroll ${direction} --until <selector>`,
        rawDrag: swipe.midpoint !== undefined,
      }),
    },
  );
}

/**
 * Why a scroll that owed an observation could not make one: no usable baseline before the gesture, no
 * readable or settled tree after it, or a pair that turned out not to be comparable. A reason, never
 * text a caller has to match.
 */
export type ScrollMovementUnobservedReason =
  | ScrollSurfaceBaselineAbsence
  | SurfaceBlindReason
  | 'no-comparable-content'
  | 'surface-divergence'
  | 'no-scroll-container'
  | 'container-outside-swipe'
  | 'change-outside-container';

/** What accompanies the reason in the daemon log, so one line explains the whole verdict. */
export type ScrollMovementUnobservedEvidence = Readonly<{
  swipe: ScrollSwipeEvidence;
  /** What the two surfaces disagreed on, for a `surface-divergence`. */
  divergence?: Record<string, unknown>;
  /** The scroll container the edge analyzer resolved, when it resolved one. */
  containerRect?: Rect;
}>;

/**
 * Tells the daemon log that this command owed no observation at all — the owner cannot read a
 * screen, the device has no swipe to verify, or the caller (or another observer) already declined
 * or owns that read. The response carries no `movement` field, so the reason has to live somewhere.
 */
export function reportScrollMovementNotApplicable(
  direction: ScrollDirection,
  reason: ScrollMovementInapplicability,
): void {
  emitDiagnostic({
    level: 'debug',
    phase: 'scroll_movement_not_applicable',
    data: { direction, reason },
  });
}

/**
 * Records why a scroll that DID owe an observation could not make one, and answers `unobserved`: the
 * distance it reports then rests on the gesture plan alone.
 */
export function reportScrollMovementUnobserved(
  direction: ScrollDirection,
  reason: ScrollMovementUnobservedReason,
  evidence: ScrollMovementUnobservedEvidence,
): ScrollMovementObservation {
  emitDiagnostic({
    level: 'info',
    phase: 'scroll_movement_unobserved',
    data: {
      direction,
      reason,
      ...(evidence.swipe.pixels === undefined ? {} : { requestedPixels: evidence.swipe.pixels }),
      ...(evidence.divergence ?? {}),
      ...(evidence.containerRect === undefined ? {} : { containerRect: evidence.containerRect }),
    },
  });
  return 'unobserved';
}

function reportObserved(
  direction: ScrollDirection,
  movement: Exclude<ScrollMovementObservation, 'unobserved'>,
  swipe: ScrollSwipeEvidence,
  attempts: number,
  startedAt: number,
): ScrollMovementObservation {
  emitDiagnostic({
    level: movement === 'moved' ? 'debug' : 'info',
    phase: 'scroll_movement_observed',
    data: {
      direction,
      movement,
      attempts,
      durationMs: Date.now() - startedAt,
      ...(swipe.pixels === undefined ? {} : { requestedPixels: swipe.pixels }),
    },
  });
  return movement;
}
