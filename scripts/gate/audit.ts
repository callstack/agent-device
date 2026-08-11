// Every guarantee the gate manifest makes, as assertions over the model.
//
// All of them are phrased against one primitive — `covered(check, path)` from
// model.ts — so there is no per-guarantee machinery to keep honest. What used to
// be six subsystems (shell-command parsing, terminal resolution, catalog wiring,
// path categories, selector-rule extraction, waiver provenance) is the handful of
// functions below, because CI can only reach a gate through `pnpm gate <id>`.

import { CHECK_CATALOG } from '../check-affected/checks.ts';
import {
  LANE_ENVIRONMENTS,
  NON_GATE_STEPS,
  type LaneEnvironment,
  type Unrouted,
} from './declarations.ts';
import {
  categories,
  checkUnits,
  commandSegments,
  covered,
  scriptUnits,
  stripExpressions,
  type Lane,
  type Model,
} from './model.ts';

export type Failure = { readonly assertion: string; readonly message: string };

const REGISTERED = new Set(CHECK_CATALOG.map((spec) => spec.id as string));

function fail(assertion: string, message: string): Failure {
  return { assertion, message };
}

// 1. Every registered check is run by some qualifying lane, unit by unit.
function unowned(model: Model): Failure[] {
  return CHECK_CATALOG.flatMap((spec) => {
    const result = covered(spec, null, model);
    if (result.covered) return [];
    const missing = result.missing.length > 0 ? result.missing.join(', ') : '(no units resolved)';
    return [
      fail(
        'owned',
        `check "${spec.id}" is not run by any pull_request/schedule lane: ${missing}. ` +
          `Add a step running \`pnpm gate ${spec.id}\`, or drop the check.`,
      ),
    ];
  });
}

/**
 * A gate invocation, matched over the WHOLE segment rather than as a prefix.
 *
 * Arguments may not contain command substitution — `$(…)` and backticks execute
 * something else, so `pnpm gate x $(node -e '…')` is a gate call carrying a payload.
 * `$VAR` is fine: it expands to a value, it does not run a program.
 */
const GATE_SEGMENT = /^pnpm(?:\s+--\S+)*\s+gate\s+([a-z0-9:-]+)((?:\s+[^\s;&|<>]+)*)\s*$/;

function gateSegment(segment: string): { id: string } | null {
  const match = GATE_SEGMENT.exec(segment);
  if (!match) return null;
  if (/\$\(|`/.test(match[2] ?? '')) return null;
  return { id: match[1] as string };
}

/**
 * A step allowed by shape alone: its shell is nothing but gate invocations, and it
 * declares no extras. Extras (`env`, `shell`, `working-directory`) change what runs
 * without appearing in a command — `NODE_OPTIONS=--import ./x.ts` is a bypass with an
 * empty command line — so a gate step carrying any of them is fingerprinted instead.
 */
function plainGateStep(step: {
  run?: string;
  extras: Readonly<Record<string, string>>;
}): string[] | null {
  if (step.run === undefined || Object.keys(step.extras).length > 0) return null;
  const segments = commandSegments(stripExpressions(step.run));
  if (segments.length === 0) return null;
  const ids: string[] = [];
  for (const segment of segments) {
    if (segment === 'true') continue;
    const gate = gateSegment(segment);
    if (!gate) return null;
    ids.push(gate.id);
  }
  return ids;
}

// 3. No bypass — a CONSTRUCTION rule over the step's executable identity.
//
//    Every `run:` step a qualifying lane reaches must be either a plain gate invocation
//    or an inventory entry whose DIGEST matches. Nothing inspects what a command does.
//
//    Four review rounds shaped this. Content analysis fell to `pnpm exec`, then
//    `pnpm exec --`/`npx --yes`, then `node -e 'import(…)'` — "does this text run project
//    code?" is not decidable from text. Keying the inventory on the step NAME then fell to
//    editing the body behind a listed name. A name is mutable metadata; the digest binds
//    `run` plus every execution-affecting key, so changing any of them makes the entry stop
//    matching — the step becomes unlisted (bypass) and the entry becomes inert, at once.
function bypass(model: Model, declared: readonly Unrouted[]): Failure[] {
  const seen = new Map<string, Model['lanes'][number]['steps'][number]>();
  for (const lane of model.lanes.filter((entry) => entry.qualifying)) {
    for (const step of lane.steps) {
      if (step.run !== undefined) seen.set(`${step.source}\u0000${step.digest}`, step);
    }
  }
  return [...seen.values()].flatMap((step) => {
    const ids = plainGateStep(step);
    if (ids !== null) {
      return ids
        .filter((id) => !REGISTERED.has(id))
        .map((id) =>
          fail(
            'bypass',
            `${step.source} / ${step.name}: \`pnpm gate ${id}\` names no registered check.`,
          ),
        );
    }
    if (declared.some((entry) => entry.workflow === step.source && entry.digest === step.digest)) {
      return [];
    }
    const listedName = declared.find(
      (entry) => entry.workflow === step.source && entry.step === step.name,
    );
    const detail = listedName
      ? `its NON_GATE_STEPS entry records digest ${listedName.digest}, but the step is now ${step.digest}`
      : `it is not in NON_GATE_STEPS (digest ${step.digest})`;
    return [
      fail(
        'bypass',
        `${step.source} / ${step.name}: a \`run:\` step a qualifying lane reaches must be ` +
          `\`pnpm gate <id>\` with no env/shell/working-directory, or inventoried — ${detail}.`,
      ),
    ];
  });
}

