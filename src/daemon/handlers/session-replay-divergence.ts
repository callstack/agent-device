import type { SessionAction } from '@agent-device/contracts/session';
import type { CommandFlags } from '@agent-device/contracts/command';
import { sleep } from '../../utils/timeouts.ts';
import { isUnreadableCaptureContentError } from '@agent-device/contracts/platform';
import { isSparseSnapshotQualityVerdict } from '../../snapshot-quality/verdict.ts';
import { displayLabel, formatRole } from '../../snapshot/snapshot-lines.ts';
import type { ResponseLevel } from '@agent-device/kernel/contracts';
import type { DaemonError } from '@agent-device/kernel/errors';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { captureSnapshot } from './snapshot-capture.ts';
import { collectReplaySelectorCandidates } from './session-replay-heal.ts';
import { buildSelectorCandidates, resolveReplaySuggestionCandidate } from '@agent-device/selectors';
import { collectSettleChromeRefs } from '../../core/snapshot-chrome.ts';
import { buildAndPersistReplayDivergenceResume } from './session-replay-resume.ts';
import { formatDivergenceActionLabel, isTouchTargetCommand } from '@agent-device/ad-script';
import {
  computeReplayRepairHint,
  type ReplayRepairHintCapture,
} from './session-replay-repair-hint.ts';
import type { SessionStore } from '../session-store.ts';
import type { ReplayResumeStamper } from '../session-replay-coordinator.ts';
import {
  bindInternalObservationAuthority,
  type InternalObservationEvidence,
} from '../internal-observation.ts';
import { boundReplayDivergenceForSession } from './session-replay-divergence-publication.ts';
import type { ReplayReportAction } from './session-replay-report-action.ts';
import { rankAndDedupeReplaySuggestions } from './session-replay-suggestion-ranking.ts';
import type { SessionState } from '../types.ts';
import {
  REPLAY_DIVERGENCE_SUGGESTION_LIMIT,
  createReplayDivergenceSanitizer,
  type ReplayDivergence,
  type ReplayDivergenceScreen,
  type ReplayDivergenceScreenRef,
  type ReplayDivergenceSuggestion,
  type ReplayDivergenceSuggestionBasis,
  type ReplayVarScrubEntry,
} from '@agent-device/contracts/divergence';

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
  action: ReplayReportAction;
  index: number;
  sourcePath: string;
  sourceLine: number;
  session: SessionState | undefined;
  sessionName: string;
  sessionStore: SessionStore;
  /** #1478 P4b: the request's bound resume-stamping capability — never a second-constructed coordinator. */
  resumeStamper: ReplayResumeStamper;
  logPath: string;
  responseLevel: ResponseLevel | undefined;
  /** Replay-scope values scrubbed from every divergence string (ADR 0012: expanded variables are never serialized). */
  scrubVars?: readonly ReplayVarScrubEntry[];
  /** ADR 0012 migration step 5: the full top-level plan, used to compute `resume.allowed`. */
  planActions: SessionAction[];
  /** SHA-256 digest of the canonical plan `planActions` came from (`computeReplayPlanDigest`). */
  planDigest: string;
  signal?: AbortSignal;
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
    resumeStamper,
    logPath,
    responseLevel,
    scrubVars = [],
    planActions,
    planDigest,
    signal,
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

  const resume = buildAndPersistReplayDivergenceResume({
    failedIndex: index + 1,
    actions: planActions,
    planDigest,
    repairHint,
    resumeStamper,
  });

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

  return boundReplayDivergenceForSession({
    sessionStore,
    sessionName,
    divergence,
    responseLevel,
    evidence: observation.state === 'available' ? observation.evidence : undefined,
    ...(signal ? { signal } : {}),
  });
}

