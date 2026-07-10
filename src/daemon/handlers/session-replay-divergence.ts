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
import {
  collectReplaySelectorCandidates,
  captureSnapshotForReplay,
} from './session-replay-heal.ts';
import { formatScriptActionSummary, isTouchTargetCommand } from '../../replay/script-utils.ts';
import { SessionStore } from '../session-store.ts';
import type { SessionAction, SessionState } from '../types.ts';
import {
  REPLAY_DIVERGENCE_RESUME_NOT_SUPPORTED,
  REPLAY_DIVERGENCE_SUGGESTION_LIMIT,
  boundReplayDivergence,
  truncateUtf8Field,
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
    message: truncateUtf8Field(error.message),
    ...(error.hint ? { hint: truncateUtf8Field(error.hint) } : {}),
  };

  const screen = session
    ? await captureReplayDivergenceScreen({ session, sessionName, sessionStore, logPath, action })
    : ({
        state: 'unavailable',
        reason: 'no-session',
        hint: 'The session closed before a post-failure screen could be captured.',
      } satisfies ReplayDivergenceScreen);

  const suggestions = session
    ? await collectReplayDivergenceSuggestions({
        action,
        session,
        sessionName,
        sessionStore,
        logPath,
      })
    : [];

  const divergence: ReplayDivergence = {
    version: 1,
    kind: 'action-failure',
    step: {
      index: index + 1,
      source: { path: truncateUtf8Field(sourcePath), line: sourceLine },
    },
    action: truncateUtf8Field(formatScriptActionSummary(action)),
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

async function captureReplayDivergenceScreen(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  action: SessionAction;
}): Promise<ReplayDivergenceScreen> {
  const { session, sessionName, sessionStore, logPath, action } = params;
  try {
    const data = (await dispatchCommand(session.device, 'snapshot', [], undefined, {
      ...contextFromFlags(
        logPath,
        { ...(action.flags ?? {}), snapshotInteractiveOnly: true },
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
      snapshotInteractiveOnly: true,
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
    const { refs, truncated } = buildReplayDivergenceScreenRefs(snapshot.nodes);
    return {
      state: 'available',
      refsGeneration: session.snapshotGeneration ?? 0,
      refs,
      ...(truncated ? { truncated: true as const } : {}),
    };
  } catch (error) {
    return {
      state: 'unavailable',
      reason: 'capture-failed',
      hint: `Post-failure snapshot capture failed (${error instanceof Error ? error.message : String(error)}); the original replay failure is unaffected.`,
    };
  }
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
      role: truncateUtf8Field(role),
      ...(label ? { label: truncateUtf8Field(label) } : {}),
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
 * instead of applying the first one. Ranking: identity-component strength
 * (id > role+label > label > other), then document order. The
 * same-scrollRegion-as-recorded tier from decision 1's total order is not
 * evaluated here — that requires decision 3's recorded target evidence,
 * which migration step 2 has no dependency on and does not consume.
 */
async function collectReplayDivergenceSuggestions(params: {
  action: SessionAction;
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
}): Promise<ReplayDivergenceSuggestion[]> {
  const { action, session, sessionName, sessionStore, logPath } = params;
  if (!isSuggestionEligibleCommand(action.command)) return [];
  const candidates = collectReplaySelectorCandidates(action);
  if (candidates.length === 0) return [];

  const matching = resolveSuggestionMatchingConfig(action);
  const nodes = await captureSuggestionSnapshotNodes({
    session,
    sessionName,
    sessionStore,
    logPath,
    action,
    requiresRect: matching.requiresRect,
  });
  if (!nodes) return [];

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

/**
 * A fresh snapshot capture for suggestion re-resolution (a second capture
 * beyond the screen digest's own, matching healReplayAction's established
 * `snapshotInteractiveOnly: requiresRect` semantics exactly — see the module
 * doc comment on `collectReplayDivergenceSuggestions`). Returns `undefined`
 * on capture failure so the caller degrades to no suggestions, same as an
 * unavailable screen never masks the original cause.
 */
async function captureSuggestionSnapshotNodes(params: {
  session: SessionState;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  action: SessionAction;
  requiresRect: boolean;
}): Promise<SnapshotNode[] | undefined> {
  const { session, sessionName, sessionStore, logPath, action, requiresRect } = params;
  try {
    const snapshot = await captureSnapshotForReplay(
      session,
      action,
      logPath,
      requiresRect,
      sessionStore,
    );
    // captureSnapshotForReplay already stored + advanced the session snapshot
    // generation; re-read so suggestion refs are blessed against the tree
    // they came from, same as the screen digest.
    if (sessionStore.get(sessionName)?.snapshotGeneration !== undefined) {
      markSessionSnapshotRefsIssued(session);
    }
    return snapshot.nodes;
  } catch {
    return undefined;
  }
}

type RankedSuggestion = { suggestion: ReplayDivergenceSuggestion; basisRank: number; nodeIndex: number };

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
    action: action.command === 'fill' ? 'fill' : isTouchTargetCommand(action.command) ? 'click' : 'get',
  });
  const basis = classifySuggestionBasis(resolved.selector);
  const role = formatRole(resolved.node.type ?? 'Element');
  const label = displayLabel(resolved.node, role);
  return {
    suggestion: {
      selector: truncateUtf8Field(selectorChain.join(' || ')),
      basis,
      ...(resolved.node.ref ? { ref: resolved.node.ref } : {}),
      role: truncateUtf8Field(role),
      ...(label ? { label: truncateUtf8Field(label) } : {}),
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
