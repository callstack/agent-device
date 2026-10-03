import type { Rect, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { collectKeyboardChromeRefs } from '@agent-device/capture-kit/snapshot-chrome';
import { stateMarkers } from '@agent-device/capture-kit/snapshot-lines';
import { isViewportRootNode } from '@agent-device/contracts/snapshot';
import type { InteractionSurfaceEntry } from './session-state.ts';

const RECT_TOLERANCE_PX = 1;

export type InteractionSurfaceSignature = InteractionSurfaceEntry[];

export type InteractionSurfaceChange = 'changed' | 'unchanged' | 'ambiguous';

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

/**
 * What makes two captures comparable at all: the iOS comparison key when the capture carries one,
 * and the capturing backend otherwise. Two trees from different producers are not two views of one
 * screen — the XCTest-channel fallback swapping mid-request (#1569) is the case this exists for.
 */
export function snapshotSurfaceComparisonKey(
  snapshot: SnapshotState | undefined,
): string | undefined {
  return snapshot?.comparisonKey ?? snapshot?.snapshotQuality?.backend;
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

/**
 * Whether the DISCRIMINATING entries inside `rect` moved across a gesture: one left or entered the
 * region, or its rect moved beyond tolerance. Entries match on `content`: the flip-tolerant
 * `identity` where they have one, the type and role of an anonymous node otherwise, told apart by
 * document order when repeated. A scroll moves content, while a state flip inside the container (a
 * switch the swipe brushed, a row it selected) changes the key at the same rect and is not movement.
 *
 * A whole-surface difference is not automatically the gesture's doing. A captured tree carries system
 * chrome with it, and on Android the status bar clocks and icons change on their own while the app's
 * list sits frozen underneath. A difference that lives entirely outside the region a command acted on
 * therefore proves nothing in either direction: it cannot credit the gesture, and it cannot convict it.
 */
export function discriminatingSurfaceChangedWithinRect(
  before: InteractionSurfaceSignature,
  after: InteractionSurfaceSignature,
  rect: Rect,
): boolean {
  const beforeInRect = contentKeyed(discriminatingEntriesWithinRect(before, rect));
  const afterInRect = contentKeyed(discriminatingEntriesWithinRect(after, rect));
  for (const [content, entry] of beforeInRect) {
    const other = afterInRect.get(content);
    if (!other) return true;
    if (!rectsWithinTolerance(entry, other)) return true;
    afterInRect.delete(content);
  }
  return afterInRect.size > 0;
}

/** Entries by what they are rather than the state they are in; repeated content is told apart by document order. */
function contentKeyed(
  entries: InteractionSurfaceSignature,
): Map<string, InteractionSurfaceSignature[number]> {
  const occurrences = new Map<string, number>();
  const keyed = new Map<string, InteractionSurfaceSignature[number]>();
  for (const entry of entries) {
    const occurrence = occurrences.get(entry.content) ?? 0;
    occurrences.set(entry.content, occurrence + 1);
    keyed.set(`${entry.content}|#${occurrence}`, entry);
  }
  return keyed;
}

function discriminatingEntriesWithinRect(
  signature: InteractionSurfaceSignature,
  rect: Rect,
): InteractionSurfaceSignature {
  return signature.filter(
    (entry) =>
      entry.discriminating &&
      entry.x < rect.x + rect.width &&
      rect.x < entry.x + entry.width &&
      entry.y < rect.y + rect.height &&
      rect.y < entry.y + entry.height,
  );
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
    content: interactionSurfaceContent(node, identity),
    x: Math.round(node.rect.x),
    y: Math.round(node.rect.y),
    width: Math.round(node.rect.width),
    height: Math.round(node.rect.height),
    discriminating: !isNonDiscriminatingSurfaceNode(node, keyboardChromeRefs),
  };
}

/** What the element is without the state it is in: its identity, else the type and role of an anonymous node. */
function interactionSurfaceContent(node: SnapshotNode, identity: string | undefined): string {
  return identity ?? `${node.type ?? ''}|${node.role ?? ''}`;
}

/**
 * What the element IS — never where it sits, and never volatile state a gesture
 * is expected to change. `interactionSurfaceSemanticKey` deliberately folds in
 * the states `stateMarkers` prints, `hittable`, and an occurrence index, which is right for
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

/**
 * What the element is and the state it is in. The states are the ones `stateMarkers` prints, so the
 * outcome lane, the unchanged-snapshot comparison, and the diff weigh one list: a tap whose only
 * effect is a toggle is a change here.
 */
function interactionSurfaceSemanticKey(node: SnapshotNode): string | undefined {
  const semanticKey = [
    node.identifier,
    node.label,
    node.value,
    node.type,
    node.role,
    ...stateMarkers(node),
    node.hittable === true ? 'hittable' : 'not-hittable',
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .join('|');
  return semanticKey.replaceAll('|', '') ? semanticKey : undefined;
}

function isFiniteRect(rect: NonNullable<SnapshotNode['rect']>): boolean {
  const values = [rect.x, rect.y, rect.width, rect.height];
  return values.every((value) => Number.isFinite(value)) && rect.width > 0 && rect.height > 0;
}

function isScrollIndicator(node: SnapshotNode): boolean {
  const label = `${node.label ?? ''} ${node.identifier ?? ''}`.toLowerCase();
  return label.includes('scroll bar');
}
