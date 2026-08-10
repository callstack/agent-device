// Parsing .github/workflows/*.yml and .github/actions/* into lanes and their terminals.
//
// A lane is one workflow job plus everything it provably reaches: its own `run:` blocks, and
// the steps of any local composite action it `uses:`, with `${{ inputs.* }}` substituted from
// the caller's `with:` block. That substitution is load-bearing — the Swift build lane passes
// its real build command as an action input, so without it the whole lane looks unowned and
// the `${{ ... }}` reads as dynamic dispatch.

import { parse } from 'yaml';
import { commandSegments, tokenize } from './shell-commands.ts';
import {
  report,
  resolveTokens,
  type ResolveContext,
  type Sink,
  type Terminal,
  type UnresolvedEdge,
} from './execution-terminals.ts';

export type WorkflowStep = {
  readonly name: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with: Readonly<Record<string, string>>;
};

export type WorkflowJob = {
  readonly id: string;
  /** The `name:` value, or null when it interpolates an expression (a matrix job). */
  readonly name: string | null;
  readonly steps: readonly WorkflowStep[];
};

export type WorkflowTriggers = {
  readonly events: readonly string[];
  readonly pullRequestPaths?: readonly string[];
  readonly pullRequestPathsIgnore?: readonly string[];
};

export type WorkflowFile = {
  readonly file: string;
  readonly name: string;
  readonly triggers: WorkflowTriggers;
  readonly jobs: readonly WorkflowJob[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
}

function parseSteps(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    const step = asRecord(raw);
    if (!step) return [];
    const withInputs: Record<string, string> = {};
    for (const [key, input] of Object.entries(asRecord(step['with']) ?? {})) {
      if (typeof input === 'string') withInputs[key] = input;
    }
    return [
      {
        name: typeof step['name'] === 'string' ? step['name'] : `step ${index + 1}`,
        ...(typeof step['run'] === 'string' ? { run: step['run'] } : {}),
        ...(typeof step['uses'] === 'string' ? { uses: step['uses'] } : {}),
        with: withInputs,
      },
    ];
  });
}

export function parseWorkflow(file: string, source: string): WorkflowFile {
  const document = asRecord(parse(source)) ?? {};
  // `on:` is YAML 1.1's boolean `true` under some parsers; the `yaml` package keeps it a
  // string key, but read both so a parser upgrade cannot silently blank every trigger.
  const on = asRecord(document['on']) ?? asRecord(document[true as unknown as string]) ?? {};
  const pullRequest = asRecord(on['pull_request']);
  const jobs = Object.entries(asRecord(document['jobs']) ?? {}).flatMap(([id, raw]) => {
    const job = asRecord(raw);
    if (!job) return [];
    const name = typeof job['name'] === 'string' ? job['name'] : id;
    return [{ id, name: name.includes('${{') ? null : name, steps: parseSteps(job['steps']) }];
  });
  return {
    file,
    name: typeof document['name'] === 'string' ? document['name'] : file,
    triggers: {
      events: Object.keys(on),
      ...(pullRequest?.['paths'] ? { pullRequestPaths: stringList(pullRequest['paths']) } : {}),
      ...(pullRequest?.['paths-ignore']
        ? { pullRequestPathsIgnore: stringList(pullRequest['paths-ignore']) }
        : {}),
    },
    jobs,
  };
}

/**
 * The status-check names GitHub can show for a job: the bare job name, and the
 * `<workflow> / <job>` form required-context spelling. `CHECK_CATALOG.ciJobs` uses both.
 */
function jobCheckNames(workflow: WorkflowFile, job: WorkflowJob): string[] {
  return job.name === null ? [] : [job.name, `${workflow.name} / ${job.name}`];
}

export type Lane = {
  readonly workflow: string;
  readonly workflowName: string;
  readonly job: string;
  readonly checkNames: readonly string[];
  /** How the lane is triggered — a suite owned only by a scheduled lane is not a PR gate. */
  readonly kind: 'pull-request' | 'scheduled' | 'release' | 'push';
  readonly terminals: ReadonlySet<Terminal>;
  readonly unresolved: readonly UnresolvedEdge[];
};

