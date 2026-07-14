import fs from 'node:fs';
import path from 'node:path';
import { markSessionPartialRefsIssued, setSessionSnapshot } from '../session-snapshot.ts';
import { isSparseSnapshotQualityVerdict } from '../../snapshot/snapshot-quality.ts';
import { displayLabel, formatRole } from '../../snapshot/snapshot-lines.ts';
import { redactDiagnosticData } from '../../kernel/redaction.ts';
import type { CommandFlags } from '../../core/dispatch.ts';
import type { DaemonError, ResponseLevel } from '../../kernel/contracts.ts';
import type { SnapshotNode } from '../../kernel/snapshot.ts';
import { captureSnapshot } from './snapshot-capture.ts';
import {
  buildSelectorChainForNode,
  resolveSelectorChain,
  tryParseSelectorChain,
  type Selector,
} from '../../selectors/index.ts';
import { collectReplaySelectorCandidates } from './session-replay-heal.ts';
import { collectSettleChromeRefs } from '../../core/snapshot-chrome.ts';
import {
  buildReplayDivergenceResume,
  stampPendingRecordAndHealWatermark,
} from './session-replay-resume.ts';
import { formatDivergenceActionLabel, isTouchTargetCommand } from '../../replay/script-utils.ts';
import {
  computeReplayRepairHint,
  type ReplayRepairHintCapture,
} from './session-replay-repair-hint.ts';
import { SessionStore } from '../session-store.ts';
import type { SessionAction, SessionState } from '../types.ts';
import {
  REPLAY_DIVERGENCE_SUGGESTION_LIMIT,
  boundReplayDivergence,
  createReplayDivergenceSanitizer,
  type ReplayDivergence,
  type ReplayDivergenceScreen,
  type ReplayDivergenceScreenRef,
  type ReplayDivergenceSuggestion,
  type ReplayDivergenceSuggestionBasis,
  type ReplayVarScrubEntry,
} from '../../replay/divergence.ts';

export type DivergenceFieldSanitizer = (value: string, limit?: number) => string;

/**
 * ADR 0012 migration step 2: builds the `details.divergence` report for a
 * failed replay step. Report-only; `kind` is always `'action-failure'`.
 * One capture serves both the screen digest and suggestion re-resolution:
 * every ref in the report must name the same stored tree as
 * `screen.refsGeneration`.
 */
export async function buildReplayFailureDivergence(params: {
  error: DaemonError;
  action: SessionAction;
  index: number;
  sourcePath: string;
  sourceLine: number;
  session: SessionState | undefined;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  responseLevel: ResponseLevel | undefined;
  /** Replay-scope values scrubbed from every divergence string (ADR 0012: expanded variables are never serialized). */
  scrubVars?: ReplayVarScrubEntry[];
  /** ADR 0012 migration step 5: the full top-level plan, used to compute `resume.allowed`. */
  planActions: SessionAction[];
  /** SHA-256 digest of the canonical plan `planActions` came from (`computeReplayPlanDigest`). */
  planDigest: string;
}): Promise<ReplayDivergence> {
  const {
    error,
    action,
    index,
    sourcePath,
    sourceLine,
    session,
    sessionName,
    sessionStore,
    logPath,
    responseLevel,
    scrubVars = [],
    planActions,
    planDigest,
  } = params;
  const sanitize = createReplayDivergenceSanitizer(scrubVars);

  const cause = {
    code: error.code,
    message: sanitize(error.message),
    ...(error.hint ? { hint: sanitize(error.hint) } : {}),
  };

  const observation = session
    ? await captureDivergenceObservation({ session, sessionName, sessionStore, logPath, action })
    : ({
        state: 'unavailable',
        reason: 'no-session',
        hint: 'The session closed before a post-failure screen could be captured.',
      } satisfies DivergenceObservation);

  const screen = buildDivergenceScreen(observation, sanitize);
  const suggestions =
    observation.state === 'available' && session
      ? collectReplayDivergenceSuggestions({
          action,
          session,
          nodes: observation.nodes,
          sanitize,
        })
      : [];

  // ADR 0012 decision 6, R3: `action-failure`'s capture is the POST-response
  // tree (this is the dispatch-thrown path) — the same one the container
  // test needs. Computed before `resume` so its `from` ordinal (decision 6,
  // R2: `record-and-heal` resumes at failedIndex + 1) agrees with the hint.
  const repairHint = computeReplayRepairHint({
    kind: 'action-failure',
    targetEvidence: action.targetEvidence,
    capture: toReplayRepairHintCapture(observation),
  });

  const resume = buildReplayDivergenceResume({
    failedIndex: index + 1,
    actions: planActions,
    planDigest,
    repairHint,
    // A live session is required to stamp the empty-tail watermark below, so it
    // gates whether the one-past-the-end `alternateFrom` may be advertised.
    sessionExists: session !== undefined,
  });
  if (session) {
    stampPendingRecordAndHealWatermark({
      session,
      resume,
      repairHint,
      failedIndex: index + 1,
      actions: planActions,
    });
    sessionStore.set(sessionName, session);
  }

  const divergence: ReplayDivergence = {
    version: 1,
    kind: 'action-failure',
    step: {
      index: index + 1,
      source: { path: sanitize(sourcePath), line: sourceLine },
    },
    action: sanitize(formatDivergenceActionLabel(action)),
    cause,
    screen,
    suggestions: suggestions.slice(0, REPLAY_DIVERGENCE_SUGGESTION_LIMIT),
    suggestionCount: suggestions.length,
    resume,
    repairHint,
  };

  return boundReplayDivergenceForSession({ sessionStore, sessionName, divergence, responseLevel });
}

