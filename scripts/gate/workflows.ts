// What each CI lane executes: one Lane per workflow job, carrying every shell block the
// job reaches and the gate ids it invokes.
//
// The file answers one question — "what will GitHub run for this job?" — and answers it by
// CONSTRUCTION. The construction was narrowed in review round 7: rather than modelling every
// way a caller can hand a command to an action and then policing it, the seams that used to
// accept commands now accept gate ids, and an action may not interpolate an input into a
// shell body at all. What is left to model is `run:` blocks.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { CheckId } from '../check-affected/model.ts';
import { EXTERNAL_ACTIONS, GATE_ACTIONS, type ExternalAction } from './declarations.ts';
import { commandSegments } from './shell.ts';

export type Lane = {
  readonly workflow: string;
  /** `Coverage` for the CI workflow, `iOS / Smoke Tests` elsewhere — the catalog's spelling. */
  readonly label: string;
  /** Lanes that gate the way in: `pull_request` or `schedule`. Release and dispatch do not. */
  readonly qualifying: boolean;
  readonly gates: readonly CheckId[];
  /**
   * Scripts a lane runs by repeating the script's body verbatim instead of through
   * pnpm. Derived by comparing against package.json, never declared: ci.yml's Node
   * 22.12 lane cannot start pnpm at all, so it inlines `check:package`'s command.
   */
  readonly verbatim: readonly string[];
  readonly steps: readonly LaneStep[];
  readonly paths: readonly string[];
  readonly pathsIgnore: readonly string[];
  /** Every environment variable name the lane's steps see, from any level. */
  readonly envKeys: readonly string[];
  /** `owner/repo@ref` for every third-party action the lane reaches, deduplicated. */
  readonly externals: readonly string[];
  /** Execution surfaces this file uses that the model does not read. Always empty today. */
  readonly unsupported: readonly string[];
};

/** One shell block a lane executes — the unit the no-bypass rule is asserted over. */
export type LaneStep = {
  readonly name: string;
  /** The file declaring the step: a workflow, or the composite action it came from. */
  readonly source: string;
  readonly run: string;
  /**
   * Everything besides `run` that changes what the step executes: `shell` and
   * `working-directory` change the interpreter and the resolution root. Environment is no
   * longer folded in — it is checked by name instead (see `envKeys`), because digesting
   * ordinary device configuration taxed 11 lanes to catch a class of variable that can be
   * named outright.
   */
  readonly extras: Readonly<Record<string, string>>;
  /** Fingerprint over `run` plus every extra. The inventory binds THIS, never the name. */
  readonly digest: string;
};