function laneKind(triggers: WorkflowTriggers): Lane['kind'] {
  if (triggers.events.includes('pull_request')) return 'pull-request';
  if (triggers.events.includes('schedule') || triggers.events.includes('workflow_dispatch')) {
    return 'scheduled';
  }
  if (triggers.events.includes('release')) return 'release';
  return 'push';
}

/** Substitutes `${{ inputs.x }}` in a composite action step from the caller's `with:` block. */
function substituteInputs(
  run: string,
  callerWith: Readonly<Record<string, string>>,
  defaults: Readonly<Record<string, string>>,
): string {
  return run.replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (match, key: string) => {
    const value = callerWith[key] ?? defaults[key];
    return value === undefined || value.includes('${{') ? match : value;
  });
}

function actionInputDefaults(document: Record<string, unknown>): Record<string, string> {
  const defaults: Record<string, string> = {};
  for (const [key, raw] of Object.entries(asRecord(document['inputs']) ?? {})) {
    const value = asRecord(raw)?.['default'];
    if (typeof value === 'string') defaults[key] = value;
  }
  return defaults;
}

/** How deep a local action may call another before the walk stops descending. */
const MAX_ACTION_DEPTH = 4;

/**
 * Walks the steps of the local composite action a step `uses:`, with `${{ inputs.* }}` resolved
 * against the caller's `with:` block (falling back to the action's declared defaults).
 */
function resolveLocalAction(
  step: WorkflowStep,
  uses: string,
  ctx: ResolveContext,
  sink: Sink,
  depth: number,
): void {
  const source = ctx.actions.get(uses.replace(/^\.\//, ''));
  if (source === undefined) {
    report(sink, 'missing-action', `local action "${uses}" does not exist`);
    return;
  }
  const document = asRecord(parse(source)) ?? {};
  const defaults = actionInputDefaults(document);
  for (const nested of parseSteps(asRecord(document['runs'])?.['steps'])) {
    const run =
      nested.run === undefined ? undefined : substituteInputs(nested.run, step.with, defaults);
    resolveStep(
      { ...nested, ...(run === undefined ? {} : { run }), name: `${step.name} → ${nested.name}` },
      ctx,
      sink,
      depth + 1,
    );
  }
}

/** Walks one step, descending into local composite actions. `depth` bounds action nesting. */
function resolveStep(step: WorkflowStep, ctx: ResolveContext, sink: Sink, depth: number): void {
  sink.step = step.name;
  for (const segment of commandSegments(step.run ?? '')) {
    resolveTokens(tokenize(segment), ctx, sink, new Set());
  }
  if (step.uses?.startsWith('./') && depth <= MAX_ACTION_DEPTH) {
    resolveLocalAction(step, step.uses, ctx, sink, depth);
    sink.step = step.name;
  }
}

export function buildLanes(workflows: readonly WorkflowFile[], ctx: ResolveContext): Lane[] {
  const lanes: Lane[] = [];
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      const sink: Sink = {
        terminals: new Set(),
        unresolved: [],
        source: `${workflow.file}#${job.id}`,
        step: '(job)',
      };
      for (const step of job.steps) resolveStep(step, ctx, sink, 0);
      lanes.push({
        workflow: workflow.file,
        workflowName: workflow.name,
        job: job.id,
        checkNames: jobCheckNames(workflow, job),
        kind: laneKind(workflow.triggers),
        terminals: sink.terminals,
        unresolved: sink.unresolved,
      });
    }
  }
  return lanes;
}

/** Lanes indexed by every status-check name they can appear under. */
export function lanesByCheckName(lanes: readonly Lane[]): Map<string, Lane[]> {
  const byName = new Map<string, Lane[]>();
  for (const lane of lanes) {
    for (const name of lane.checkNames) byName.set(name, [...(byName.get(name) ?? []), lane]);
  }
  return byName;
}