// 3b. A lane's inherited environment is fingerprinted too. `env` at workflow or job
//     level reaches every step, so `NODE_OPTIONS=--import ./x.ts` there would inject
//     into a plain gate step while the step itself stayed byte-identical.
function laneEnvironments(model: Model, declared: readonly LaneEnvironment[]): Failure[] {
  return model.lanes
    .filter((lane) => lane.qualifying && lane.envDigest !== '')
    .flatMap((lane) => {
      if (
        declared.some(
          (entry) => entry.workflow === lane.workflow && entry.digest === lane.envDigest,
        )
      ) {
        return [];
      }
      return [
        fail(
          'lane-env',
          `${lane.workflow} / ${lane.label}: the lane's inherited env is not in LANE_ENVIRONMENTS ` +
            `(digest ${lane.envDigest}): ${Object.keys(lane.env).sort().join(', ')}.`,
        ),
      ];
    });
}

function inertEnvironment(entry: LaneEnvironment, model: Model): Failure[] {
  const live = model.lanes.some(
    (lane) =>
      lane.qualifying && lane.workflow === entry.workflow && lane.envDigest === entry.digest,
  );
  if (live) return [];
  return [
    fail(
      'inert',
      `LANE_ENVIRONMENTS ${entry.workflow} / "${entry.job}" (digest ${entry.digest}) matches no ` +
        `qualifying lane; the environment was edited or the job removed.`,
    ),
  ];
}

// 4. Per-path coverage (#1420's class): every check a real selector run activates
//    for a category's path must be run by a lane that a PR touching only that path
//    actually starts. Assertion 1 can stay green while this fails — that is the point.
//
//    The categories are derived (model.ts), so there is no sample list to go stale and
//    no way to assert about a path that does not exist.
function pathCoverage(model: Model): Failure[] {
  return categories(model).flatMap((category) =>
    category.checks.flatMap((id) => {
      const spec = CHECK_CATALOG.find((entry) => entry.id === id);
      if (!spec) return [];
      const result = covered(spec, category.path, model);
      if (result.covered) return [];
      return [
        fail(
          'path-coverage',
          `a PR touching only ${category.path} (rule ${category.rule}) selects "${id}", but no ` +
            `lane that the change starts runs ${result.missing.join(', ')}.`,
        ),
      ];
    }),
  );
}

