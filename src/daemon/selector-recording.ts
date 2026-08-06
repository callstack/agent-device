import type { DaemonRequest } from './types.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import type { FindReadResult } from '@agent-device/contracts/interaction';
import { stripAndroidSystemChromeProvenanceFromNode } from '@agent-device/contracts/platform';
import { SessionStore } from './session-store.ts';
import { isInteractiveObservation } from './session-action-recorder.ts';
import {
  computeTargetEvidence,
  type RecordedTargetCapture,
  type TargetEvidenceMode,
} from './session-target-evidence.ts';

export function buildFindRecordResult(
  result: Record<string, unknown>,
  action: 'exists' | 'wait' | 'get_text' | 'get_attrs' | 'list',
): Record<string, unknown> {
  if (action === 'exists') return { found: true };
  if (action === 'wait') {
    return { found: true, waitedMs: result.waitedMs };
  }
  if (action === 'list') {
    return {
      action: 'list',
      matches: Array.isArray(result.matches) ? result.matches.length : 0,
    };
  }
  const ref = typeof result.ref === 'string' ? result.ref : undefined;
  if (action === 'get_attrs') return { ref, action: 'get attrs' };
  return {
    ref,
    action: 'get text',
    text: typeof result.text === 'string' ? result.text : '',
  };
}

// The daemon consumes the engine's find result verbatim; the shape lives in
// contracts (below both zones) per R2.
type DaemonFindResult = FindReadResult;

export function toDaemonFindData(result: DaemonFindResult): Record<string, unknown> {
  if (result.kind === 'found') {
    return {
      found: true,
      ...(typeof result.waitedMs === 'number' ? { waitedMs: result.waitedMs } : {}),
    };
  }
  if (result.kind === 'list') {
    return {
      matches: result.matches.map((match) => ({
        ref: match.ref,
        node: stripAndroidSystemChromeProvenanceFromNode(match.node),
      })),
    };
  }
  return {
    ref: result.ref,
    ...(result.kind === 'text' ? { text: result.text } : {}),
    node: stripAndroidSystemChromeProvenanceFromNode(result.node),
  };
}

export function buildGetRecordResult(
  result: Record<string, unknown>,
  property: 'text' | 'attrs',
): Record<string, unknown> {
  const selectorChain = Array.isArray(result.selectorChain) ? result.selectorChain : undefined;
  const resolvedTarget = getResolvedTarget(result);
  const ref = resolvedTarget?.kind === 'ref' ? normalizeDaemonRef(resolvedTarget.ref) : undefined;
  const selector = resolvedTarget?.kind === 'selector' ? resolvedTarget.selector : undefined;
  const recordedTarget = {
    ...(ref ? { ref } : {}),
    ...(selector ? { selector } : {}),
    ...(selectorChain ? { selectorChain } : {}),
  };
  if (property === 'attrs') return recordedTarget;

  const text = typeof result.text === 'string' ? result.text : '';
  return {
    ...recordedTarget,
    text,
    refLabel: compactRecordedGetRefLabel(text),
  };
}

type DaemonGetResult = {
  target: { kind: 'ref'; ref: string } | { kind: 'selector'; selector: string };
  text?: string;
  node: SnapshotNode;
};

export function toDaemonGetData(result: DaemonGetResult): Record<string, unknown> {
  const { target } = result;
  return {
    ...(target.kind === 'ref' ? { ref: normalizeDaemonRef(target.ref) } : {}),
    ...(target.kind === 'selector' ? { selector: target.selector } : {}),
    ...(typeof result.text === 'string' ? { text: result.text } : {}),
    node: stripAndroidSystemChromeProvenanceFromNode(result.node),
  };
}

/**
 * #1349: a recorded `wait`/`is` entry without the result's resolution
 * payload — `node`/`preActionNodes` feed `computeTargetEvidence` once and
 * must not be retained on `session.actions` for the session's lifetime.
 */
export function stripResolutionPayload<T extends Record<string, unknown>>(result: T): T {
  const { node: _node, preActionNodes: _preActionNodes, ...recordResult } = result;
  return recordResult as T;
}

export function toDaemonWaitData(result: Record<string, unknown>): Record<string, unknown> {
  return {
    waitedMs: result.waitedMs,
    ...(typeof result.text === 'string' ? { text: result.text } : {}),
    ...(typeof result.selector === 'string' ? { selector: result.selector } : {}),
    ...(typeof result.captures === 'number' ? { captures: result.captures } : {}),
    ...(typeof result.nodeCount === 'number' ? { nodeCount: result.nodeCount } : {}),
    ...(typeof result.hint === 'string' ? { hint: result.hint } : {}),
  };
}

export function stripSelectorChain<T extends Record<string, unknown>>(result: T): T {
  const { selectorChain: _selectorChain, ...publicResult } = result;
  return publicResult as T;
}

export function recordIfSession(
  sessionStore: SessionStore,
  sessionName: string,
  req: DaemonRequest,
  result: Record<string, unknown>,
  /** ADR 0012 decision 3: record-time input for the `target-v1` annotation. */
  recordedTarget?: RecordedTargetCapture,
  /** #1349: `landmark` for wait's existence-semantics evidence; defaults to `action`. */
  evidenceMode?: TargetEvidenceMode,
): void {
  const session = sessionStore.get(sessionName);
  if (!session) return;
  const targetEvidence =
    session.recordSession && recordedTarget
      ? computeTargetEvidence(recordedTarget, { mode: evidenceMode })
      : undefined;
  sessionStore.recordAction(session, {
    command: req.command,
    positionals: req.positionals ?? [],
    flags: req.flags ?? {},
    result,
    // #1271 stage 2: the shared recorder for `get`, `is`, `wait`, and read-only
    // `find`. `isInteractiveObservation` decides both halves — the command
    // class AND the provenance — so an authored plan step recorded through
    // this same path keeps its place in the healed script.
    interactiveObservation: isInteractiveObservation(req),
    ...(targetEvidence ? { targetEvidence } : {}),
  });
}

function compactRecordedGetRefLabel(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 80 || /[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function getResolvedTarget(
  result: Record<string, unknown>,
): { kind: 'ref'; ref: string } | { kind: 'selector'; selector: string } | undefined {
  const target = result.target;
  if (!target || typeof target !== 'object') return undefined;
  const record = target as Record<string, unknown>;
  if (record.kind === 'ref' && typeof record.ref === 'string') {
    return { kind: 'ref', ref: record.ref };
  }
  if (record.kind === 'selector' && typeof record.selector === 'string') {
    return { kind: 'selector', selector: record.selector };
  }
  return undefined;
}

function normalizeDaemonRef(ref: string): string {
  return ref.startsWith('@') ? ref.slice(1) : ref;
}
