// The gate manifest's model: what each registered check actually runs, and which
// CI lanes run it.
//
// Three derivations, all off real sources, and deliberately no more than that:
//
//   units(script)  — what a package.json script executes, as Vitest projects and
//                    `node --test` files rather than script names, so a lane that
//                    runs the whole suite covers a lane that runs part of it.
//   lanes()        — one entry per workflow job, carrying the CheckIds it invokes
//                    through `pnpm gate` and the path filter of its workflow.
//   categories()   — one representative changed path per selector rule, found by
//                    running the real selector over the tracked tree.
//
// Lane→check resolution needs no shell interpretation at all. audit.ts enforces the
// construction rule — every `run:` block in a qualifying lane is either a `pnpm gate`
// invocation or an inventoried exception — so finding what a lane runs is a scan for
// `pnpm gate <id>`, not an attempt to understand arbitrary shell. That is what removes
// the interpretation framework this file replaces.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { CHECK_CATALOG, type CheckSpec } from '../check-affected/checks.ts';
import { selectChecks, type CheckId } from '../check-affected/model.ts';
import { OPAQUE_RUNNERS } from './declarations.ts';

/**
 * What a lane runs, at the granularity ownership is decided on. Scripts are too
 * coarse: CI's Coverage lane runs `test:coverage:ci`, not `test:unit`, and only
 * project-level units make the first cover the second.
 *
 *   `vitest:<project>`         a whole Vitest project
 *   `vitest:<project>@<file>`  one file of it — covered BY the bare project, never the reverse
 *   `node-test:<file>`         one `node --test` file, globs expanded against the tree
 *   `script:<name>`            any other leaf, identified by the script that runs it
 */
export type Unit = string;

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
};

/**
 * `run` is the step's shell block — the thing the no-bypass rule is asserted over.
 * `inputs` are the string values it hands to an action, scanned for gate invocations
 * but not themselves shell (a composite action's own `run:` is a lane step too).
 */
export type LaneStep = {
  readonly name: string;
  /** The file declaring the step: a workflow, or the composite action it came from. */
  readonly source: string;
  readonly run?: string;
  readonly inputs: readonly string[];
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
  const canonical = JSON.stringify({ run: run.replace(/\s+/g, ' ').trim(), extras });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/**
 * GitHub evaluates `${{ … }}` before the shell sees it, so it is not shell syntax.
 * The placeholder deliberately contains no shell metacharacters: an earlier `<expr>`
 * collided with the redirection characters the gate grammar rejects, so every gate
 * step carrying a matrix expression looked like a bypass.
 */
export function stripExpressions(text: string): string {
  return text.replace(/\$\{\{[^}]*\}\}/g, 'GITHUB_EXPR');
}

export type Model = {
  readonly scripts: Readonly<Record<string, string>>;
  readonly vitestProjects: readonly string[];
  readonly lanes: readonly Lane[];
  readonly trackedFiles: ReadonlySet<string>;
  /** Source files behind package.json `exports`, the way `check:affected` supplies them. */
  readonly packageEntryFiles: readonly string[];
  /** Threaded rather than imported so the audit can re-run with a declaration removed. */
  readonly opaque: Readonly<Record<string, readonly string[]>>;
};

// --- Units -------------------------------------------------------------------

const ENV_PREFIX = /^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

/** `a && b`, `a; b`, and `a | b` all run both sides; newlines and `\` continuations join first. */
export function commandSegments(body: string): string[] {
  return body
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map(stripComment)
    .join('\n')
    .split(/&&|\|\||[;\n|]/)
    .map((segment) => segment.trim().replace(ENV_PREFIX, ''))
    .filter(Boolean);
}

/** `echo done # && pnpm test:unit` must not credit test:unit. Quotes protect a literal `#`. */
function stripComment(line: string): string {
  for (const match of line.matchAll(/"[^"]*"|'[^']*'|(?:^|\s)#/g)) {
    if (match[0].endsWith('#')) return line.slice(0, match.index);
  }
  return line;
}