export type DivergenceObservation =
  | {
      state: 'available';
      nodes: SnapshotNode[];
      refsGeneration: number;
      evidence: InternalObservationEvidence;
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
 * The single post-failure internal capture. It updates operational observation
 * state and returns opaque lineage evidence without touching client ref
 * authority. The daemon-owned response finalizer above activates a PARTIAL
 * frame only after response-level bounding and overflow projection are exact.
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
// #1385: a `capture-failed` / `sparse-snapshot` verdict on the PRE-DISPATCH
// target-verification capture (`verifyReplayActionTarget`) right after an
// `open --relaunch` step is often just the app still launching/mounting, not
// a real divergence — the SAME transition `wait`'s keep-polling landmark
// verification (#1349) rides out on its own (post-resolution) path.
//
// The `DIVERGENCE_CAPTURE_RETRY_DEADLINE_MS` budget is a DELAY-ONLY bound: it
// caps how long this loop SLEEPS between attempts (measured from the first
// attempt, so a slow first capture eats into the same budget rather than
// getting a free 12s on top), not how long any individual capture attempt
// itself may run — a capture already carries its own platform-level bounds
// (adb/xcodebuild command timeouts) this loop does not re-implement or
// shorten. The fixed-length `DIVERGENCE_CAPTURE_RETRY_DELAYS_MS` array is a
// SEPARATE, independent bound: it caps the attempt COUNT regardless of the
// deadline, so a mocked-instant `sleep` in tests cannot turn this into a
// busy-loop racing real time — it just runs the list once (mirrors the
// Android freshness retry shape in `snapshot-capture.ts`).
//
// Opt-in via `retryLaunchRace`, NOT the default for every caller: the
// post-failure diagnostic capture (`buildReplayFailureDivergence`) and the
// post-resolution guard-mismatch capture follow an ALREADY-REAL failure, not
// a launch race, and plenty of unit tests stub a throwing `snapshot` dispatch
// there expecting an immediate `capture-failed` result (repo convention: unit
// tests must not wait real time). Retrying unconditionally would force real
// wall-clock waits onto every one of those.
const DIVERGENCE_CAPTURE_RETRY_DEADLINE_MS = 12_000;
const DIVERGENCE_CAPTURE_RETRY_DELAYS_MS = [300, 500, 800, 1200, 2000, 3000, 4000] as const;

export async function captureDivergenceObservation(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  action: ReplayReportAction;
  retryLaunchRace?: boolean;
}): Promise<DivergenceObservation> {
  const { session, sessionName, sessionStore, logPath, action, retryLaunchRace = false } = params;
  const flags = divergenceCaptureFlags(action);
  // Anchored BEFORE the first attempt, not after: a slow first capture
  // shrinks the retry budget rather than getting a free `DEADLINE_MS` on top
  // of however long it took.
  const deadline = Date.now() + DIVERGENCE_CAPTURE_RETRY_DEADLINE_MS;

  let attempt = await captureDivergenceObservationAttempt({
    session,
    sessionName,
    sessionStore,
    logPath,
    flags,
  });
  if (!retryLaunchRace) return attempt.observation;

  for (const delayMs of DIVERGENCE_CAPTURE_RETRY_DELAYS_MS) {
    if (attempt.observation.state === 'available' || !attempt.retryable) break;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(delayMs, remainingMs));
    attempt = await captureDivergenceObservationAttempt({
      session,
      sessionName,
      sessionStore,
      logPath,
      flags,
    });
  }

  return attempt.observation;
}

type DivergenceCaptureAttempt = {
  observation: DivergenceObservation;
  /**
   * Meaningful only when `observation.state === 'unavailable'`: whether this
   * particular failure is a content-quality verdict a launch-race retry
   * should ride out, versus a mechanism failure that will not resolve itself
   * (helper artifact missing, device offline, adb connection dropped).
   * Mirrors #1381's `isUnreadableCaptureContentError` taxonomy for the wait
   * keep-poll loop — content verdict retries, mechanism failure fails fast.
   * The non-throwing `sparse-snapshot` verdict is always retryable — it is
   * already a content-quality signal, never a mechanism failure.
   */
  retryable: boolean;
};

