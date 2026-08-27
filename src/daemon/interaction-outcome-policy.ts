import type { CommandFlags } from '@agent-device/contracts/command';
import { isMobilePlatform } from '@agent-device/kernel/device';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { collectKeyboardChromeRefs } from '../core/snapshot-chrome.ts';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { isViewportRootNode } from '@agent-device/contracts/snapshot';
import { contextFromFlags, type DaemonCommandContext } from './context.ts';
import type { SessionState } from './types.ts';

const OUTCOME_RETRY_WINDOW_MS = 30_000;
const OUTCOME_RETRY_ATTEMPTS = 2;
const RECT_TOLERANCE_PX = 1;

export type InteractionSurfaceSignature = NonNullable<
  SessionState['pendingInteractionOutcome']
>['preSignature'];

export type InteractionSurfaceChange = 'changed' | 'unchanged' | 'ambiguous';

/**
 * How this policy re-fires a recorded tap. The policy owns *whether* a retry is warranted; the
 * request route that already admitted a device cell owns *how* the tap reaches the device, and
 * supplies it here. Keeping the seam a plain callback is what stops the policy from importing
 * runtime admission — a read of "should we retry?" must stay readable without the binding stack.
 *
 * Answers `false` when the caller's owner cannot tap, so the policy can report a skipped retry
 * instead of burning an attempt.
 */
export type InteractionRetryTap = (
  request: Readonly<{
    device: SessionState['device'];
    point: Readonly<{ x: number; y: number }>;
    context: InteractionRetryContext;
  }>,
) => Promise<boolean>;

/** The runner metadata a re-fired tap carries — the same context any bound touch executes on. */
export type InteractionRetryContext = DaemonCommandContext &
  Readonly<{ surface?: SessionState['surface'] }>;

function shouldRetryTouchOnNoChange(flags: CommandFlags | undefined): boolean {
  return flags?.interactionOutcome?.retryOnNoChange === true;
}

export function markPendingInteractionOutcome(params: {
  session: SessionState;
  command: string;
  positionals: string[];
  flags: CommandFlags | undefined;
  preSnapshot: SnapshotState | undefined;
}): void {
  const { session, command, positionals, flags, preSnapshot } = params;
  if (!shouldRetryTouchOnNoChange(flags)) return;
  if (!supportsInteractionOutcomePolicy(session)) return;
  const retryCommand = retryCommandForTap(command);
  if (!retryCommand) return;
  if (!isCoordinatePair(positionals)) return;
  const preSignature = buildInteractionSurfaceSignature(preSnapshot?.nodes ?? []);
  if (preSignature.length === 0) return;
  session.pendingInteractionOutcome = {
    action: command,
    command: retryCommand,
    positionals,
    flags: stripInternalInteractionFlags(flags),
    markedAt: Date.now(),
    attemptsRemaining: OUTCOME_RETRY_ATTEMPTS,
    preSignature,
  };
}

export function getActivePendingInteractionOutcome(
  session: SessionState | undefined,
): NonNullable<SessionState['pendingInteractionOutcome']> | undefined {
  const pending = session?.pendingInteractionOutcome;
  if (!session || !pending) return undefined;
  if (!supportsInteractionOutcomePolicy(session)) {
    clearPendingInteractionOutcome(session);
    return undefined;
  }
  if (Date.now() - pending.markedAt > OUTCOME_RETRY_WINDOW_MS) {
    clearPendingInteractionOutcome(session);
    return undefined;
  }
  return pending;
}

export function clearPendingInteractionOutcome(session: SessionState | undefined): void {
  if (!session?.pendingInteractionOutcome) return;
  session.pendingInteractionOutcome = undefined;
}

