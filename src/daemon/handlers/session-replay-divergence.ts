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
} from '../selectors.ts';
import { collectReplaySelectorCandidates } from './session-replay-heal.ts';
import { formatScriptActionSummary, isTouchTargetCommand } from '../../replay/script-utils.ts';
import { SessionStore } from '../session-store.ts';
import type { SessionAction, SessionState } from '../types.ts';
import {
  REPLAY_DIVERGENCE_RESUME_NOT_SUPPORTED,
  REPLAY_DIVERGENCE_SUGGESTION_LIMIT,
  boundReplayDivergence,
  sanitizeReplayDivergenceField,
  type ReplayDivergence,
  type ReplayDivergenceScreen,
  type ReplayDivergenceScreenRef,
  type ReplayDivergenceSuggestion,
  type ReplayDivergenceSuggestionBasis,
} from '../../replay/divergence.ts';

/**
 * ADR 0012 migration step 2: builds the `details.divergence` report for a
 * failed replay step. Report-only — no target-binding verification (decision
 * 3/step 4), no `--from` resume (step 5). `kind` is always `'action-failure'`
 * at this step.
 *
 * ONE post-failure snapshot serves both the screen digest and suggestion
 * re-resolution: the digest's `refsGeneration` and the suggestions' refs must
 * name the SAME stored tree, or the report would advertise refs a second
 * capture already invalidated (the exact stale-ref hole a per-purpose double
 * capture created in the first draft) — and one capture is also one fewer
 * device round trip on a latency-sensitive path.
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
  } = params;

  const cause = {
    code: error.code,
    message: sanitizeReplayDivergenceField(error.message),
    ...(error.hint ? { hint: sanitizeReplayDivergenceField(error.hint) } : {}),
  };

  const observation = session
    ? await captureDivergenceObservation({ session, sessionName, sessionStore, logPath, action })
    : ({
        state: 'unavailable',
        reason: 'no-session',
        hint: 'The session closed before a post-failure screen could be captured.',
      } satisfies DivergenceObservation);

  const screen = buildDivergenceScreen(observation);
  const suggestions =
    observation.state === 'available' && session
      ? collectReplayDivergenceSuggestions({ action, session, nodes: observation.nodes })
      : [];

  const divergence: ReplayDivergence = {
    version: 1,
    kind: 'action-failure',
    step: {
      index: index + 1,
      source: { path: sanitizeReplayDivergenceField(sourcePath), line: sourceLine },
    },
    action: sanitizeReplayDivergenceField(formatScriptActionSummary(action)),
    cause,
    screen,
    suggestions: suggestions.slice(0, REPLAY_DIVERGENCE_SUGGESTION_LIMIT),
    suggestionCount: suggestions.length,
    resume: REPLAY_DIVERGENCE_RESUME_NOT_SUPPORTED,
  };

  return boundReplayDivergence({
    divergence,
    level: responseLevel,
    writeOverflowArtifact: (payload) =>
      writeReplayDivergenceArtifact(sessionStore, sessionName, payload),
  });
}

type DivergenceObservation =
  | { state: 'available'; nodes: SnapshotNode[]; refsGeneration: number }
  | { state: 'unavailable'; reason: string; hint: string };

/**
 * The single post-failure capture. Blessing follows the settle/find/heal
 * choke-point sequence exactly: `setSessionSnapshot` (advances the session's
 * `snapshotGeneration`), `markSessionSnapshotRefsIssued` (clears the coarse
 * staleness marker — the report's refs are minted from the tree the next
 * `@ref` command resolves on), then `sessionStore.set`. Sparse captures do
 * not write back (the selector-capture reliability contract), so a sparse
 * verdict degrades the whole observation: no stored tree means no blessed
 * refs AND no trustworthy nodes for suggestion re-resolution.
 */