/** Exported so tests re-seal a mutated step with the real function, never a copy. */
export function stepDigest(run: string, extras: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify({ run: run.replace(/\s+/g, ' ').trim(), extras });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

const GATE_INVOCATION = /(?:^|[\s;&|(])pnpm\s+(?:--\S+\s+)*gate\s+([a-z0-9:-]+)/g;

type RawStep = {
  name?: string;
  run?: string;
  uses?: string;
  shell?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
  'working-directory'?: string;
};

function stepExtras(step: RawStep): Record<string, string> {
  const extras: Record<string, string> = {};
  if (step.shell) extras['shell'] = step.shell;
  if (step['working-directory']) extras['working-directory'] = step['working-directory'];
  return extras;
}

function sealed(
  name: string,
  source: string,
  run: string,
  extras: Record<string, string>,
): LaneStep {
  return { name, source, run, extras, digest: stepDigest(run, extras) };
}

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

/** `owner/repo@ref` for a third-party action — everything `readAction` cannot open. */
function externalRef(uses: string | undefined): string | null {
  if (uses === undefined || uses.startsWith('./')) return null;
  return uses.trim();
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

const INPUT_IN_SHELL = /\$\{\{\s*inputs\.([\w-]+)/g;

/**
 * Inputs a local action interpolates into a `run:` block.
 *
 * Must be empty, always. An input reaching a shell by interpolation is a seam a caller can
 * write commands through, and rounds 5–6 were both that seam found one level further out.
 * Passing inputs as `env:` and referencing `"$INPUT_X"` closes it by construction: the run
 * block becomes a constant, and no `with:` value can change what executes.
 */
function interpolatedInputs(doc: ActionDoc): { step: string; input: string }[] {
  return (doc.runs?.steps ?? []).flatMap((step) =>
    typeof step.run === 'string'
      ? [...new Set([...step.run.matchAll(INPUT_IN_SHELL)].map((m) => m[1] as string))].map(
          (input) => ({ step: step.name ?? '<unnamed>', input }),
        )
      : [],
  );
}

/**
 * The gate id a `uses:` step names, for an action declared to run exactly one gate.
 *
 * `setup-apple-runner-build` used to take `build-command: pnpm gate swift-runner-ios` — a
 * command, which is why its value had to be digested at every call site. It now takes
 * `gate: swift-runner-ios`, and the action runs `pnpm gate "$INPUT_GATE"`. The id is data
 * the audit validates against the registry, so seven call-site digests become nothing.
 */
export type GateActionBody = { readonly run: string; readonly boundTo: string | null };

/**
 * The one run step a gate-valued action performs, and the input its variable is bound to,
 * so audit.ts can prove the action honours its GATE_ACTIONS contract instead of trusting it.
 */
export function gateActionBody(doc: ActionDoc, input: string): GateActionBody | undefined {
  const variable = `INPUT_${input.toUpperCase().replace(/-/g, '_')}`;
  const wanted = `pnpm gate "$${variable}"`;
  // SOME step must be exactly the gate invocation with the variable bound to this input.
  // Other steps may read the same value for non-executing purposes — the cache-key hash
  // does — and those are ordinary baseline entries whose digests move if they change.
  for (const step of doc.runs?.steps ?? []) {
    if (typeof step.run !== 'string' || step.run.trim() !== wanted) continue;
    const bound = /^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/.exec(
      String(step.env?.[variable] ?? '').trim(),
    );
    return { run: step.run.trim(), boundTo: bound ? (bound[1] as string) : null };
  }
  const runs = (doc.runs?.steps ?? []).filter((step) => typeof step.run === 'string');
  return {
    run: runs.map((step) => String(step.run).trim().split('\n')[0]).join(' | '),
    boundTo: null,
  };
}

function gateInput(step: RawStep, source: string): CheckId | null {
  const input = GATE_ACTIONS[source];
  if (input === undefined) return null;
  const value = step.with?.[input];
  return typeof value === 'string' && value.trim() !== '' ? (value.trim() as CheckId) : null;
}

/**
 * Shell a third-party action runs on the caller's behalf. Its source is not in this tree,
 * so which inputs it executes is declared per pinned sha (`EXTERNAL_ACTIONS`).
 */
function externalInputSteps(
  step: RawStep,
  ref: string,
  source: string,
  jobId: string,
  externals: readonly ExternalAction[],
): LaneStep[] {
  const entry = externals.find((candidate) => candidate.uses === ref);
  if (!entry) return [];
  const supplied = [...entry.executes]
    .sort()
    .map((name) => [name, String(step.with?.[name] ?? '')] as const)
    .filter(([, value]) => value.trim() !== '');
  if (supplied.length === 0) return [];
  const names = supplied.map(([name]) => name).join(', ');
  return [
    sealed(
      `${step.name ?? jobId} → ${ref} (${names})`,
      source,
      supplied.map(([, v]) => v).join('\n'),
      {},
    ),
  ];
}

type Job = {
  name?: string;
  env?: Record<string, unknown>;
  steps?: RawStep[];
  defaults?: unknown;
  uses?: string;
};

type WorkflowDoc = {
  name?: string;
  env?: Record<string, unknown>;
  defaults?: unknown;
  // `on:` is YAML 1.1 truthy; the parser hands it back under `true`.
  on?: Record<string, never>;
  true?: Record<string, never>;
  jobs?: Record<string, Job>;
};

type Surface = {
  readonly steps: readonly LaneStep[];
  readonly externals: readonly string[];
  readonly gates: readonly CheckId[];
  readonly envKeys: readonly string[];
  readonly leaks: readonly string[];
};

const EMPTY: Surface = { steps: [], externals: [], gates: [], envKeys: [], leaks: [] };

/**
 * Every shell block a job reaches: its own `run:` steps, the `run:` steps of every local
 * composite action it uses, and any shell it hands to a third-party action.
 *
 * Nothing is filtered out. An earlier version dropped steps carrying `working-directory`,
 * which made a bypass placed in one invisible.
 */
/** What the action a step `uses:` contributes — nothing, for a step that uses none. */
function usedActionSurface(
  step: RawStep,
  jobId: string,
  root: string,
  source: string,
  externals: readonly ExternalAction[],
  chain: readonly string[],
): Surface {
  const local = readAction(step.uses, root);
  if (local) {
    const nested = jobSurface(
      local.doc.runs ?? {},
      jobId,
      root,
      local.source,
      externals,
      enterAction(local.source, chain),
    );
    const gate = gateInput(step, local.source);
    const leaks = interpolatedInputs(local.doc).map(
      (leak) => `${local.source} / ${leak.step}: \`inputs.${leak.input}\``,
    );
    return {
      ...nested,
      gates: [...(gate ? [gate] : []), ...nested.gates],
      leaks: [...leaks, ...nested.leaks],
    };
  }
  const ref = externalRef(step.uses);
  if (ref === null) return EMPTY;
  return {
    ...EMPTY,
    steps: externalInputSteps(step, ref, source, jobId, externals),
    externals: [ref],
  };
}

/** What one step contributes: its own shell, plus everything the action it uses reaches. */
function stepSurface(
  step: RawStep,
  jobId: string,
  root: string,
  source: string,
  externals: readonly ExternalAction[],
  chain: readonly string[],
): Surface {
  const used = usedActionSurface(step, jobId, root, source, externals, chain);
  const own =
    typeof step.run === 'string'
      ? [sealed(step.name ?? jobId, source, step.run, stepExtras(step))]
      : [];
  return {
    ...used,
    steps: [...own, ...used.steps],
    envKeys: [...Object.keys(step.env ?? {}), ...used.envKeys],
  };
}

function jobSurface(
  job: Job,
  jobId: string,
  root: string,
  source: string,
  externals: readonly ExternalAction[],
  chain: readonly string[] = [],
): Surface {
  const parts = (job.steps ?? []).map((step) =>
    stepSurface(step, jobId, root, source, externals, chain),
  );
  const merge = <K extends keyof Surface>(key: K) => [
    ...new Set(parts.flatMap((part) => part[key] as readonly string[])),
  ];
  return {
    steps: parts.flatMap((part) => part.steps),
    externals: merge('externals'),
    gates: merge('gates') as CheckId[],
    envKeys: merge('envKeys'),
    leaks: merge('leaks'),
  };
}

function laneInvocations(
  steps: readonly LaneStep[],
  scripts: Readonly<Record<string, string>>,
): { gates: CheckId[]; verbatim: string[] } {
  const gates = new Set<CheckId>();
  const verbatim = new Set<string>();
  for (const { run } of steps) {
    for (const match of run.matchAll(GATE_INVOCATION)) gates.add(match[1] as CheckId);
    for (const name of verbatimScripts(run, scripts)) verbatim.add(name);
  }
  return { gates: [...gates], verbatim: [...verbatim] };
}

/**
 * Execution surfaces the model does not read, reported rather than ignored. None are used
 * today; `defaults.run` would change the shell of every step in a lane, and a
 * reusable-workflow job runs steps declared in a file this loader never opens.
 */
function unsupported(doc: WorkflowDoc, job: Job, leaks: readonly string[]): string[] {
  return [
    ...(doc.defaults ? ['workflow-level `defaults:`'] : []),
    ...(job.defaults ? ['job-level `defaults:`'] : []),
    ...(job.uses ? [`\`uses: ${job.uses}\` (reusable workflow)`] : []),
    ...leaks.map((leak) => `${leak} is interpolated into a \`run:\` block; pass it as \`env:\``),
  ];
}

function workflowLanes(
  file: string,
  doc: WorkflowDoc,
  root: string,
  scripts: Readonly<Record<string, string>>,
  externals: readonly ExternalAction[],
): Lane[] {
  const on = (doc.on ?? doc.true ?? {}) as Record<
    string,
    { paths?: string[]; 'paths-ignore'?: string[] }
  >;
  const qualifying = 'pull_request' in on || 'schedule' in on;
  const { paths, pathsIgnore } = triggerPaths(on);
  return Object.entries(doc.jobs ?? {}).map(([jobId, job]) => {
    const surface = jobSurface(job, jobId, root, file, externals);
    const scanned = laneInvocations(surface.steps, scripts);
    return {
      workflow: file,
      label: laneLabel(doc.name ?? file, job.name ?? jobId),
      qualifying,
      gates: [...new Set([...scanned.gates, ...surface.gates])],
      verbatim: scanned.verbatim,
      steps: surface.steps,
      paths,
      pathsIgnore,
      envKeys: [
        ...new Set([
          ...Object.keys(doc.env ?? {}),
          ...Object.keys(job.env ?? {}),
          ...surface.envKeys,
        ]),
      ],
      externals: surface.externals,
      unsupported: unsupported(doc, job, surface.leaks),
    };
  });
}

/** `root` is where `./.github/actions/…` resolves from — separate so tests can load a
 *  planted workflow against the real actions. */
export function loadLanes(
  dir: string,
  root: string,
  scripts: Readonly<Record<string, string>> = {},
  externals: readonly ExternalAction[] = EXTERNAL_ACTIONS,
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
        externals,
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
