import { createHash } from 'node:crypto';
import type { SessionAction } from '../daemon/types.ts';

/**
 * ADR 0012 decision 4 / migration step 5: `planDigest` is SHA-256 over the
 * canonical fully expanded plan — the SAME `actions` array the replay
 * runtime iterates, already flattened at parse time (static includes,
 * platform conditions, and fixed-count repeats expand before this point;
 * see `parseReplayInput`/`parseMaestroReplayFlow`). Runtime-only control flow
 * (`retry`, `maestroRunFlowWhen`) stays a single plan entry — its shape
 * (kind/mode/selector/maxRetries and nested action shapes) is folded into the
 * digest so an edit inside a control-flow block still changes the digest,
 * even though its nested actions are never individually addressable by
 * `--from`.
 *
 * Deliberately excluded: values resolved at invocation time. Variable
 * substitution happens in `resolveReplayAction`, after this digest is
 * computed over the still-unsubstituted `${VAR}` text, so `--env`/shell
 * values never change the digest. Every parsed value consumed before or
 * during action execution, including runtime hints and target evidence, is
 * part of the canonical plan.
 */
export type ReplayPlanDigestMetadata = {
  platform?: string;
  target?: string;
};

export function computeReplayPlanDigest(params: {
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths?: (string | undefined)[];
  metadata: ReplayPlanDigestMetadata;
}): string {
  const canonical = buildCanonicalPlan(params);
  const json = stableStringify(canonical);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

function buildCanonicalPlan(params: {
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths?: (string | undefined)[];
  metadata: ReplayPlanDigestMetadata;
}): unknown {
  const { actions, actionLines, actionSourcePaths, metadata } = params;
  return {
    platform: metadata.platform ?? null,
    target: metadata.target ?? null,
    steps: actions.map((action, index) =>
      canonicalizeAction(action, actionLines[index] ?? null, actionSourcePaths?.[index] ?? null),
    ),
  };
}

function canonicalizeAction(
  action: SessionAction,
  line: number | null,
  sourcePath: string | null,
): unknown {
  return {
    command: action.command,
    positionals: action.positionals ?? [],
    flags: action.flags ?? {},
    runtime: action.runtime ?? null,
    control: canonicalizeControl(action.replayControl),
    targetEvidence: action.targetEvidence ?? null,
    source: { path: sourcePath, line },
  };
}

function canonicalizeControl(control: SessionAction['replayControl']): unknown {
  if (!control) return null;
  const nested = control.actions.map((nestedAction, index) => {
    const source = control.actionSources?.[index];
    return canonicalizeAction(nestedAction, source?.line ?? null, source?.path ?? null);
  });
  if (control.kind === 'retry') {
    return { kind: control.kind, maxRetries: control.maxRetries, actions: nested };
  }
  return { kind: control.kind, mode: control.mode, selector: control.selector, actions: nested };
}

/**
 * Deterministic JSON serialization: object keys are sorted so the digest
 * never depends on incidental property insertion order (e.g. how an action's
 * `flags` bag was built up across parse/normalization steps).
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}