async function captureDivergenceObservationAttempt(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  flags: CommandFlags;
}): Promise<DivergenceCaptureAttempt> {
  const { session, sessionName, sessionStore, logPath, flags } = params;
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
        observation: {
          state: 'unavailable',
          reason: 'sparse-snapshot',
          hint: 'The post-failure snapshot was sparse or unavailable; run snapshot -i to observe the current screen.',
        },
        retryable: true,
      };
    }
    const observationAuthority = bindInternalObservationAuthority({
      sessionStore,
      sessionName,
    });
    const stored = observationAuthority.store(snapshot);
    return {
      observation: {
        state: 'available',
        nodes: snapshot.nodes,
        refsGeneration: stored.refsGeneration,
        evidence: stored.evidence,
        appBundleId: session.appBundleId,
      },
      retryable: false,
    };
  } catch (error) {
    return {
      observation: {
        state: 'unavailable',
        reason: 'capture-failed',
        hint: `Post-failure snapshot capture failed (${error instanceof Error ? error.message : String(error)}); the original replay failure is unaffected.`,
      },
      retryable: isUnreadableCaptureContentError(error),
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
function divergenceCaptureFlags(action: ReplayReportAction): CommandFlags {
  return { snapshotInteractiveOnly: divergenceCaptureInteractiveOnly(action) };
}

/**
 * Interactive-only capture, except for non-rect selector reads
 * (`get`/`is`/`wait`) whose suggestion targets include static text — the
 * same `snapshotInteractiveOnly: requiresRect` rule heal always used.
 */
function divergenceCaptureInteractiveOnly(action: ReplayReportAction): boolean {
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
 * finalizer may authorize derive from THIS function, so the authorized
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
  const nonChrome = nodes.filter(
    (node) => node.ref && !chromeRefs.has(node.ref) && isMeaningfulDivergenceTarget(node),
  );
  // Keep replay repair actionable when an older Android/OEM hierarchy puts a
  // status/nav id on a container that also owns real controls. This activates
  // only when the chrome classifier would otherwise erase the entire screen.
  const meaningful =
    nonChrome.length > 0 ? nonChrome : nodes.filter((node) => node.ref && node.hittable === true);
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

/**
 * Decision 1's candidate machinery reused READ-ONLY over the shared capture.
 * Ranking: identity-component strength (id > role+label > label > other),
 * then document order; the same-scrollRegion tier awaits decision 3's
 * recorded evidence (migration step 4).
 */
function collectReplayDivergenceSuggestions(params: {
  action: ReplayReportAction;
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

export function resolveSuggestionMatchingConfig(
  action: ReplayReportAction,
): SuggestionMatchingConfig {
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
  basis: ReplayDivergenceSuggestionBasis;
  nodeIndex: number;
};

function rankSuggestionCandidates(params: {
  candidates: string[];
  nodes: SnapshotNode[];
  session: SessionState;
  action: ReplayReportAction;
  matching: SuggestionMatchingConfig;
  sanitize: DivergenceFieldSanitizer;
}): ReplayDivergenceSuggestion[] {
  const { candidates, nodes, session, action, matching, sanitize } = params;
  // Dedupe by node (its unique tree index), keeping the STRONGEST match basis
  // per the ADR: a node reachable through several recorded selector terms
  // appears once, tagged with its strongest basis — not whichever candidate
  // happened to resolve it first.
  const entries: RankedSuggestion[] = [];
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
    entries.push(entry);
  }
  return rankAndDedupeReplaySuggestions(entries).map((entry) => entry.suggestion);
}

function resolveSuggestionCandidate(params: {
  candidate: string;
  nodes: SnapshotNode[];
  session: SessionState;
  action: ReplayReportAction;
  matching: SuggestionMatchingConfig;
  sanitize: DivergenceFieldSanitizer;
}): RankedSuggestion | undefined {
  const { candidate, nodes, session, action, matching, sanitize } = params;
  const match = resolveReplaySuggestionCandidate(candidate, nodes, {
    platform: session.device.platform,
    requireRect: matching.requiresRect,
    allowDisambiguation: matching.allowDisambiguation,
  });
  if (!match) return undefined;
  return {
    suggestion: buildReplayDivergenceSuggestionForNode({
      node: match.node,
      nodes,
      session,
      action,
      basis: match.basis,
      sanitize,
    }),
    basis: match.basis,
    nodeIndex: match.node.index,
  };
}

export function buildReplayDivergenceSuggestionForNode(params: {
  node: SnapshotNode;
  /** The record-time tree the node came from, for #1269 non-unique-id demotion in the chain. */
  nodes: readonly SnapshotNode[];
  session: SessionState;
  action: ReplayReportAction;
  basis: ReplayDivergenceSuggestionBasis;
  sanitize: DivergenceFieldSanitizer;
}): ReplayDivergenceSuggestion {
  const { node, nodes, session, action, basis, sanitize } = params;
  const selectorChain = buildSelectorCandidates(node, session.device.platform, {
    action:
      action.command === 'fill' ? 'fill' : isTouchTargetCommand(action.command) ? 'click' : 'get',
    nodes,
  });
  const role = formatRole(node.type ?? 'Element');
  const label = displayLabel(node, role);
  return {
    selector: sanitize(selectorChain.join(' || ')),
    basis,
    ...(node.ref ? { ref: node.ref } : {}),
    role: sanitize(role),
    ...(label ? { label: sanitize(label) } : {}),
  };
}
