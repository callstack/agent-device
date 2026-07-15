import { createHash } from 'node:crypto';
import type { SessionAction } from '../daemon/types.ts';
import { canonicalJson } from '../utils/canonical-json.ts';

/**
 * ADR 0012 decision 4 / migration step 5: `planDigest` is SHA-256 over the
 * canonical generic `.ad` plan — the same `actions` array the replay runtime
 * iterates, with one entry per executable script action. Maestro YAML uses its
 * typed replay-plan and digest implementation instead of this generic action
 * representation.
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
  const json = canonicalJson(canonical);
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
    targetEvidence: action.targetEvidence ?? null,
    source: { path: sourcePath, line },
  };
}
