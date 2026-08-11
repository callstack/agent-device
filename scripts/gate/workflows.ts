// What each CI lane executes: one Lane per workflow job, carrying every shell block the
// job reaches and the gate ids it invokes.
//
// The whole file answers one question — "what will GitHub run for this job?" — and it
// answers it by CONSTRUCTION rather than interpretation. A shell block is a shell block
// whether it was spelled as a `run:` step, as a `run:` step inside a composite action, or
// as a `with:` value the action interpolates into one; collapsing those three spellings
// into `LaneStep` is what lets audit.ts hold all of them to a single rule.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { CheckId } from '../check-affected/model.ts';
import { EXTERNAL_ACTIONS, type ExternalAction } from './declarations.ts';
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
  /**
   * Workflow- and job-level `env:`, which every step in the lane inherits. Modelled at
   * the lane rather than folded into each step's digest: one `NODE_OPTIONS` here injects
   * into every step at once, so it is one fact about the lane, not N facts about steps.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly envDigest: string;
  /** `owner/repo@ref` for every third-party action the lane reaches, deduplicated. */
  readonly externals: readonly string[];
  /** Execution surfaces this file uses that the model does not read. Always empty today. */
  readonly unsupported: readonly string[];
};

/**
 * One shell block a lane executes — the unit the no-bypass rule is asserted over.
 *
 * A step is not always a `run:` block. A composite action that runs
 * `${{ inputs.build-command }}` executes whatever its CALLER passed, so the caller's
 * value is a step of the calling lane too (`actionInputSteps`). Modelling both as the
 * same thing is what keeps one construction rule sufficient.
 */
export type LaneStep = {
  readonly name: string;
  /** The file declaring the step: a workflow, or the composite action it came from. */
  readonly source: string;
  readonly run: string;
  /**
   * Everything besides `run` that changes what the step executes. `env` matters because
   * `NODE_OPTIONS=--import ./x.ts` runs code without appearing in any command; `shell`
   * and `working-directory` change the interpreter and the resolution root.
   */
  readonly extras: Readonly<Record<string, string>>;
  /**
   * Fingerprint over the step's executable identity — `run` plus every extra. The
   * inventory binds THIS, not the step's name: a name is mutable metadata, and an entry
   * keyed on it accepts whatever body is later put behind it.
   */
  readonly digest: string;
};