/**
 * Shared response-level bounding + overflow-artifact wiring (`boundReplayDivergence`
 * bound to this session's artifact directory). Exported so step 4's
 * target-binding divergence goes through the exact same bounding/overflow
 * behavior as an action-failure divergence.
 */
export function boundReplayDivergenceForSession(params: {
  sessionStore: SessionStore;
  sessionName: string;
  divergence: ReplayDivergence;
  responseLevel: ResponseLevel | undefined;
}): ReplayDivergence {
  const { sessionStore, sessionName, divergence, responseLevel } = params;
  return boundReplayDivergence({
    divergence,
    level: responseLevel,
    writeOverflowArtifact: (payload) =>
      writeReplayDivergenceArtifact(sessionStore, sessionName, payload),
  });
}

export type DivergenceObservation =
  | {
      state: 'available';
      nodes: SnapshotNode[];
      refsGeneration: number;
      /** Session's app bundle id at capture time; threaded to `buildDivergenceScreen`'s chrome filter (Android IME-scope guard — inert on iOS). */
      appBundleId: string | undefined;
    }
  | { state: 'unavailable'; reason: string; hint: string };

/** Adapts a capture observation to the `repairHint` container-presence test's input shape. */
export function toReplayRepairHintCapture(
  observation: DivergenceObservation,
): ReplayRepairHintCapture {
  return observation.state === 'available'
    ? { state: 'available', nodes: observation.nodes }
    : { state: 'unavailable' };
}