async function captureDivergenceObservation(params: {
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
 * Capture flavor for the shared observation: interactive-only (the settle /
 * `snapshot -i` default) except when the failing action is a non-rect
 * selector read (`get`/`is`/`wait`) — heal's suggestion re-resolution has
 * always used a full capture for those (`snapshotInteractiveOnly:
 * requiresRect`) because static text nodes are legitimate targets, and the
 * screen digest works over the full tree too (every node still carries a
 * blessed ref).
 */
function divergenceCaptureInteractiveOnly(action: SessionAction): boolean {
  if (!isSuggestionEligibleCommand(action.command)) return true;
  return resolveSuggestionMatchingConfig(action).requiresRect;
}

function buildDivergenceScreen(observation: DivergenceObservation): ReplayDivergenceScreen {
  if (observation.state === 'unavailable') return observation;
  const { refs, truncated } = buildReplayDivergenceScreenRefs(observation.nodes);
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

function buildReplayDivergenceScreenRefs(nodes: SnapshotNode[]): {
  refs: ReplayDivergenceScreenRef[];
  truncated: boolean;
} {
  const candidates = nodes.filter((node) => node.ref && node.interactionBlocked !== 'covered');
  const refs = candidates.slice(0, SCREEN_REF_CAPTURE_LIMIT).map((node) => {
    const role = formatRole(node.type ?? 'Element');
    const label = displayLabel(node, role);
    return {
      ref: node.ref!,
      role: sanitizeReplayDivergenceField(role),
      ...(label ? { label: sanitizeReplayDivergenceField(label) } : {}),
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
 * Decision 1's ranked-suggestions machinery, repurposed READ-ONLY:
 * `collectReplaySelectorCandidates` + `resolveSelectorChain` re-resolution
 * (the exact pieces `healReplayAction` already used) collect candidates
 * instead of applying the first one, resolved against the SAME captured
 * nodes the screen digest was built from (see the single-capture note on
 * `buildReplayFailureDivergence`). Ranking: identity-component strength
 * (id > role+label > label > other), then document order. The
 * same-scrollRegion-as-recorded tier from decision 1's total order is not
 * evaluated here — that requires decision 3's recorded target evidence,
 * which migration step 2 has no dependency on and does not consume.
 */
function collectReplayDivergenceSuggestions(params: {
  action: SessionAction;
  session: SessionState;
  nodes: SnapshotNode[];
}): ReplayDivergenceSuggestion[] {
  const { action, session, nodes } = params;
  if (!isSuggestionEligibleCommand(action.command)) return [];
  const candidates = collectReplaySelectorCandidates(action);
  if (candidates.length === 0) return [];
  const matching = resolveSuggestionMatchingConfig(action);
  return rankSuggestionCandidates({ candidates, nodes, session, action, matching });
}

function isSuggestionEligibleCommand(command: string): boolean {
  return isTouchTargetCommand(command) || ['fill', 'get', 'is', 'wait'].includes(command);
}

type SuggestionMatchingConfig = { requiresRect: boolean; allowDisambiguation: boolean };

function resolveSuggestionMatchingConfig(action: SessionAction): SuggestionMatchingConfig {
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
}): ReplayDivergenceSuggestion[] {
  const { candidates, nodes, session, action, matching } = params;
  const ranked: RankedSuggestion[] = [];
  const seenNodes = new Set<string>();
  for (const candidate of candidates) {
    const entry = resolveSuggestionCandidate({ candidate, nodes, session, action, matching });
    if (!entry) continue;
    const nodeKey = entry.suggestion.ref ?? `idx:${entry.nodeIndex}`;
    if (seenNodes.has(nodeKey)) continue;
    seenNodes.add(nodeKey);
    ranked.push(entry);
  }
  ranked.sort((a, b) => a.basisRank - b.basisRank || a.nodeIndex - b.nodeIndex);
  return ranked.map((entry) => entry.suggestion);
}

function resolveSuggestionCandidate(params: {
  candidate: string;
  nodes: SnapshotNode[];
  session: SessionState;
  action: SessionAction;
  matching: SuggestionMatchingConfig;
}): RankedSuggestion | undefined {
  const { candidate, nodes, session, action, matching } = params;
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
      selector: sanitizeReplayDivergenceField(selectorChain.join(' || ')),
      basis,
      ...(resolved.node.ref ? { ref: resolved.node.ref } : {}),
      role: sanitizeReplayDivergenceField(role),
      ...(label ? { label: sanitizeReplayDivergenceField(label) } : {}),
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