/** Exported so tests re-seal a mutated step with the real function, never a copy. */
export function stepDigest(run: string, extras: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify({
    run: run.replace(/\s+/g, ' ').trim(),
    extras,
  });
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

/** Execution-affecting keys other than `run`, flattened for the fingerprint. */
function stepExtras(step: RawStep): Record<string, string> {
  const extras: Record<string, string> = {};
  for (const [key, value] of Object.entries(step.env ?? {})) extras[`env.${key}`] = String(value);
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

type ActionDoc = {
  inputs?: Record<string, { default?: string }>;
  runs?: { steps?: RawStep[] };
};

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
 * Guards composite-action recursion. A cycle cannot run on GitHub either, so this is a
 * repository error rather than a case to model — but it must be LOUD: the depth cutoff
 * this replaces returned an empty step list, which reads to every assertion downstream
 * as "this action executes nothing".
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

const INPUT_REFERENCE = /\$\{\{\s*inputs\.([\w-]+)/g;

/**
 * Inputs the action interpolates into a `run:` block — directly, or by forwarding the
 * value to another action that does. Those inputs are shell, so their VALUES are shell.
 *
 * Deliberately not "is the value in command position?": that is the shell-context
 * reconstruction this design exists to avoid. Any interpolation into a run block counts,
 * which sweeps in data-ish inputs (a device name, a timeout) and costs a few inventory
 * entries. That is the cheap direction to be wrong in.
 */
function executedInputs(doc: ActionDoc, root: string, chain: readonly string[]): string[] {
  const texts = (doc.runs?.steps ?? []).flatMap((step) => {
    if (typeof step.run === 'string') return [step.run];
    const nested = readAction(step.uses, root);
    if (!nested) return [];
    return executedInputs(nested.doc, root, enterAction(nested.source, chain)).map((name) =>
      String(step.with?.[name] ?? ''),
    );
  });
  return [
    ...new Set(
      texts.flatMap((text) =>
        [...text.matchAll(INPUT_REFERENCE)].map((match) => match[1] as string),
      ),
    ),
  ];
}

/**
 * The inputs of a third-party action whose values it executes, from its declaration.
 *
 * A local action is read; an external one cannot be, so it is DECLARED per pinned ref
 * (`declarations.ts` `EXTERNAL_ACTIONS`). An undeclared ref contributes no steps here and
 * is reported by audit.ts instead — the model must not quietly decide that an action it
 * knows nothing about executes nothing, which is the hole this closes.
 */
function declaredInputs(ref: string, externals: readonly ExternalAction[]): string[] | null {
  const entry = externals.find((candidate) => candidate.uses === ref);
  return entry ? [...entry.executes] : null;
}

/**
 * The executable surface of the action a `uses:` step names, however it is spelled.
 *
 * `executed` is in the action's declared order, so a reordered `with:` block does not move
 * the digest. `defaults` is what an OMITTED input falls back to — knowable only for a local
 * action; for a third-party one the default lives in the pinned action rather than in this
 * repo, so only what the call site supplies is audited, and the pin freezes the rest.
 */
type ActionSurface = {
  readonly called: string;
  readonly executed: readonly string[];
  readonly defaults: Readonly<Record<string, string>>;
};

function actionSurface(
  step: RawStep,
  root: string,
  externals: readonly ExternalAction[],
  chain: readonly string[],
): ActionSurface | null {
  const local = readAction(step.uses, root);
  if (local) {
    const executed = new Set(executedInputs(local.doc, root, enterAction(local.source, chain)));
    const inputs = Object.entries(local.doc.inputs ?? {});
    return {
      called: path.basename(step.uses ?? ''),
      executed: inputs.map(([name]) => name).filter((name) => executed.has(name)),
      defaults: Object.fromEntries(
        inputs.map(([name, spec]) => [name, String(spec.default ?? '')]),
      ),
    };
  }
  const ref = externalRef(step.uses);
  const declared = ref === null ? null : declaredInputs(ref, externals);
  if (ref === null || declared === null) return null;
  return { called: ref, executed: [...declared].sort(), defaults: {} };
}

/** The values a `uses:` step supplies for inputs the action executes, as one lane step. */
function actionInputSteps(
  step: RawStep,
  source: string,
  jobId: string,
  root: string,
  externals: readonly ExternalAction[],
  chain: readonly string[],
): LaneStep[] {
  const surface = actionSurface(step, root, externals, chain);
  if (surface === null) return [];
  const supplied = surface.executed
    .map((name) => [name, String(step.with?.[name] ?? surface.defaults[name] ?? '')] as const)
    .filter(([, value]) => value.trim() !== '');
  if (supplied.length === 0) return [];
  const names = supplied.map(([name]) => name).join(', ');
  const label = `${step.name ?? jobId} → ${surface.called} (${names})`;
  return [sealed(label, source, supplied.map(([, value]) => value).join('\n'), {})];
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
};

/**
 * Every shell block a job reaches: its own `run:` steps, the `run:` steps of every local
 * composite action it uses, and the executable inputs it passes to any action, local or
 * third-party.
 *
 * Nothing is filtered out. An earlier version dropped steps carrying `working-directory`,
 * which made a bypass placed in one invisible.
 */
function jobSurface(
  job: Job,
  jobId: string,
  root: string,
  source: string,
  externals: readonly ExternalAction[],
  chain: readonly string[] = [],
): Surface {
  const parts = (job.steps ?? []).map((step): Surface => {
    const local = readAction(step.uses, root);
    const ref = externalRef(step.uses);
    const nested = local
      ? jobSurface(
          local.doc.runs ?? {},
          jobId,
          root,
          local.source,
          externals,
          enterAction(local.source, chain),
        )
      : { steps: [], externals: [] };
    return {
      steps: [
        ...(typeof step.run === 'string'
          ? [sealed(step.name ?? jobId, source, step.run, stepExtras(step))]
          : []),
        ...actionInputSteps(step, source, jobId, root, externals, chain),
        ...nested.steps,
      ],
      externals: [...(ref ? [ref] : []), ...nested.externals],
    };
  });
  return {
    steps: parts.flatMap((part) => part.steps),
    externals: [...new Set(parts.flatMap((part) => part.externals))],
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
function unsupported(doc: WorkflowDoc, job: Job): string[] {
  return [
    ...(doc.defaults ? ['workflow-level `defaults:`'] : []),
    ...(job.defaults ? ['job-level `defaults:`'] : []),
    ...(job.uses ? [`\`uses: ${job.uses}\` (reusable workflow)`] : []),
  ];
}

function inheritedEnv(doc: WorkflowDoc, job: Job): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...doc.env, ...job.env })) env[key] = String(value);
  return env;
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
    const env = inheritedEnv(doc, job);
    return {
      workflow: file,
      label: laneLabel(doc.name ?? file, job.name ?? jobId),
      qualifying,
      ...laneInvocations(surface.steps, scripts),
      steps: surface.steps,
      paths,
      pathsIgnore,
      env,
      envDigest: Object.keys(env).length === 0 ? '' : stepDigest('', env),
      externals: surface.externals,
      unsupported: unsupported(doc, job),
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