/**
 * The single post-failure capture, blessed via the ADR-0014 partial ref-issuing
 * sequence (setSessionSnapshot -> markSessionPartialRefsIssued -> store): a
 * divergence screen publishes only its bounded ref set, so it activates a
 * PARTIAL frame authorizing exactly those bodies, not a complete namespace.
 * Sparse captures do not write back (selector-capture reliability contract),
 * so a sparse verdict degrades the whole observation.
 *
 * ADR 0012 decision 4 amendment (#1264): this routes through `captureSnapshot`
 * — the EXACT wrapper the `snapshot` command's backend calls
 * (`dispatchSnapshotViaRuntime` -> `createDaemonSnapshotBackend`), which owns
 * Android freshness + post-action retry (`capturePostActionAwareSnapshot`) on
 * top of the per-platform capture (Android snapshot-helper full-window route
 * with its graceful app-scoped fallback; iOS bounded system-modal probe path;
 * macOS/Linux surface-scoped branches). Calling the inner single-shot
 * `captureSnapshotData` instead would let a divergence consume a first stale /
 * app-scoped dump while a plain `snapshot` retries to the fresh full-window
 * tree — a divergence STALER or NARROWER than `snapshot`, which is exactly the
 * invariant this amendment forbids: an agent must never see a healthier
 * `screen` in a divergence report than a plain `snapshot` would show it.
 *
 * The capture flags are a CLEAN, fixed divergence-capture policy, NOT the
 * failed action's flags: `snapshotRaw`/`snapshotScope`/`snapshotDepth` from a
 * failed `snapshot --raw`/scoped/`-d` action would narrow or reshape the
 * diagnostic tree below what a plain `snapshot` shows, so they are dropped. The
 * only carried policy is interactive-only (`divergenceCaptureInteractiveOnly` —
 * full for non-rect `get`/`is`/`wait` reads so static-text targets survive,
 * interactive otherwise), matching heal's long-standing rule. The chrome filter
 * (`collectSettleChromeRefs`) and the meaningful-target filter stay layered ON
 * TOP of this full capture as FILTERS, never as a narrower scoping.
 */
export async function captureDivergenceObservation(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  action: SessionAction;
}): Promise<DivergenceObservation> {
  const { session, sessionName, sessionStore, logPath, action } = params;
  const flags = divergenceCaptureFlags(action);
  try {
    const capture = await captureSnapshot({
      device: session.device,
      session,
      flags,
      logPath,
    });
    const snapshot = capture.snapshot;
    if (isSparseSnapshotQualityVerdict(snapshot.snapshotQuality)) {
      return {
        state: 'unavailable',
        reason: 'sparse-snapshot',
        hint: 'The post-failure snapshot was sparse or unavailable; run snapshot -i to observe the current screen.',
      };
    }
    setSessionSnapshot(session, snapshot);
    // ADR 0014 (#1257) + #1264: the divergence screen publishes exactly the
    // ranked, occlusion-resolved, capped ref set `screen.refs` renders. Activate
    // a PARTIAL frame authorizing precisely THOSE bodies — derived from the same
    // `selectDivergenceScreenRefNodes` the digest uses, so the frame never
    // authorizes a ref the screen hides (over-pin risk) nor rejects one the
    // screen advertised (e.g. the mass-covered fallback surfaces covered refs
    // that the old non-covered-only filter would have excluded here).
    const digestBodies = selectDivergenceScreenRefNodes(
      snapshot.nodes,
      session.appBundleId,
    ).nodes.map((node) => node.ref as string);
    markSessionPartialRefsIssued(session, digestBodies);
    sessionStore.set(sessionName, session);
    return {
      state: 'available',
      nodes: snapshot.nodes,
      refsGeneration: session.snapshotGeneration ?? 0,
      appBundleId: session.appBundleId,
    };
  } catch (error) {
    return {
      state: 'unavailable',
      reason: 'capture-failed',
      hint: `Post-failure snapshot capture failed (${error instanceof Error ? error.message : String(error)}); the original replay failure is unaffected.`,
    };
  }
}

/**
 * The clean, fixed flags for a divergence capture (#1264): full-window
 * (no `snapshotScope`), non-raw (no `snapshotRaw`), default depth (no
 * `snapshotDepth`) — a failed scoped/raw/depth-limited action must never
 * produce a narrowed divergence `screen`. Only the interactive-only policy is
 * carried, since it governs whether static-text suggestion targets survive.
 */
function divergenceCaptureFlags(action: SessionAction): CommandFlags {
  return { snapshotInteractiveOnly: divergenceCaptureInteractiveOnly(action) };
}

/**
 * Interactive-only capture, except for non-rect selector reads
 * (`get`/`is`/`wait`) whose suggestion targets include static text — the
 * same `snapshotInteractiveOnly: requiresRect` rule heal always used.
 */
function divergenceCaptureInteractiveOnly(action: SessionAction): boolean {
  if (!isSuggestionEligibleCommand(action.command)) return true;
  return resolveSuggestionMatchingConfig(action).requiresRect;
}

