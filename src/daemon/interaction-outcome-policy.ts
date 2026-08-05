import { dispatchCommand, type CommandFlags } from '../core/dispatch.ts';
import { isMobilePlatform } from '@agent-device/kernel/device';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { collectKeyboardChromeRefs } from '../core/snapshot-chrome.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { isViewportRootNode } from '@agent-device/contracts/snapshot';
import { contextFromFlags } from './context.ts';
import type { SessionState } from './types.ts';

const OUTCOME_RETRY_WINDOW_MS = 30_000;
const OUTCOME_RETRY_ATTEMPTS = 2;
const RECT_TOLERANCE_PX = 1;

export type InteractionSurfaceSignature = NonNullable<
  SessionState['pendingInteractionOutcome']
>['preSignature'];

export type InteractionSurfaceChange = 'changed' | 'unchanged' | 'ambiguous';

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
}): Promise<{ retried: boolean; change: InteractionSurfaceChange }> {
  const { session, pending, snapshot } = params;
  const change = classifyInteractionSurfaceChange(
    pending.preSignature,
    buildInteractionSurfaceSignature(snapshot.nodes),
  );
  if (change !== 'unchanged' || pending.attemptsRemaining <= 0) {
    return { retried: false, change };
  }

  const startedAt = Date.now();
  pending.attemptsRemaining -= 1;
  // Opt-in Maestro retries intentionally re-fire the same coordinate tap; delayed or
  // non-visual side effects can duplicate, but unchanged visual taps are the target gap.
  await dispatchCommand(session.device, pending.command, pending.positionals, pending.flags?.out, {
    ...contextFromFlags(params.logPath, pending.flags, session.appBundleId, session.trace?.outPath),
    surface: session.surface,
  });
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

export function areInteractionSurfaceSignaturesStable(
  left: InteractionSurfaceSignature,
  right: InteractionSurfaceSignature,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!a || !b || a.key !== b.key) return false;
    if (Math.abs(a.x - b.x) > RECT_TOLERANCE_PX) return false;
    if (Math.abs(a.y - b.y) > RECT_TOLERANCE_PX) return false;
    if (Math.abs(a.width - b.width) > RECT_TOLERANCE_PX) return false;
    if (Math.abs(a.height - b.height) > RECT_TOLERANCE_PX) return false;
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
 * that invariant (see `post-gesture-stabilization.ts`). Backends disagree about
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
    if (
      Math.abs(seen.entry.x - now.entry.x) > RECT_TOLERANCE_PX ||
      Math.abs(seen.entry.y - now.entry.y) > RECT_TOLERANCE_PX ||
      Math.abs(seen.entry.width - now.entry.width) > RECT_TOLERANCE_PX ||
      Math.abs(seen.entry.height - now.entry.height) > RECT_TOLERANCE_PX
    ) {
      return 'changed';
    }
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
): Map<string, { entry: InteractionSurfaceSignature[number] }> {
  const content = new Map<string, { entry: InteractionSurfaceSignature[number] }>();
  for (const entry of signature) {
    if (!entry.identity || !entry.discriminating) continue;
    if (!content.has(entry.identity)) content.set(entry.identity, { entry });
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
    if (
      Math.abs(entry.x - other.x) > RECT_TOLERANCE_PX ||
      Math.abs(entry.y - other.y) > RECT_TOLERANCE_PX ||
      Math.abs(entry.width - other.width) > RECT_TOLERANCE_PX ||
      Math.abs(entry.height - other.height) > RECT_TOLERANCE_PX
    ) {
      return false;
    }
  }
  return true;
}

function supportsInteractionOutcomePolicy(session: SessionState): boolean {
  return isMobilePlatform(session.device);
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
