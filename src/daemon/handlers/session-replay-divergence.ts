import fs from 'node:fs';
import path from 'node:path';
import { dispatchCommand } from '../../core/dispatch.ts';
import { contextFromFlags } from '../context.ts';
import { markSessionSnapshotRefsIssued, setSessionSnapshot } from '../session-snapshot.ts';
import { isSparseSnapshotQualityVerdict } from '../../snapshot/snapshot-quality.ts';
import { displayLabel, formatRole } from '../../snapshot/snapshot-lines.ts';
import { redactDiagnosticData } from '../../kernel/redaction.ts';
import type { DaemonError, ResponseLevel } from '../../kernel/contracts.ts';
import type { RawSnapshotNode, SnapshotBackend, SnapshotNode } from '../../kernel/snapshot.ts';
import { buildSnapshotState } from './snapshot-capture.ts';
import {
  buildSelectorChainForNode,
  resolveSelectorChain,
  tryParseSelectorChain,
  type Selector,
} from '../../selectors/index.ts';
import { collectReplaySelectorCandidates } from './session-replay-heal.ts';
import { buildReplayDivergenceResume } from './session-replay-resume.ts';
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
    resume: buildReplayDivergenceResume({
      failedIndex: index + 1,
      actions: planActions,
      planDigest,
    }),
    // ADR 0012 decision 6, R3: `action-failure`'s capture is the POST-response
    // tree (this is the dispatch-thrown path) — the same one the container
    // test needs.
    repairHint: computeReplayRepairHint({
      kind: 'action-failure',
      targetEvidence: action.targetEvidence,
      capture: toReplayRepairHintCapture(observation),
    }),
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
  | { state: 'available'; nodes: SnapshotNode[]; refsGeneration: number }
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
 * The single post-failure capture, blessed via the standard ref-issuing
 * sequence (setSessionSnapshot -> markSessionSnapshotRefsIssued -> store).
 * Sparse captures do not write back (selector-capture reliability contract),
 * so a sparse verdict degrades the whole observation.
 */
export async function captureDivergenceObservation(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  action: SessionAction;
}): Promise<DivergenceObservation> {
  const { session, sessionName, sessionStore, logPath, action } = params;
  const snapshotInteractiveOnly = divergenceCaptureInteractiveOnly(action);
  try {
    const data = (await dispatchCommand(session.device, 'snapshot', [], undefined, {
      ...contextFromFlags(
        logPath,
        { ...(action.flags ?? {}), snapshotInteractiveOnly },
        session.appBundleId,
        session.trace?.outPath,
      ),
    })) as {
      nodes?: RawSnapshotNode[];
      truncated?: boolean;
      backend?: SnapshotBackend;
      quality?: unknown;
    };
    const snapshot = buildSnapshotState(data, {
      ...(action.flags ?? {}),
      snapshotInteractiveOnly,
    });
    if (isSparseSnapshotQualityVerdict(snapshot.snapshotQuality)) {
      return {
        state: 'unavailable',
        reason: 'sparse-snapshot',
        hint: 'The post-failure snapshot was sparse or unavailable; run snapshot -i to observe the current screen.',
      };
    }
    setSessionSnapshot(session, snapshot);
    markSessionSnapshotRefsIssued(session);
    sessionStore.set(sessionName, session);
    return {
      state: 'available',
      nodes: snapshot.nodes,
      refsGeneration: session.snapshotGeneration ?? 0,
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
  const { refs, truncated } = buildReplayDivergenceScreenRefs(observation.nodes, sanitize);
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

function buildReplayDivergenceScreenRefs(
  nodes: SnapshotNode[],
  sanitize: DivergenceFieldSanitizer,
): {
  refs: ReplayDivergenceScreenRef[];
  truncated: boolean;
} {
  const candidates = nodes.filter((node) => node.ref && node.interactionBlocked !== 'covered');
  const refs = candidates.slice(0, SCREEN_REF_CAPTURE_LIMIT).map((node) => {
    const role = formatRole(node.type ?? 'Element');
    const label = displayLabel(node, role);
    return {
      ref: node.ref!,
      role: sanitize(role),
      ...(label ? { label: sanitize(label) } : {}),
    };
  });
  return { refs, truncated: candidates.length > refs.length };
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
