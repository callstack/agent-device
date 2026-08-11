// What each CI lane executes: one Lane per workflow job, carrying the gate ids it invokes
// and the path filter of its workflow.
//
// The file answers one question — "which registered checks will GitHub run for this job?" —
// and answers it by scanning for `pnpm gate <id>`. It does not try to understand arbitrary
// shell, and it makes no claim about shell it does not recognise: a lane that runs project
// code some other way simply earns no credit for it, which shows up as an unowned check
// rather than as a false pass.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { CheckId } from '../check-affected/model.ts';
import { GATE_ACTIONS, GATE_CONDITIONS } from './declarations.ts';
import { commandSegments } from './shell.ts';

/** A `pnpm gate <id>` a lane reaches, and every `if:` standing between the lane and it. */
export type GateSighting = {
  readonly id: CheckId;
  readonly conditions: readonly string[];
};

export type Lane = {
  readonly workflow: string;
  /** `Coverage` for the CI workflow, `iOS / Smoke Tests` elsewhere — the catalog's spelling. */
  readonly label: string;
  /** Lanes that gate the way in: `pull_request` or `schedule`. Release and dispatch do not. */
  readonly qualifying: boolean;
  /** Gates this lane earns OWNERSHIP credit for: reached, and reached unconditionally. */
  readonly gates: readonly CheckId[];
  /**
   * Every gate reached, credited or not. `gates` is this filtered by `creditsUnder`; the
   * difference is what audit.ts reports, so a gate hidden behind an undeclared condition is
   * a finding in its own right rather than only a downstream unowned check.
   */
  readonly gateSightings: readonly GateSighting[];
  /**
   * Scripts a lane runs by repeating the script's body verbatim instead of through
   * pnpm. Derived by comparing against package.json, never declared: ci.yml's Node
   * 22.12 lane cannot start pnpm at all, so it inlines `check:package`'s command.
   */
  readonly verbatim: readonly string[];
  readonly paths: readonly string[];
  readonly pathsIgnore: readonly string[];
  /** Execution surfaces that would hide steps from this loader. Always empty today. */
  readonly unsupported: readonly string[];
};

/** One shell block a lane reaches, with the `if:` that decides whether it runs. */
export type LaneStep = {
  readonly run: string;
  readonly condition: string | null;
};