// 4. No inert declaration. Every listed step must still exist, exactly once, in a
//    qualifying lane — so deleting or renaming the step it covers is loud rather than
//    silent, and the inventory cannot accumulate entries for steps that are long gone.
function inertStep(entry: Unrouted, qualifying: readonly Lane[]): Failure[] {
  const matches = qualifying
    .flatMap((lane) => lane.steps)
    .filter((step) => step.source === entry.workflow && step.digest === entry.digest);
  if (matches.length > 0) return [];
  return [
    fail(
      'inert',
      `NON_GATE_STEPS ${entry.workflow} / "${entry.step}" (digest ${entry.digest}) matches no ` +
        `\`run:\` step a qualifying lane reaches; the step was edited, renamed away or deleted.`,
    ),
  ];
}

function inertOpaque(model: Model): Failure[] {
  return Object.keys(model.opaque).flatMap((script) => {
    if (!(script in model.scripts)) {
      return [fail('inert', `opaque-runner declaration "${script}" is not a package.json script.`)];
    }
    const without = { ...model.opaque };
    delete without[script];
    if (summarize(unowned({ ...model, opaque: without })) !== summarize(unowned(model))) return [];
    return [
      fail(
        'inert',
        `opaque-runner declaration "${script}" changes nothing; the units it names are covered anyway.`,
      ),
    ];
  });
}

function inert(model: Model, declared: readonly Unrouted[]): Failure[] {
  const qualifying = model.lanes.filter((lane) => lane.qualifying);
  return [...declared.flatMap((entry) => inertStep(entry, qualifying)), ...inertOpaque(model)];
}

/** Compared as a set, not a count: removing a waiver can trade one failure for another. */
function summarize(failures: readonly Failure[]): string {
  return [...new Set(failures.map((failure) => failure.message))].sort().join('\n');
}

/**
 * Units a check attests to. `vitest-related` is excluded: its units are the project
 * list itself, so counting it would make every new project own itself.
 */
function attestedUnits(model: Model): Set<string> {
  return new Set(
    CHECK_CATALOG.filter((spec) => spec.kind.type !== 'vitest-related').flatMap((spec) =>
      checkUnits(spec, model),
    ),
  );
}

// 6. Every suite belongs to a check. A script that runs a Vitest project or a
//    `node --test` file, and is reachable from no registered check, is a suite
//    nobody owns — the hole the old suite-universe naming convention left open.
function unregisteredSuites(model: Model): Failure[] {
  const owned = attestedUnits(model);
  return Object.keys(model.scripts).flatMap((script) => {
    const units = scriptUnits(script, model);
    const suites = units.filter(
      (unit) => unit.startsWith('vitest:') || unit.startsWith('node-test:'),
    );
    if (suites.length === 0) return [];
    const orphans = suites.filter(
      (unit) => ![...owned].some((have) => have === unit || unit.startsWith(`${have}@`)),
    );
    if (orphans.length === 0) return [];
    return [
      fail(
        'registered',
        `package script "${script}" runs ${orphans.join(', ')}, which no registered check covers. ` +
          `Add it to the catalog so a lane can run it through \`pnpm gate\`.`,
      ),
    ];
  });
}

// 7. Every Vitest project is somebody's suite. A project added to the config with
//    no lane running it is dead configuration that reads as coverage.
function orphanProjects(model: Model): Failure[] {
  const owned = attestedUnits(model);
  return model.vitestProjects
    .filter((name) => !owned.has(`vitest:${name}`))
    .map((name) => fail('registered', `Vitest project "${name}" is run by no registered check.`));
}

export function audit(model: Model, declared: readonly Unrouted[] = NON_GATE_STEPS): Failure[] {
  return [
    ...unowned(model),
    ...bypass(model, declared),
    ...laneEnvironments(model, LANE_ENVIRONMENTS),
    ...LANE_ENVIRONMENTS.flatMap((entry) => inertEnvironment(entry, model)),
    ...pathCoverage(model),
    ...inert(model, declared),
    ...unregisteredSuites(model),
    ...orphanProjects(model),
  ];
}