export async function retryPendingInteractionOutcome(params: {
  session: SessionState;
  pending: NonNullable<SessionState['pendingInteractionOutcome']>;
  logPath: string;
  snapshot: SnapshotState;
  retryTap?: InteractionRetryTap;
}): Promise<{ retried: boolean; change: InteractionSurfaceChange }> {
  const { pending, snapshot } = params;
  const change = classifyInteractionSurfaceChange(
    pending.preSignature,
    buildInteractionSurfaceSignature(snapshot.nodes),
  );
  if (change !== 'unchanged' || pending.attemptsRemaining <= 0) {
    return { retried: false, change };
  }

  // The retry re-fires the same coordinate tap the original press used (R48). Nothing was
  // attempted when this capture path carries no retry seam or the recorded coordinates are
  // unreadable, so those leave the pending record whole instead of burning an attempt, and say so
  // rather than letting the caller infer it from an unchanged surface.
  const retryTap = params.retryTap;
  const point = retryTap ? readRetryPoint(pending.positionals) : undefined;
  if (!retryTap || !point) {
    emitSkippedRetry(pending, retryTap ? 'unreadable-retry-point' : 'device-runtime-unavailable');
    return { retried: false, change };
  }

  const startedAt = Date.now();
  // Spent before the device work, matching the retired route: an owner that refuses the tap or
  // fails mid-flight has still consumed the attempt, so the next capture inside the pending
  // window cannot re-attempt it from a full budget.
  pending.attemptsRemaining -= 1;
  // Opt-in Maestro retries intentionally re-fire the same coordinate tap; delayed or
  // non-visual side effects can duplicate, but unchanged visual taps are the target gap.
  const fired = await fireRetryTap(retryTap, params);
  if (!fired) {
    emitSkippedRetry(pending, 'retry-tap-unavailable');
    return { retried: false, change };
  }

  emitDiagnostic({
    level: 'info',
    phase: 'interaction_no_change_retry',
    data: {
      action: pending.action,
      attemptsRemaining: pending.attemptsRemaining,
      durationMs: Date.now() - startedAt,
    },
  });
  return { retried: true, change };
}

/**
 * The seam is allowed to refuse and allowed to fail; neither may escape into the capture this
 * retry decorates. A press whose re-fire dies on the device leaves the caller with the honest
 * unchanged surface plus a diagnostic, not a failed `snapshot`.
 */
async function fireRetryTap(
  retryTap: InteractionRetryTap,
  params: Readonly<{
    session: SessionState;
    pending: NonNullable<SessionState['pendingInteractionOutcome']>;
    logPath: string;
  }>,
): Promise<boolean> {
  const { session, pending } = params;
  const point = readRetryPoint(pending.positionals);
  if (!point) return false;
  try {
    return await retryTap({
      device: session.device,
      point,
      context: {
        ...contextFromFlags(
          params.logPath,
          pending.flags,
          session.appBundleId,
          session.trace?.outPath,
        ),
        surface: session.surface,
      },
    });
  } catch {
    return false;
  }
}

/** Never silent: a retry the opt-in flag asked for and this request did not deliver says why. */
function emitSkippedRetry(
  pending: NonNullable<SessionState['pendingInteractionOutcome']>,
  reason: 'device-runtime-unavailable' | 'unreadable-retry-point' | 'retry-tap-unavailable',
): void {
  emitDiagnostic({
    level: 'info',
    phase: 'interaction_no_change_retry_skipped',
    data: {
      action: pending.action,
      attemptsRemaining: pending.attemptsRemaining,
      reason,
    },
  });
}

export function emitInteractionSettled(params: {
  pending: NonNullable<SessionState['pendingInteractionOutcome']>;
  change: InteractionSurfaceChange;
  attempts: number;
  startedAt: number;
}): void {
  emitDiagnostic({
    level: params.attempts > 0 ? 'info' : 'debug',
    phase: 'interaction_settled',
    data: {
      action: params.pending.action,
      change: params.change,
      attempts: params.attempts,
      durationMs: Date.now() - params.startedAt,
    },
  });
}

export function emitInteractionSettleTimeout(params: {
  pending: NonNullable<SessionState['pendingInteractionOutcome']>;
  attempts: number;
  startedAt: number;
}): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'interaction_settle_timeout',
    data: {
      action: params.pending.action,
      attempts: params.attempts,
      durationMs: Date.now() - params.startedAt,
    },
  });
}

export function stripInternalInteractionFlags(
  flags: CommandFlags | undefined,
): CommandFlags | undefined {
  if (!flags?.interactionOutcome && !flags?.postGestureStabilization) return flags;
  const {
    interactionOutcome: _interactionOutcome,
    postGestureStabilization: _postGestureStabilization,
    ...publicFlags
  } = flags;
  return publicFlags;
}

export function buildInteractionSurfaceSignature(
  nodes: SnapshotNode[],
): InteractionSurfaceSignature {
  const occurrenceCounts = new Map<string, number>();
  const entries: InteractionSurfaceSignature = [];
  // Computed once per signature build (needs the whole tree for the
  // ancestor/descendant walk `collectKeyboardChrome` does — see
  // `isNonDiscriminatingSurfaceNode`), not per node.
  const keyboardChromeRefs = collectKeyboardChromeRefs(nodes);

  for (const node of nodes) {
    const entry = buildInteractionSurfaceEntry(node, occurrenceCounts, keyboardChromeRefs);
    if (entry) entries.push(entry);
  }

  return entries;
}

