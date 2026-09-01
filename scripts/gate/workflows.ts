// Which registered gates each GitHub job declares through the canonical run-gate action.
// Raw `run:` text is deliberately invisible: shell text is not an execution graph.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { CheckId } from '../check-affected/model.ts';
import { commandSegments } from './shell.ts';

const RUN_GATE_ACTION = './.github/actions/run-gate';

export type Lane = {
  readonly workflow: string;
  readonly label: string;
  readonly qualifying: boolean;
  /**
   * The workflow's trigger names, kept rather than collapsed into `qualifying`: "not a
   * pull_request/schedule lane" and "a lane only a human can start" are different facts, and
   * a declaration that means the second cannot be checked against the first.
   */
  readonly triggers: readonly string[];
  readonly gates: readonly CheckId[];
  /**
   * Repo-relative files of the local composite actions this job's steps use, transitively,
   * plus the workflow file itself: the lane's own machinery. Editing one of these changes what
   * the lane does, so the lane cannot claim to be unaffected by it (`scripts/gate/routing.ts`).
   */
  readonly uses: readonly string[];
  readonly verbatim: readonly string[];
  readonly paths: readonly string[];
  readonly pathsIgnore: readonly string[];
  readonly unsupported: readonly string[];
};

type RawStep = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type Job = { name?: string; steps?: RawStep[]; uses?: string };
type WorkflowDoc = {
  name?: string;
  on?: Record<string, never>;
  true?: Record<string, never>;
  jobs?: Record<string, Job>;
};
type ActionDoc = { runs?: { steps?: RawStep[] } };

function laneLabel(workflow: string, job: string): string {
  return workflow === 'CI' ? job : `${workflow} / ${job}`;
}

function readLocalAction(uses: string | undefined, root: string): ActionDoc | null {
  if (!uses?.startsWith('./')) return null;
  const file = path.join(root, uses.slice(2), 'action.yml');
  return fs.existsSync(file) ? (parse(fs.readFileSync(file, 'utf8')) as ActionDoc) : null;
}

function declaredGate(
  step: RawStep,
  inputs: Readonly<Record<string, unknown>>,
): CheckId | undefined {
  if (step.uses !== RUN_GATE_ACTION) return undefined;
  const raw = step.with?.gate;
  const input =
    typeof raw === 'string' ? /^\$\{\{\s*inputs\.([\w-]+)\s*\}\}$/.exec(raw)?.[1] : undefined;
  const gate = input ? inputs[input] : raw;
  return typeof gate === 'string' && gate.trim() ? (gate.trim() as CheckId) : undefined;
}

function declaredGates(
  steps: readonly RawStep[],
  root: string,
  chain: readonly string[] = [],
  inputs: Readonly<Record<string, unknown>> = {},
): CheckId[] {
  const gates: CheckId[] = [];
  for (const step of steps) {
    const gate = declaredGate(step, inputs);
    if (gate) {
      gates.push(gate);
      continue;
    }
    const action = readLocalAction(step.uses, root);
    if (!action || !step.uses) continue;
    if (chain.includes(step.uses)) {
      throw new Error(`composite action cycle: ${[...chain, step.uses].join(' → ')}`);
    }
    gates.push(
      ...declaredGates(action.runs?.steps ?? [], root, [...chain, step.uses], step.with ?? {}),
    );
  }
  return gates;
}

// Every file of every local composite action the steps use, transitively, as repo-relative
// paths. Same walk `declaredGates` performs, kept separate because it answers a different
// question: not "which gate does this lane declare" but "which files ARE this lane".
//
// The unit is the action's DIRECTORY, not its `action.yml`. A composite action's descriptor is
// only its entry point: `setup-fixture-app/action.yml` runs
// `bash "$GITHUB_ACTION_PATH/fetch-artifact.sh"`, and that script in turn runs its siblings
// `resolve-artifact-name.sh` and `trusted-artifact.mjs` — references that exist only inside
// shell, one level past anything YAML parsing can see. Collecting the directory needs no shell
// model and cannot miss a file however deep the chain goes; the cost is coarseness, which is
// harmless here because a file inside an action's own directory belongs to that action.
function localActionFiles(
  steps: readonly RawStep[],
  root: string,
  chain: readonly string[] = [],
): string[] {
  const files: string[] = [];
  for (const step of steps) {
    const action = readLocalAction(step.uses, root);
    if (!action || !step.uses || chain.includes(step.uses)) continue;
    const dir = step.uses.slice(2);
    files.push(
      ...filesUnder(path.join(root, dir)).map((file) => path.posix.join(dir, file)),
      ...localActionFiles(action.runs?.steps ?? [], root, [...chain, step.uses]),
    );
  }
  return files;
}

/** Every file under `dir`, recursively, as paths relative to it. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.posix.join(path.relative(dir, entry.parentPath).split(path.sep).join('/'), entry.name),
    );
}

function triggerPaths(on: Record<string, { paths?: string[]; 'paths-ignore'?: string[] }>) {
  const pr = on.pull_request ?? {};
  return { paths: pr.paths ?? [], pathsIgnore: pr['paths-ignore'] ?? [] };
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
  return Object.entries(doc.jobs ?? {}).map(([jobId, job]) => ({
    workflow: file,
    label: laneLabel(doc.name ?? file, job.name ?? jobId),
    qualifying,
    triggers: Object.keys(on),
    gates: [...new Set(declaredGates(job.steps ?? [], root))],
    uses: [...new Set([`.github/workflows/${file}`, ...localActionFiles(job.steps ?? [], root)])],
    verbatim: (job.steps ?? []).flatMap((step) =>
      typeof step.run === 'string' ? verbatimScripts(step.run, scripts) : [],
    ),
    paths,
    pathsIgnore,
    unsupported: job.uses ? [`\`uses: ${job.uses}\` (reusable workflow)`] : [],
  }));
}

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

export function matchesGlob(pattern: string, file: string): boolean {
  const escape = (part: string) =>
    part.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '[^/]*');
  return new RegExp(
    `^${pattern
      .split(/(\/\*\*\/|\/\*\*|\*\*\/|\*\*)/)
      .map((part) => {
        if (part === '/**/') return '/(?:.*/)?';
        if (part === '**/') return '(?:.*/)?';
        if (part === '/**') return '(?:/.*)?';
        if (part === '**') return '.*';
        return escape(part);
      })
      .join('')}$`,
  ).test(file);
}

export function triggersOnPath(lane: Lane, file: string): boolean {
  if (lane.pathsIgnore.some((pattern) => matchesGlob(pattern, file))) return false;
  if (lane.paths.length > 0) return lane.paths.some((pattern) => matchesGlob(pattern, file));
  return true;
}

export function verbatimScripts(
  command: string,
  scripts: Readonly<Record<string, string>>,
): string[] {
  const wanted = commandSegments(command).map((segment) => segment.replaceAll(/\s+/g, ' '));
  return Object.entries(scripts)
    .filter(([, body]) => wanted.includes(body.replaceAll(/\s+/g, ' ')))
    .map(([name]) => name);
}
