import { dispatchCommand, type CommandFlags } from '../core/dispatch.ts';
import { isMobilePlatform } from '@agent-device/kernel/device';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { collectKeyboardChromeRefs } from '../core/snapshot-chrome.ts';
import { emitDiagnostic } from '../utils/diagnostics.ts';
import { normalizeType } from '../utils/text-surface.ts';
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
 * Subset-tolerant baseline classifier for post-gesture baseline distrust
 * (#1542 defect 2), reusing this module's existing three-valued vocabulary
 * (`InteractionSurfaceChange`) instead of a bespoke boolean. The pre-gesture
 * baseline and the post-gesture quiet capture routinely come from different
 * snapshot scopes (e.g. a broad text-search capture vs. an interactive-only
 * selector capture), so their signatures can differ in length/membership even
 * when the element that matters never moved — whole-array equality would
 * report "changed" purely from scope drift and never catch the real
 * staleness.
 *
 * The evidence rule: only shared entries flagged `discriminating` (i.e. NOT
 * the viewport root or keyboard-window chrome — see
 * `isNonDiscriminatingSurfaceNode`) count as evidence.
 *
 * - `'ambiguous'`: the shared overlap has zero discriminating entries — this
 *   includes an empty overlap AND an overlap that is only structurally fixed
 *   chrome (e.g. two signatures sharing nothing but the Application/Window
 *   root after a successful scroll swapped every real element — the exact
 *   live shape #1563's review caught: treating that as a match would extend
 *   every such interaction to the stale-read cap on zero real evidence).
 *   Ambiguous is NOT a match — insufficient evidence is its own first-class
 *   outcome, the same way `classifyInteractionSurfaceChange` already treats
 *   an empty side.
 * - `'changed'`: at least one discriminating shared entry moved beyond
 *   tolerance — real movement occurred.
 * - `'unchanged'`: every discriminating shared entry (and there is at least
 *   one) still matches — this is the actual "stale, matches baseline" signal
 *   the distrust check exists to catch.
 */
export function classifyBaselineSurfaceEvidence(
  baseline: InteractionSurfaceSignature,
  current: InteractionSurfaceSignature,
): InteractionSurfaceChange {
  if (baseline.length === 0 || current.length === 0) return 'ambiguous';
  const baselineByKey = new Map(baseline.map((entry) => [entry.key, entry]));
  let discriminatingOverlap = 0;
  for (const entry of current) {
    const baselineEntry = baselineByKey.get(entry.key);
    if (!baselineEntry) continue;
    // Shared but non-discriminating (viewport root / keyboard chrome): this
    // pair carries no evidence either way, so it neither counts toward the
    // overlap nor is checked for movement (its rect is invariant by
    // definition and comparing it would be pure noise).
    if (!entry.discriminating || !baselineEntry.discriminating) continue;
    discriminatingOverlap += 1;
    if (
      Math.abs(baselineEntry.x - entry.x) > RECT_TOLERANCE_PX ||
      Math.abs(baselineEntry.y - entry.y) > RECT_TOLERANCE_PX ||
      Math.abs(baselineEntry.width - entry.width) > RECT_TOLERANCE_PX ||
      Math.abs(baselineEntry.height - entry.height) > RECT_TOLERANCE_PX
    ) {
      return 'changed';
    }
  }
  return discriminatingOverlap > 0 ? 'unchanged' : 'ambiguous';
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
  return {
    key: `${semanticKey}|#${occurrence}`,
    x: Math.round(node.rect.x),
    y: Math.round(node.rect.y),
    width: Math.round(node.rect.width),
    height: Math.round(node.rect.height),
    discriminating: !isNonDiscriminatingSurfaceNode(node, keyboardChromeRefs),
  };
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
  return isViewportRootKind(node) || (node.ref !== undefined && keyboardChromeRefs.has(node.ref));
}

/**
 * Minimal local equivalent of `isViewportRoot` in
 * `src/snapshot/snapshot-occlusion.ts` (source of truth) — that function is
 * module-private and keyed off the broader `RawSnapshotNode` shape used by
 * occlusion/viewport resolution, so it is reimplemented here rather than
 * exported solely for this caller. Same normalized-kind substring test; keep
 * the two in lockstep if the underlying AX vocabulary changes.
 */
function isViewportRootKind(node: Pick<SnapshotNode, 'type' | 'role' | 'subrole'>): boolean {
  const normalizedKind = [node.type, node.role, node.subrole]
    .map((value) => normalizeType(value ?? ''))
    .join(' ');
  return normalizedKind.includes('application') || normalizedKind.includes('window');
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