export function classifyInteractionSurfaceChange(
  before: InteractionSurfaceSignature,
  after: InteractionSurfaceSignature,
): InteractionSurfaceChange {
  if (before.length === 0 || after.length === 0) return 'ambiguous';
  if (areInteractionSurfaceSignaturesStable(before, after)) return 'unchanged';
  return 'changed';
}

/**
 * Shared rect-tolerance comparison for the surface-stability checks in this
 * module. Entry rects are already rounded by `buildInteractionSurfaceEntry`,
 * so one `RECT_TOLERANCE_PX` band absorbs residual drift consistently.
 */
function rectsWithinTolerance(
  a: Pick<InteractionSurfaceSignature[number], 'x' | 'y' | 'width' | 'height'>,
  b: Pick<InteractionSurfaceSignature[number], 'x' | 'y' | 'width' | 'height'>,
): boolean {
  return (
    Math.abs(a.x - b.x) <= RECT_TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= RECT_TOLERANCE_PX &&
    Math.abs(a.width - b.width) <= RECT_TOLERANCE_PX &&
    Math.abs(a.height - b.height) <= RECT_TOLERANCE_PX
  );
}

export function areInteractionSurfaceSignaturesStable(
  left: InteractionSurfaceSignature,
  right: InteractionSurfaceSignature,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b || a.key !== b.key) return false;
    if (!rectsWithinTolerance(a, b)) return false;
  }
  return true;
}

/**
 * Baseline classifier for post-gesture baseline distrust (#1542 defect 2),
 * reusing this module's three-valued `InteractionSurfaceChange` vocabulary.
 *
 * The rule is set membership, not rect deltas on the intersection, and #1569
 * is why. A scroll does not slide shared elements to new positions — it
 * REPLACES the content. Measured on the checkout form, a `scroll down 0.6`
 * that moved the whole form left exactly five identifiers in common with its
 * baseline, and all five were tab-bar icons that by construction never move.
 * Judging such a pair by "did anything in the intersection shift" asks the
 * only elements guaranteed to sit still whether anything moved, so the honest
 * signal is that the content set itself differs.
 *
 * Only entries that carry an `identity` participate. Anonymous layout nodes
 * can be matched solely by ordinal position among other anonymous nodes, and
 * the two captures rarely contain the same number of them — on that same real
 * pair the previous implementation's entire "movement" evidence was six such
 * aliased entries reporting deltas of -920, +37 and -7 px for a ~500px scroll.
 * Structural chrome (viewport root, keyboard) is excluded for the older reason
 * that its rect is invariant under any gesture.
 *
 * Set difference alone would mistake scope drift for movement: the baseline and
 * the quiet capture are routinely fetched by different callers with different
 * snapshot scopes (a broad text search vs. an interactive-only capture), and
 * the narrower one is then a strict SUBSET of the broader. Replacement is what
 * separates the two — a scroll leaves each side holding content the other
 * lacks, while scope drift only ever removes from one side.
 *
 * - `'changed'`: each side holds identified content the other does not (the
 *   surface was replaced), or a surviving element moved beyond tolerance.
 * - `'unchanged'`: everything both sides can see agrees, in the same places —
 *   the real "still showing the pre-gesture screen" signal distrust exists to
 *   catch. A one-sided difference lands here: it is scope, not movement.
 * - `'ambiguous'`: a side carries no identified content, or the two share none,
 *   so there is nothing comparable. Never treated as a match.
 *
 * Both signatures must come from the same snapshot backend; the caller owns
 * that invariant (see `deferred-interaction-outcome.ts`). Backends disagree about
 * which nodes exist, so a cross-backend pair differs for reasons that have
 * nothing to do with the gesture.
 */
