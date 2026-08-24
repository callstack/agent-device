// Derive script units, structural workflow owners, and real selector path categories.

import fs from 'node:fs';
import path from 'node:path';
import { CHECK_CATALOG, type CheckSpec } from '../check-affected/checks.ts';
import { selectChecks, type CheckId } from '../check-affected/model.ts';
import { OPAQUE_RUNNERS } from './declarations.ts';
import { ENV_PREFIX, commandSegments } from './shell.ts';
import { loadLanes, triggersOnPath, type Lane } from './workflows.ts';

// Units distinguish whole Vitest projects, filtered files, node:test files, and scripts.
export type Unit = string;

export type Model = {
  readonly scripts: Readonly<Record<string, string>>;
  readonly vitestProjects: readonly string[];
  readonly lanes: readonly Lane[];
  readonly trackedFiles: ReadonlySet<string>;
  readonly packageEntryFiles: readonly string[];
  readonly opaque: Readonly<Record<string, readonly string[]>>;
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

/**
 * Vitest's own `--project` semantics: bare names select, `!name` excludes, and a run with only
 * exclusions starts from every configured project. The model has to read the negated form or it
 * would credit a lane with a project it skips — `test:coverage:ci` runs `--project=!fuzz-worker`
 * and hands that project to a second, uninstrumented invocation.
 */
function selectedProjects(named: readonly string[], projects: readonly string[]): string[] {
  const excluded = new Set(
    named.filter((name) => name.startsWith('!')).map((name) => name.slice(1)),
  );
  const included = named.filter((name) => !name.startsWith('!'));
  const base = included.length > 0 ? included : projects;
  return base.filter((name) => !excluded.has(name));
}

function vitestUnits(parts: readonly string[], projects: readonly string[]): Unit[] {
  const { named, files } = vitestArgs(parts);
  const selected = named.length > 0 ? selectedProjects(named, projects) : projects;
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

// One real tracked path per selector rule; fictional hand-written samples are impossible.
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
  };
}