export function buildDivergenceScreen(
  observation: DivergenceObservation,
  sanitize: DivergenceFieldSanitizer,
): ReplayDivergenceScreen {
  if (observation.state === 'unavailable') {
    // The capture-failed hint interpolates the capture error message; sanitize
    // every unavailable string field so no interpolated content escapes raw.
    return {
      state: 'unavailable',
      reason: sanitize(observation.reason),
      hint: sanitize(observation.hint),
    };
  }
  const { refs, truncated } = buildReplayDivergenceScreenRefs(
    observation.nodes,
    sanitize,
    observation.appBundleId,
  );
  return {
    state: 'available',
    refsGeneration: observation.refsGeneration,
    refs,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

// Full-resolution cap; response-level bounding (8/20) is applied afterwards
// by boundReplayDivergence/applyReplayDivergenceLevelCaps.
const SCREEN_REF_CAPTURE_LIMIT = 20;

/**
 * A divergence `screen.ref` is only useful if an agent could actually re-target
 * it: it must be identifiable (a display label / value / non-generic identifier)
 * or interactive (`hittable`). The `get`/`is`/`wait` divergence uses a full
 * (non-interactive) capture so static-text targets survive, but that also pulls
 * in unlabeled structural containers — ViewGroups / ComposeViews that carry a
 * ref yet no identity and aren't tappable. Those are never valid repair targets,
 * and on deeply-nested RN trees they would otherwise consume the
 * `SCREEN_REF_CAPTURE_LIMIT` budget ahead of the actionable controls (and the
 * app content the excluded status/nav chrome just freed room for).
 */
function isMeaningfulDivergenceTarget(node: SnapshotNode): boolean {
  return Boolean(displayLabel(node, formatRole(node.type ?? 'Element'))) || node.hittable === true;
}

/**
 * ADR 0012 decision 4 amendment (#1264): a hittable node owned by a window
 * OTHER than the app under test — a system-overlay window (volume dialog,
 * quick-settings shade, permission dialog) whose actionable nodes are the
 * dismiss targets for whatever is covering the app. Ownership is the node's own
 * `bundleId`/package: Android sets it per node from the accessibility `package`,
 * so a systemui/permission-controller/`android` node reads as foreign; iOS and
 * macOS leave per-node `bundleId` undefined, so this is inert there (those
 * platforms surface separate-window modals through the dedicated probe path,
 * not by cap-competing with app content). Guarded on a known `appBundleId` so a
 * sessionless capture never reorders — without an app identity there is no
 * "foreign" to promote.
 */
function isForeignOverlayDismissTarget(
  node: SnapshotNode,
  appBundleId: string | undefined,
): boolean {
  return (
    appBundleId !== undefined &&
    node.bundleId !== undefined &&
    node.bundleId !== appBundleId &&
    node.hittable === true
  );
}

/**
 * The single source of truth for which nodes a divergence `screen.refs`
 * publishes, and in what order. Both the rendered `screen.refs` digest
 * (`buildReplayDivergenceScreenRefs`) AND the ADR-0014 partial ref frame the
 * capture authorizes (`captureDivergenceObservation` →
 * `markSessionPartialRefsIssued`) derive from THIS function, so the authorized
 * ref set is exactly the set the agent is shown — never a superset it can pin
 * refs outside of, nor a subset that rejects a ref the screen advertised.
 * Returns the capped node list plus whether ranking overflowed the cap.
 */
function selectDivergenceScreenRefNodes(
  nodes: SnapshotNode[],
  appBundleId: string | undefined,
): { nodes: SnapshotNode[]; truncated: boolean } {
  // Keyboard/IME chrome must not consume the ref budget: it reuses the exact
  // structural classifier `--settle`'s tail already relies on (#1198/#1200)
  // rather than a second keyboard/IME node-type list.
  const chromeRefs = collectSettleChromeRefs(nodes, appBundleId);
  const meaningful = nodes.filter(
    (node) => node.ref && !chromeRefs.has(node.ref) && isMeaningfulDivergenceTarget(node),
  );
  // Occlusion fallback (#1264): a `covered` node is normally dropped — an agent
  // cannot tap what an overlay hides. But when a system overlay MASS-COVERS the
  // app, EVERY app node is annotated `covered`; dropping them all would emit an
  // empty `screen.refs` while the capture plainly holds meaningful nodes — a
  // report broken by construction (the agent is shown nothing to act on). So
  // `covered` nodes are excluded only while non-covered candidates remain; if
  // the entire meaningful surface is covered, they are surfaced rather than
  // returning empty.
  const visible = meaningful.filter((node) => node.interactionBlocked !== 'covered');
  const pool = visible.length > 0 ? visible : meaningful;
  // Rank within the cap instead of slicing document order (#1264 cap burial):
  // `SCREEN_REF_CAPTURE_LIMIT` is a BYTE bound, NOT a "first 20 in tree order"
  // policy. A separate-window overlay enumerates AFTER the app window's nodes,
  // so on a realistic tree its dismiss target sits past position 20 and is
  // truncated away even though it was captured. Foreign-bundle hittable overlay
  // nodes (the dismiss targets) are promoted ahead of app content; ordering is
  // otherwise STABLE — document order is preserved within each tier, so
  // equal-priority app nodes are never reshuffled. `repairHint`/`suggestions`
  // consume the FULL captured node list, not this slice, so hint routing is
  // unaffected; only the agent-visible `screen.refs` selection changes.
  const ranked = [
    ...pool.filter((node) => isForeignOverlayDismissTarget(node, appBundleId)),
    ...pool.filter((node) => !isForeignOverlayDismissTarget(node, appBundleId)),
  ];
  const selected = ranked.slice(0, SCREEN_REF_CAPTURE_LIMIT);
  return { nodes: selected, truncated: ranked.length > selected.length };
}

function buildReplayDivergenceScreenRefs(
  nodes: SnapshotNode[],
  sanitize: DivergenceFieldSanitizer,
  appBundleId: string | undefined,
): {
  refs: ReplayDivergenceScreenRef[];
  truncated: boolean;
} {
  const { nodes: selected, truncated } = selectDivergenceScreenRefNodes(nodes, appBundleId);
  const refs = selected.map((node) => {
    const role = formatRole(node.type ?? 'Element');
    const label = displayLabel(node, role);
    return {
      ref: node.ref!,
      role: sanitize(role),
      ...(label ? { label: sanitize(label) } : {}),
    };
  });
  return { refs, truncated };
}

const BASIS_RANK: Record<ReplayDivergenceSuggestionBasis, number> = {
  id: 0,
  'role-label': 1,
  label: 2,
  other: 3,
};

function classifySuggestionBasis(selector: Selector): ReplayDivergenceSuggestionBasis {
  const keys = new Set(selector.terms.map((term) => term.key));
  if (keys.has('id')) return 'id';
  const hasRole = keys.has('role');
  const hasLabelLike = keys.has('label') || keys.has('text');
  if (hasRole && hasLabelLike) return 'role-label';
  if (hasLabelLike || keys.has('value')) return 'label';
  return 'other';
}

/**
 * Decision 1's candidate machinery reused READ-ONLY over the shared capture.
 * Ranking: identity-component strength (id > role+label > label > other),
 * then document order; the same-scrollRegion tier awaits decision 3's
 * recorded evidence (migration step 4).
 */
function collectReplayDivergenceSuggestions(params: {
  action: SessionAction;
  session: SessionState;
  nodes: SnapshotNode[];
  sanitize: DivergenceFieldSanitizer;
}): ReplayDivergenceSuggestion[] {
  const { action, session, nodes, sanitize } = params;
  if (!isSuggestionEligibleCommand(action.command)) return [];
  const candidates = collectReplaySelectorCandidates(action);
  if (candidates.length === 0) return [];
  const matching = resolveSuggestionMatchingConfig(action);
  return rankSuggestionCandidates({ candidates, nodes, session, action, matching, sanitize });
}

function isSuggestionEligibleCommand(command: string): boolean {
  return isTouchTargetCommand(command) || ['fill', 'get', 'is', 'wait'].includes(command);
}

export type SuggestionMatchingConfig = { requiresRect: boolean; allowDisambiguation: boolean };

export function resolveSuggestionMatchingConfig(action: SessionAction): SuggestionMatchingConfig {
  const isTouch = isTouchTargetCommand(action.command);
  return {
    requiresRect: isTouch || action.command === 'fill',
    allowDisambiguation:
      isTouch ||
      action.command === 'fill' ||
      (action.command === 'get' && action.positionals?.[0] === 'text'),
  };
}

type RankedSuggestion = {
  suggestion: ReplayDivergenceSuggestion;
  basisRank: number;
  nodeIndex: number;
};

function rankSuggestionCandidates(params: {
  candidates: string[];
  nodes: SnapshotNode[];
  session: SessionState;
  action: SessionAction;
  matching: SuggestionMatchingConfig;
  sanitize: DivergenceFieldSanitizer;
}): ReplayDivergenceSuggestion[] {
  const { candidates, nodes, session, action, matching, sanitize } = params;
  // Dedupe by node (its unique tree index), keeping the STRONGEST match basis
  // per the ADR: a node reachable through several recorded selector terms
  // appears once, tagged with its strongest basis — not whichever candidate
  // happened to resolve it first.
  const byNode = new Map<number, RankedSuggestion>();
  for (const candidate of candidates) {
    const entry = resolveSuggestionCandidate({
      candidate,
      nodes,
      session,
      action,
      matching,
      sanitize,
    });
    if (!entry) continue;
    const existing = byNode.get(entry.nodeIndex);
    if (!existing || entry.basisRank < existing.basisRank) byNode.set(entry.nodeIndex, entry);
  }
  return [...byNode.values()]
    .sort((a, b) => a.basisRank - b.basisRank || a.nodeIndex - b.nodeIndex)
    .map((entry) => entry.suggestion);
}

function resolveSuggestionCandidate(params: {
  candidate: string;
  nodes: SnapshotNode[];
  session: SessionState;
  action: SessionAction;
  matching: SuggestionMatchingConfig;
  sanitize: DivergenceFieldSanitizer;
}): RankedSuggestion | undefined {
  const { candidate, nodes, session, action, matching, sanitize } = params;
  const chain = tryParseSelectorChain(candidate);
  if (!chain) return undefined;
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: session.device.platform,
    requireRect: matching.requiresRect,
    requireUnique: true,
    disambiguateAmbiguous: matching.allowDisambiguation,
  });
  if (!resolved) return undefined;

  const selectorChain = buildSelectorChainForNode(resolved.node, session.device.platform, {
    action:
      action.command === 'fill' ? 'fill' : isTouchTargetCommand(action.command) ? 'click' : 'get',
  });
  const basis = classifySuggestionBasis(resolved.selector);
  const role = formatRole(resolved.node.type ?? 'Element');
  const label = displayLabel(resolved.node, role);
  return {
    suggestion: {
      selector: sanitize(selectorChain.join(' || ')),
      basis,
      ...(resolved.node.ref ? { ref: resolved.node.ref } : {}),
      role: sanitize(role),
      ...(label ? { label: sanitize(label) } : {}),
    },
    basisRank: BASIS_RANK[basis],
    nodeIndex: resolved.node.index,
  };
}

function writeReplayDivergenceArtifact(
  sessionStore: SessionStore,
  sessionName: string,
  payload: ReplayDivergence,
): { artifactPath: string } | { artifactUnavailable: true } {
  try {
    const dir = path.join(sessionStore.ensureSessionDir(sessionName), 'replay-divergence');
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${Date.now()}-step${payload.step.index}.json`;
    const artifactPath = path.join(dir, fileName);
    fs.writeFileSync(artifactPath, `${JSON.stringify(redactDiagnosticData(payload), null, 2)}\n`);
    return { artifactPath };
  } catch {
    return { artifactUnavailable: true };
  }
}