export function classifyBaselineSurfaceEvidence(
  baseline: InteractionSurfaceSignature,
  current: InteractionSurfaceSignature,
): InteractionSurfaceChange {
  const before = identifiedContent(baseline);
  const after = identifiedContent(current);
  if (before.size === 0 || after.size === 0) return 'ambiguous';

  let shared = 0;
  let droppedFromBaseline = false;
  for (const [identity, seen] of before) {
    const now = after.get(identity);
    if (!now) {
      droppedFromBaseline = true;
      continue;
    }
    shared += 1;
    if (!rectsWithinTolerance(seen, now)) return 'changed';
  }
  if (shared === 0) return 'ambiguous';
  const addedSinceBaseline = after.size > shared;
  // Content left AND arrived: the surface was replaced, which is exactly what a
  // scroll that moved does. Only one of the two is a narrower or broader
  // capture of the same screen.
  if (droppedFromBaseline && addedSinceBaseline) return 'changed';
  return 'unchanged';
}

/**
 * Identity-keyed view of a signature: the entries that can be compared across a
 * gesture at all. Repeated identities (list rows sharing a label) collapse onto
 * their first occurrence, which is the one whose rect is compared — a
 * later duplicate carries no identity the first does not.
 */
function identifiedContent(
  signature: InteractionSurfaceSignature,
): Map<string, InteractionSurfaceSignature[number]> {
  const content = new Map<string, InteractionSurfaceSignature[number]>();
  for (const entry of signature) {
    if (!entry.identity || !entry.discriminating) continue;
    if (!content.has(entry.identity)) content.set(entry.identity, entry);
  }
  return content;
}

/**
 * Full-surface agreement over DISCRIMINATING entries, in BOTH directions —
 * the stronger bar an agent-facing no-effect claim needs (#1601 review P1).
 *
 * `classifyBaselineSurfaceEvidence` is deliberately subset-tolerant for the
 * distrust loop, where a false 'unchanged' only buys extra polling. But a
 * fixed-chrome screen whose list cells were fully replaced by a SUCCESSFUL
 * scroll classifies 'unchanged' on the shared chrome alone — new cells are
 * absent from the baseline and silently ignored. Requiring the discriminating
 * entry sets to match exactly (same keys both ways, every rect within
 * tolerance) vetoes that shape: any appeared or vanished real element kills
 * the claim. Scope drift between baseline and capture vetoes too — silence
 * is the safe failure mode for a message that steers the agent's next move.
 *
 * Matches on `key`, not the flip-tolerant `identity` that
 * `classifyBaselineSurfaceEvidence` uses — deliberately the opposite choice.
 * That oracle must not lose evidence to a volatile-state flip; this runs only
 * after it already returned `'unchanged'`, and a veto wants precision over
 * recall: any flip makes the keys mismatch and returns `false`, withholding
 * the claim rather than falsifying anything.
 */
export function haveIdenticalDiscriminatingSurfaces(
  left: InteractionSurfaceSignature,
  right: InteractionSurfaceSignature,
): boolean {
  const leftEntries = left.filter((entry) => entry.discriminating);
  const rightEntries = right.filter((entry) => entry.discriminating);
  if (leftEntries.length === 0 || leftEntries.length !== rightEntries.length) return false;
  // Keys carry an occurrence ordinal (`|#N`), so a map by key is lossless.
  const rightByKey = new Map(rightEntries.map((entry) => [entry.key, entry]));
  for (const entry of leftEntries) {
    const other = rightByKey.get(entry.key);
    if (!other) return false;
    if (!rectsWithinTolerance(entry, other)) return false;
  }
  return true;
}

/**
 * Why `haveIdenticalDiscriminatingSurfaces` said no, in counts a diagnostics
 * reader can aggregate. #1620 spent weeks unable to tell a cross-backend pair
 * from capture drift from real movement, because a withheld no-effect claim
 * looks identical to a gesture that simply worked: one-sided keys are
 * membership drift (depth truncation, capture composition), `rectMismatched`
 * is movement. Emitted on the accept-stale veto path so the distinction is
 * readable from a `--debug` run instead of re-derived from absence.
 */
export function summarizeDiscriminatingSurfaceDivergence(
  baseline: InteractionSurfaceSignature,
  current: InteractionSurfaceSignature,
): { onlyInBaseline: number; onlyInCurrent: number; rectMismatched: number; shared: number } {
  const currentByKey = new Map(
    current.filter((entry) => entry.discriminating).map((entry) => [entry.key, entry]),
  );
  let onlyInBaseline = 0;
  let rectMismatched = 0;
  let shared = 0;
  for (const entry of baseline) {
    if (!entry.discriminating) continue;
    const other = currentByKey.get(entry.key);
    if (!other) {
      onlyInBaseline += 1;
      continue;
    }
    currentByKey.delete(entry.key);
    shared += 1;
    if (!rectsWithinTolerance(entry, other)) rectMismatched += 1;
  }
  return { onlyInBaseline, onlyInCurrent: currentByKey.size, rectMismatched, shared };
}