function tokens(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

/** `pnpm x`, `pnpm run x`, `pnpm --silent x` — the invoked script, or null. */
function invokedScript(segment: string, scripts: Readonly<Record<string, string>>): string | null {
  const parts = tokens(segment);
  if (parts[0] !== 'pnpm') return null;
  for (const part of parts.slice(1)) {
    if (part === 'run' || part.startsWith('-')) continue;
    return part in scripts ? part : null;
  }
  return null;
}

function expandGlob(pattern: string): string[] {
  if (!pattern.includes('*')) return [pattern];
  const dir = path.dirname(pattern);
  const rest = path.basename(pattern);
  const matcher = new RegExp(
    `^${rest.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
  );
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => matcher.test(entry))
    .map((entry) => path.posix.join(dir, entry))
    .sort();
}

/** `--project x`, `--project=x`, and positional file arguments. */
function vitestArgs(parts: readonly string[]): { named: string[]; files: string[] } {
  const named: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (part === '--project') named.push(parts[++i] ?? '');
    else if (part.startsWith('--project=')) named.push(part.slice('--project='.length));
    else if (!part.startsWith('-') && /[./]/.test(part) && !RUNNER_TOKENS.test(part))
      files.push(part);
  }
  return { named, files };
}

const RUNNER_TOKENS = /^(?:pnpm|exec|vitest|run)$/;

function vitestUnits(parts: readonly string[], projects: readonly string[]): Unit[] {
  const { named, files } = vitestArgs(parts);
  // A bare run spans every project; a filtered run covers only the files it names,
  // so a docs-only lane running one unit-core file cannot claim the whole project.
  const selected = named.length > 0 ? named : projects;
  const suffix = files.length > 0 ? `@${files.join(',')}` : '';
  return selected.map((project) => `vitest:${project}${suffix}`);
}

function nodeTestUnits(parts: readonly string[]): Unit[] {
  const targets = parts
    .slice(parts.indexOf('--test') + 1)
    .filter((part) => !part.startsWith('-'))
    .flatMap(expandGlob);
  return targets.map((file) => `node-test:${file}`);
}

/**
 * The units a package.json script executes. Aggregates (`pnpm a && pnpm b`) expand
 * transitively; anything else is identified by the script that runs it, so a renamed
 * script surfaces as an unowned unit rather than as a silently satisfied claim.
 */
export function scriptUnits(
  script: string,
  model: Pick<Model, 'scripts' | 'vitestProjects' | 'opaque'>,
  seen: ReadonlySet<string> = new Set(),
): Unit[] {
  const declared = model.opaque[script];
  if (declared) return [...declared];
  const body = model.scripts[script];
  if (body === undefined || seen.has(script)) return [];
  const next = new Set([...seen, script]);
  return [
    ...new Set(
      commandSegments(body).flatMap((segment) => segmentUnits(segment, script, model, next)),
    ),
  ];
}

function segmentUnits(
  segment: string,
  script: string,
  model: Pick<Model, 'scripts' | 'vitestProjects' | 'opaque'>,
  seen: ReadonlySet<string>,
): Unit[] {
  const nested = invokedScript(segment, model.scripts);
  if (nested) return scriptUnits(nested, model, seen);
  const parts = tokens(segment);
  if (parts.includes('vitest')) return vitestUnits(parts, model.vitestProjects);
  if (parts.includes('--test')) return nodeTestUnits(parts);
  return [`script:${script}`];
}

/** A lane running `have` satisfies a need for `want`. Whole projects cover their files. */
export function unitCovers(have: Unit, want: Unit): boolean {
  if (have === want) return true;
  return want.startsWith(`${have}@`);
}

export function checkUnits(spec: CheckSpec, model: Model): Unit[] {
  // `vitest-related` has no script: it is Vitest's own `related` command over the
  // diff, so the lane that runs the whole suite is what owns it.
  if (spec.kind.type === 'vitest-related') {
    return model.vitestProjects.map((name) => `vitest:${name}`);
  }
  return scriptUnits(spec.kind.script, model);
}

// --- Lanes -------------------------------------------------------------------

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

/** String values a step hands to an action — scanned for gate invocations, not shell. */
function stepInputs(step: RawStep): string[] {
  return Object.values(step.with ?? {}).filter(
    (value): value is string => typeof value === 'string',
  );
}

function laneLabel(workflowName: string, jobName: string): string {
  return workflowName === 'CI' ? jobName : `${workflowName} / ${jobName}`;
}

function triggerPaths(on: Record<string, { paths?: string[]; 'paths-ignore'?: string[] }>) {
  const pr = on['pull_request'] ?? {};
  return { paths: pr.paths ?? [], pathsIgnore: pr['paths-ignore'] ?? [] };
}

/**
 * Steps of a local composite action a job `uses:`. A gate invoked from inside one
 * still belongs to the calling lane — the Android helper packaging is only reachable
 * that way — and its commands are held to the same no-bypass rule.
 */
function compositeSteps(
  uses: string,
  root: string,
  depth = 0,
): { step: RawStep; source: string }[] {
  if (!uses.startsWith('./') || depth > 3) return [];
  const source = `${uses.slice(2)}/action.yml`;
  const file = path.join(root, source);
  if (!fs.existsSync(file)) return [];
  const doc = parse(fs.readFileSync(file, 'utf8')) as { runs?: { steps?: RawStep[] } };
  return (doc.runs?.steps ?? []).flatMap((step) => [
    { step, source },
    ...(step.uses ? compositeSteps(step.uses, root, depth + 1) : []),
  ]);
}

type WorkflowDoc = {
  name?: string;
  env?: Record<string, unknown>;
  // `on:` is YAML 1.1 truthy; the parser hands it back under `true`.
  on?: Record<string, never>;
  true?: Record<string, never>;
  jobs?: Record<string, { name?: string; env?: Record<string, unknown>; steps?: RawStep[] }>;
};

/**
 * A job's own steps plus the steps of every local composite action it uses.
 *
 * Nothing is filtered out. An earlier version dropped steps carrying
 * `working-directory`, which made a bypass placed in one invisible.
 */
function laneSteps(
  job: { name?: string; steps?: RawStep[] },
  jobId: string,
  root: string,
  workflow: string,
): LaneStep[] {
  return (job.steps ?? [])
    .flatMap((step) => [
      { step, source: workflow },
      ...(step.uses ? compositeSteps(step.uses, root) : []),
    ])
    .map(({ step, source }) => {
      const extras = stepExtras(step);
      return {
        name: step.name ?? jobId,
        source,
        ...(typeof step.run === 'string' ? { run: step.run } : {}),
        inputs: stepInputs(step),
        extras,
        digest: typeof step.run === 'string' ? stepDigest(step.run, extras) : '',
      };
    });
}

function laneInvocations(
  steps: readonly LaneStep[],
  scripts: Readonly<Record<string, string>>,
): { gates: CheckId[]; verbatim: string[] } {
  const gates = new Set<CheckId>();
  const verbatim = new Set<string>();
  for (const command of steps.flatMap((step) => [
    ...(step.run ? [step.run] : []),
    ...step.inputs,
  ])) {
    for (const match of command.matchAll(GATE_INVOCATION)) gates.add(match[1] as CheckId);
    for (const name of verbatimScripts(command, scripts)) verbatim.add(name);
  }
  return { gates: [...gates], verbatim: [...verbatim] };
}

function inheritedEnv(
  doc: WorkflowDoc,
  job: { env?: Record<string, unknown> },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...doc.env, ...job.env })) env[key] = String(value);
  return env;
}

function workflowLanes(
  file: string,
  doc: WorkflowDoc,
  actionRoot: string,
  scripts: Readonly<Record<string, string>>,
): Lane[] {
  const on = (doc.on ?? doc.true ?? {}) as Record<
    string,
    { paths?: string[]; 'paths-ignore'?: string[] }
  >;
  const qualifying = 'pull_request' in on || 'schedule' in on;
  const { paths, pathsIgnore } = triggerPaths(on);
  return Object.entries(doc.jobs ?? {}).map(([jobId, job]) => {
    const steps = laneSteps(job, jobId, actionRoot, file);
    const env = inheritedEnv(doc, job);
    return {
      workflow: file,
      label: laneLabel(doc.name ?? file, job.name ?? jobId),
      qualifying,
      ...laneInvocations(steps, scripts),
      steps,
      paths,
      pathsIgnore,
      env,
      envDigest: Object.keys(env).length === 0 ? '' : stepDigest('', env),
    };
  });
}

function loadLanes(
  dir = '.github/workflows',
  scripts: Readonly<Record<string, string>> = {},
): Lane[] {
  const actionRoot = path.resolve(dir, '..', '..');
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith('.yml'))
    .sort()
    .flatMap((file) =>
      workflowLanes(
        file,
        parse(fs.readFileSync(path.join(dir, file), 'utf8')) as WorkflowDoc,
        actionRoot,
        scripts,
      ),
    );
}

// --- Coverage ----------------------------------------------------------------

/** GitHub's filter glob: `**` spans separators, `*` stops at one. */
export function matchesGlob(pattern: string, file: string): boolean {
  const source = pattern
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`).test(file);
}

/** Whether a change to `file` alone starts this lane's workflow. */
function triggersOnPath(lane: Lane, file: string): boolean {
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

function laneUnits(lane: Lane, model: Model): Unit[] {
  const fromGates = lane.gates.flatMap((id) => {
    const spec = CHECK_CATALOG.find((entry) => entry.id === id);
    return spec ? checkUnits(spec, model) : [];
  });
  return [...fromGates, ...lane.verbatim.flatMap((name) => scriptUnits(name, model))];
}

/**
 * The one decision every assertion is phrased against: is every unit of `spec` run
 * by a qualifying lane that a change to `file` would start? `file` of null asks the
 * weaker question — that the check runs at all.
 */
export function covered(
  spec: CheckSpec,
  file: string | null,
  model: Model,
): { covered: boolean; missing: Unit[]; lanes: string[] } {
  const wanted = checkUnits(spec, model);
  const usable = model.lanes.filter(
    (lane) => lane.qualifying && (file === null || triggersOnPath(lane, file)),
  );
  const owners = new Map<Unit, string[]>();
  for (const lane of usable) {
    const have = laneUnits(lane, model);
    for (const want of wanted) {
      if (have.some((unit) => unitCovers(unit, want)))
        owners.set(want, [...(owners.get(want) ?? []), lane.label]);
    }
  }
  const missing = wanted.filter((unit) => !owners.has(unit));
  return {
    covered: wanted.length > 0 && missing.length === 0,
    missing,
    lanes: [...new Set([...owners.values()].flat())].sort(),
  };
}

export type Category = {
  readonly rule: string;
  readonly path: string;
  readonly checks: readonly CheckId[];
};

/**
 * One representative changed path per selector category, discovered by running the
 * REAL selector across the tracked tree — not listed by hand.
 *
 * The hand-written list this replaces had eight entries naming files that did not
 * exist: the selector classifies by prefix, so a fictional path resolves and the
 * assertion reads green while describing a change no PR can make. Derivation makes
 * that unrepresentable, and it needs no upkeep when a rule is added.
 *
 * A category is a `rule` the selector actually emits somewhere in the tree, so a rule
 * whose paths do not exist yet is absent — correctly, since no PR can exercise it
 * until such a file is added, at which point it becomes a category and is checked.
 */
export function categories(model: Model): Category[] {
  const found = new Map<string, Category>();
  for (const path of [...model.trackedFiles].sort()) {
    const plan = selectChecks({ changedFiles: [path], packageEntryFiles: model.packageEntryFiles });
    if (plan.failOpen) continue;
    for (const { rule } of plan.reasons) {
      if (!found.has(rule)) found.set(rule, { rule, path, checks: plan.checks });
    }
  }
  return [...found.values()];
}

/**
 * The GitHub jobs that run each check, derived rather than declared. `check:affected`
 * prints these as the authority for skipping a check locally, so deriving them is
 * what keeps that claim from going stale (it was a hand-maintained `ciJobs` field).
 */
export function owningLanes(model: Model): Map<CheckId, string[]> {
  return new Map(CHECK_CATALOG.map((spec) => [spec.id, covered(spec, null, model).lanes]));
}

export function loadModel(
  repoRoot: string,
  trackedFiles: readonly string[],
  opaque: Readonly<Record<string, readonly string[]>> = OPAQUE_RUNNERS,
): Model {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
    exports?: Record<string, { import?: string }>;
  };
  const config = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
  return {
    scripts: pkg.scripts,
    packageEntryFiles: Object.values(pkg.exports ?? {})
      .map((entry) => entry.import)
      .filter((target): target is string => typeof target === 'string')
      .map((target) => target.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts')),
    vitestProjects: [...config.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1] as string),
    lanes: loadLanes(path.join(repoRoot, '.github/workflows'), pkg.scripts),
    trackedFiles: new Set(trackedFiles),
    opaque,
  };
}
