// The gate manifest's model: what each registered check actually runs, and which
// CI lanes run it.
//
// Three derivations, all off real sources, and deliberately no more than that:
//
//   units(script)  — what a package.json script executes, as Vitest projects and
//                    `node --test` files rather than script names, so a lane that
//                    runs the whole suite covers a lane that runs part of it.
//   lanes()        — one entry per workflow job (workflows.ts), carrying the CheckIds
//                    it invokes through `pnpm gate` and the path filter of its workflow.
//   categories()   — one representative changed path per selector rule, found by
//                    running the real selector over the tracked tree.
//
// Lane→check resolution needs no shell interpretation at all: finding what a lane runs is
// a scan for `pnpm gate <id>`. Shell the scan does not recognise earns no credit, so the
// failure direction is an unowned check rather than a false pass.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { CHECK_CATALOG, type CheckSpec } from '../check-affected/checks.ts';
import { selectChecks, type CheckId } from '../check-affected/model.ts';
import { GATE_ACTIONS, OPAQUE_RUNNERS } from './declarations.ts';
import { ENV_PREFIX, commandSegments } from './shell.ts';
import {
  gateActionBody,
  loadLanes,
  triggersOnPath,
  type GateActionBody,
  type Lane,
} from './workflows.ts';

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

export type Model = {
  readonly scripts: Readonly<Record<string, string>>;
  readonly vitestProjects: readonly string[];
  readonly lanes: readonly Lane[];
  readonly trackedFiles: ReadonlySet<string>;
  /** Source files behind package.json `exports`, the way `check:affected` supplies them. */
  readonly packageEntryFiles: readonly string[];
  /** Threaded rather than imported so the audit can re-run with a declaration removed. */
  readonly opaque: Readonly<Record<string, readonly string[]>>;
  /** The single run step of each action GATE_ACTIONS names, for proving it runs the gate. */
  readonly gateActionBodies: Readonly<Record<string, GateActionBody>>;
};

// --- Units -------------------------------------------------------------------

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
function vitestArgs(parts: readonly string[]): {
  named: string[];
  files: string[];
} {
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
  raw: string,
  script: string,
  model: Pick<Model, 'scripts' | 'vitestProjects' | 'opaque'>,
  seen: ReadonlySet<string>,
): Unit[] {
  // What a segment RUNS is behind its env prefix (`VAR=1 pnpm test:x`), which is what
  // units are about.
  const segment = raw.replace(ENV_PREFIX, '');
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

// --- Coverage ----------------------------------------------------------------

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
 * Derived rather than declared because the selector classifies by PREFIX: a hand-written
 * sample naming a file that does not exist still resolves, so the assertion reads green
 * while describing a change no PR can make. Derivation also needs no upkeep when a rule
 * is added.
 *
 * A category is a `rule` the selector actually emits somewhere in the tree, so a rule
 * whose paths do not exist yet is absent — correctly, since no PR can exercise it
 * until such a file is added, at which point it becomes a category and is checked.
 */
export function categories(model: Model): Category[] {
  const found = new Map<string, Category>();
  for (const path of [...model.trackedFiles].sort()) {
    const plan = selectChecks({
      changedFiles: [path],
      packageEntryFiles: model.packageEntryFiles,
    });
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
    lanes: loadLanes(path.join(repoRoot, '.github/workflows'), repoRoot, pkg.scripts),
    trackedFiles: new Set(trackedFiles),
    opaque,
    gateActionBodies: Object.fromEntries(
      Object.entries(GATE_ACTIONS).flatMap(([source, input]) => {
        const file = path.join(repoRoot, source);
        if (!fs.existsSync(file)) return [];
        const body = gateActionBody(parse(fs.readFileSync(file, 'utf8')), input);
        return body ? [[source, body] as const] : [];
      }),
    ),
  };
}