const GATE_INVOCATION = /(?:^|[\s;&|(])pnpm\s+(?:--\S+\s+)*gate\s+([a-z0-9:-]+)/g;

type RawStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: unknown;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

function laneLabel(workflowName: string, jobName: string): string {
  return workflowName === 'CI' ? jobName : `${workflowName} / ${jobName}`;
}

function triggerPaths(on: Record<string, { paths?: string[]; 'paths-ignore'?: string[] }>) {
  const pr = on['pull_request'] ?? {};
  return { paths: pr.paths ?? [], pathsIgnore: pr['paths-ignore'] ?? [] };
}

type ActionDoc = { inputs?: Record<string, { default?: string }>; runs?: { steps?: RawStep[] } };

/** A local composite action, by the `uses:` path that names it. */
function readAction(
  uses: string | undefined,
  root: string,
): { doc: ActionDoc; source: string } | null {
  if (uses === undefined || !uses.startsWith('./')) return null;
  const source = `${uses.slice(2)}/action.yml`;
  const file = path.join(root, source);
  if (!fs.existsSync(file)) return null;
  return { doc: parse(fs.readFileSync(file, 'utf8')) as ActionDoc, source };
}

/**
 * Guards composite-action recursion. A cycle cannot run on GitHub either, so it is a
 * repository error rather than a case to model — but it must be LOUD: a depth cutoff would
 * return an empty step list, which reads downstream as "this action executes nothing".
 */
function enterAction(source: string, chain: readonly string[]): string[] {
  if (chain.includes(source)) {
    throw new Error(
      `composite action cycle: ${[...chain, source].join(' → ')}. The gate manifest cannot ` +
        `enumerate the steps of a cyclic action, and GitHub cannot run one.`,
    );
  }
  return [...chain, source];
}

/**
 * The one run step a gate-valued action performs, and the input its variable is bound to,
 * so audit.ts can prove the action honours its GATE_ACTIONS contract instead of trusting it.
 */
export type GateActionBody = {
  readonly run: string;
  readonly boundTo: string | null;
  /** The `if:` guarding the invocation, which decides whether callers earn credit for it. */
  readonly condition: string | null;
};

export function gateActionBody(doc: ActionDoc, input: string): GateActionBody | undefined {
  const variable = `INPUT_${input.toUpperCase().replace(/-/g, '_')}`;
  const wanted = `pnpm gate "$${variable}"`;
  // SOME step must be exactly the gate invocation with the variable bound to this input.
  // Other steps may read the same value for non-executing purposes — the cache-key hash
  // does — and the audit only needs one that honours the contract.
  for (const step of doc.runs?.steps ?? []) {
    if (typeof step.run !== 'string' || step.run.trim() !== wanted) continue;
    const bound = /^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/.exec(
      String(step.env?.[variable] ?? '').trim(),
    );
    return {
      run: step.run.trim(),
      boundTo: bound ? (bound[1] as string) : null,
      condition: step.if === undefined ? null : String(step.if),
    };
  }
  const runs = (doc.runs?.steps ?? []).filter((step) => typeof step.run === 'string');
  return {
    run: runs.map((step) => String(step.run).trim().split('\n')[0]).join(' | '),
    boundTo: null,
    condition: null,
  };
}

/**
 * Does a step guarded by this condition count as running?
 *
 * Absent is yes. Anything else must be declared — see `GATE_CONDITIONS`. Undeclared is no,
 * so a condition nobody has ruled on cannot quietly keep a gate's credit alive.
 */
export function creditsUnder(condition: string | null | undefined): boolean {
  if (condition === null || condition === undefined) return true;
  return GATE_CONDITIONS[condition]?.credits === true;
}

/**
 * The gate id a `uses:` step names, for an action declared to run exactly one gate, carrying
 * the `if:` on the action's own gate step. The caller's `if:` is added by the caller, which
 * applies it to everything the action reaches rather than to this sighting alone.
 */
function gateInput(step: RawStep, source: string, body?: GateActionBody): GateSighting | null {
  const input = GATE_ACTIONS[source];
  if (input === undefined) return null;
  const value = step.with?.[input];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return {
    id: value.trim() as CheckId,
    conditions: body?.condition === null || body?.condition === undefined ? [] : [body.condition],
  };
}

type Job = {
  name?: string;
  steps?: RawStep[];
  uses?: string;
};

type WorkflowDoc = {
  name?: string;
  // `on:` is YAML 1.1 truthy; the parser hands it back under `true`.
  on?: Record<string, never>;
  true?: Record<string, never>;
  jobs?: Record<string, Job>;
};

type Surface = {
  readonly steps: readonly LaneStep[];
  readonly gates: readonly GateSighting[];
};

const EMPTY: Surface = { steps: [], gates: [] };

/** What the action a step `uses:` contributes — nothing, for a step that uses none. */
function usedActionSurface(step: RawStep, root: string, chain: readonly string[]): Surface {
  const local = readAction(step.uses, root);
  if (!local) return EMPTY;
  const nested = jobSurface(local.doc.runs ?? {}, root, enterAction(local.source, chain));
  const declaredInput = GATE_ACTIONS[local.source];
  const gate = gateInput(
    step,
    local.source,
    declaredInput === undefined ? undefined : gateActionBody(local.doc, declaredInput),
  );
  // A conditional `uses:` guards everything the action reaches.
  const guard = step.if === undefined ? [] : [String(step.if)];
  return {
    steps: nested.steps.map((nestedStep) => ({
      ...nestedStep,
      // The caller's `if:` applies to every step the action reaches. Only one condition is
      // carried per step because `creditsUnder` is applied to each in turn by `laneGates`.
      condition: guard[0] ?? nestedStep.condition,
    })),
    gates: [...(gate ? [gate] : []), ...nested.gates].map((sighting) => ({
      ...sighting,
      conditions: [...guard, ...sighting.conditions],
    })),
  };
}

/** What one step contributes: its own shell, plus everything the action it uses reaches. */
function stepSurface(step: RawStep, root: string, chain: readonly string[]): Surface {
  const used = usedActionSurface(step, root, chain);
  const own: LaneStep[] =
    typeof step.run === 'string'
      ? [{ run: step.run, condition: step.if === undefined ? null : String(step.if) }]
      : [];
  return { steps: [...own, ...used.steps], gates: used.gates };
}

function jobSurface(job: Job, root: string, chain: readonly string[] = []): Surface {
  const parts = (job.steps ?? []).map((step) => stepSurface(step, root, chain));
  return {
    steps: parts.flatMap((part) => part.steps),
    gates: parts.flatMap((part) => part.gates),
  };
}

function laneInvocations(
  steps: readonly LaneStep[],
  scripts: Readonly<Record<string, string>>,
): { gates: GateSighting[]; verbatim: string[] } {
  const gates: GateSighting[] = [];
  const verbatim = new Set<string>();
  for (const { run, condition } of steps) {
    const conditions = condition === null ? [] : [condition];
    for (const match of run.matchAll(GATE_INVOCATION))
      gates.push({ id: match[1] as CheckId, conditions });
    // Verbatim credit is ownership too, and is filtered the same way: a lane that inlines
    // a script's body behind an undeclared `if:` has not shown that it runs it.
    if (creditsUnder(condition))
      for (const name of verbatimScripts(run, scripts)) verbatim.add(name);
  }
  return { gates, verbatim: [...verbatim] };
}

/**
 * Execution surfaces that would hide steps from this loader, reported rather than ignored.
 * A reusable-workflow job runs steps declared in a file this loader never opens, so its
 * gates would be invisible and its checks would read as unowned for the wrong reason.
 * Not used today, which is when a fail-closed rule is cheap to add.
 */
function unsupported(job: Job): string[] {
  return job.uses ? [`\`uses: ${job.uses}\` (reusable workflow)`] : [];
}

function workflowLanes(
  file: string,
  doc: WorkflowDoc,
  root: string,
  scripts: Readonly<Record<string, string>>,
): Lane[] {
  const on = (doc.on ?? doc.true ?? {}) as Record<
    string,
    { paths?: string[]; 'paths-ignore'?: string[] }
  >;
  const qualifying = 'pull_request' in on || 'schedule' in on;
  const { paths, pathsIgnore } = triggerPaths(on);
  return Object.entries(doc.jobs ?? {}).map(([jobId, job]) => {
    const surface = jobSurface(job, root);
    const scanned = laneInvocations(surface.steps, scripts);
    const sightings = [...scanned.gates, ...surface.gates];
    return {
      workflow: file,
      label: laneLabel(doc.name ?? file, job.name ?? jobId),
      qualifying,
      gates: [
        ...new Set(
          sightings
            .filter((sighting) => sighting.conditions.every(creditsUnder))
            .map((sighting) => sighting.id),
        ),
      ],
      gateSightings: sightings,
      verbatim: scanned.verbatim,
      paths,
      pathsIgnore,
      unsupported: unsupported(job),
    };
  });
}

/** `root` is where `./.github/actions/…` resolves from — separate so tests can load a
 *  planted workflow against the real actions. */
export function loadLanes(
  dir: string,
  root: string,
  scripts: Readonly<Record<string, string>> = {},
): Lane[] {
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith('.yml'))
    .sort()
    .flatMap((file) =>
      workflowLanes(
        file,
        parse(fs.readFileSync(path.join(dir, file), 'utf8')) as WorkflowDoc,
        root,
        scripts,
      ),
    );
}

/** GitHub's filter glob: `**` spans separators, `*` stops at one. */
export function matchesGlob(pattern: string, file: string): boolean {
  const source = pattern
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`).test(file);
}

/** Whether a change to `file` alone starts this lane's workflow. */
export function triggersOnPath(lane: Lane, file: string): boolean {
  if (lane.pathsIgnore.some((pattern) => matchesGlob(pattern, file))) return false;
  if (lane.paths.length > 0) return lane.paths.some((pattern) => matchesGlob(pattern, file));
  return true;
}

/** Scripts whose body this command repeats verbatim, whitespace-normalized. */
export function verbatimScripts(
  command: string,
  scripts: Readonly<Record<string, string>>,
): string[] {
  const wanted = commandSegments(command).map((segment) => segment.replace(/\s+/g, ' '));
  return Object.entries(scripts)
    .filter(([, body]) => wanted.includes(body.replace(/\s+/g, ' ')))
    .map(([name]) => name);
}