function supportsInteractionOutcomePolicy(session: SessionState): boolean {
  return isMobilePlatform(session.device);
}

/**
 * The pending record stores the coordinate pair `isCoordinatePair` already validated, so this
 * only re-reads it; a record that somehow fails the read is skipped rather than retried blind.
 */
function readRetryPoint(positionals: readonly string[]): { x: number; y: number } | undefined {
  const x = Number(positionals[0]);
  const y = Number(positionals[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function retryCommandForTap(command: string): string | undefined {
  if (command === 'click') return 'press';
  if (command === 'press') return 'press';
  return undefined;
}

function buildInteractionSurfaceEntry(
  node: SnapshotNode,
  occurrenceCounts: Map<string, number>,
  keyboardChromeRefs: ReadonlySet<string>,
): InteractionSurfaceSignature[number] | undefined {
  if (!node.rect) return undefined;
  if (!isFiniteRect(node.rect)) return undefined;
  if (isScrollIndicator(node)) return undefined;
  const semanticKey = interactionSurfaceSemanticKey(node);
  if (!semanticKey) return undefined;
  const occurrence = occurrenceCounts.get(semanticKey) ?? 0;
  occurrenceCounts.set(semanticKey, occurrence + 1);
  const identity = interactionSurfaceIdentity(node);
  return {
    key: `${semanticKey}|#${occurrence}`,
    ...(identity ? { identity } : {}),
    x: Math.round(node.rect.x),
    y: Math.round(node.rect.y),
    width: Math.round(node.rect.width),
    height: Math.round(node.rect.height),
    discriminating: !isNonDiscriminatingSurfaceNode(node, keyboardChromeRefs),
  };
}

/**
 * What the element IS — never where it sits, and never volatile state a gesture
 * is expected to change. `interactionSurfaceSemanticKey` deliberately folds in
 * `hittable`/`enabled`/`selected` and an occurrence index, which is right for
 * "did these two back-to-back captures agree" and wrong for "is this the same
 * element as before the gesture": scrolling flips `hittable` the moment a
 * node's centre leaves the viewport, so keying on it evicts precisely the
 * elements whose movement would have been the evidence (#1569).
 */
function interactionSurfaceIdentity(node: SnapshotNode): string | undefined {
  const identity = [node.identifier, node.label, node.value]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .join('|');
  if (!identity.replaceAll('|', '')) return undefined;
  return `${identity}|${node.type ?? ''}`;
}

/**
 * Structurally fixed elements whose rect is invariant under a scroll/swipe by
 * construction — sharing only these between a baseline and a later capture is
 * NOT evidence the screen is unchanged, since they would read identically
 * regardless of what happened. `classifyBaselineSurfaceEvidence` excludes
 * them from the discriminating-overlap count for exactly this reason.
 *
 * Not a special case for "Application" alone, and not a container-only
 * special case for the keyboard either: both checks below reuse this repo's
 * existing kind classifications rather than inventing a narrower one.
 */
function isNonDiscriminatingSurfaceNode(
  node: SnapshotNode,
  keyboardChromeRefs: ReadonlySet<string>,
): boolean {
  return isViewportRootNode(node) || (node.ref !== undefined && keyboardChromeRefs.has(node.ref));
}

function interactionSurfaceSemanticKey(node: SnapshotNode): string | undefined {
  const semanticKey = [
    node.identifier,
    node.label,
    node.value,
    node.type,
    node.role,
    node.enabled === false ? 'disabled' : 'enabled',
    node.selected === true ? 'selected' : 'unselected',
    node.hittable === true ? 'hittable' : 'not-hittable',
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .join('|');
  return semanticKey.replaceAll('|', '') ? semanticKey : undefined;
}

function isCoordinatePair(positionals: string[]): boolean {
  if (positionals.length !== 2) return false;
  return positionals.every((value) => Number.isFinite(Number(value)));
}

function isFiniteRect(rect: NonNullable<SnapshotNode['rect']>): boolean {
  const values = [rect.x, rect.y, rect.width, rect.height];
  return values.every((value) => Number.isFinite(value)) && rect.width > 0 && rect.height > 0;
}

function isScrollIndicator(node: SnapshotNode): boolean {
  const label = `${node.label ?? ''} ${node.identifier ?? ''}`.toLowerCase();
  return label.includes('scroll bar');
}
