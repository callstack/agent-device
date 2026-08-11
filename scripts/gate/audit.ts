// Every guarantee the gate manifest makes, as assertions over the model.
//
// All of them are phrased against one primitive — `covered(check, path)` from
// model.ts — so there is no per-guarantee machinery to keep honest. What used to
// be six subsystems (shell-command parsing, terminal resolution, catalog wiring,
// path categories, selector-rule extraction, waiver provenance) is the handful of
// functions below, because CI can only reach a gate through `pnpm gate <id>`.

import { CHECK_CATALOG } from '../check-affected/checks.ts';
import { UNROUTED, type Unrouted } from './declarations.ts';
import {
  categories,
  checkUnits,
  commandSegments,
  commandUnits,
  covered,
  invokedScript,
  scriptUnits,
  unitCovers,
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

function isGateInvocation(segment: string): boolean {
  return /(?:^|\s)pnpm\s+(?:--\S+\s+)*gate\s+/.test(segment);
}

/** A command that repeats a script's body verbatim is credited, not bypassed. */
function isVerbatim(segment: string, lane: Lane, model: Model): boolean {
  const normalized = segment.replace(/\s+/g, ' ');
  return lane.verbatim.some((name) => model.scripts[name]?.replace(/\s+/g, ' ') === normalized);
}

/**
 * Whether a segment runs this project's own code — decided on the TOKENS it contains,
 * never on which token is in executable position.
 *
 * Position-based classification has to reconstruct wrapper syntax, and loses to the
 * next spelling every time: `pnpm exec`, then `pnpm --silent exec`, then
 * `pnpm exec --`, then `npx --yes`. There is no closed set to enumerate. A token scan
 * has no grammar to get wrong — a command that names a tracked repo file, a test
 * runner, or a package script IS project code however it is invoked, wrapped, or
 * prefixed. Anything it over-reports is inventoried once in UNROUTED, which fails
 * loudly when it stops applying; anything a position parser under-reports is silent.
 */
function runsProjectCode(segment: string, model: Model): boolean {
  if (isGateInvocation(segment) || invokedScript(segment, model.scripts) !== null) return true;
  return segment.split(/\s+/).some((token) => {
    if (token === 'vitest' || token === '--test') return true;
    const candidate = token.replace(/^["']|["']$/g, '').replace(/^\.\//, '');
    // A path to runnable code in this repo. Data files (`package.json`) and directories
    // are excluded: naming one is not executing anything, and `echo "package.json …"`
    // would otherwise read as a gate.
    return (
      candidate.includes('/') &&
      EXECUTABLE_FILE.test(candidate) &&
      model.trackedFiles.has(candidate)
    );
  });
}

const EXECUTABLE_FILE = /\.(?:[cm]?[jt]s|sh|bash|py)$/;

function projectCommands(lane: Lane, model: Model): { step: string; command: string }[] {
  return lane.steps.flatMap((step) =>
    step.commands
      .flatMap(commandSegments)
      .filter((segment) => !isVerbatim(segment, lane, model))
      .filter((segment) => runsProjectCode(segment, model))
      .map((command) => ({ step: step.name, command })),
  );
}

function isUnrouted(entry: Unrouted, lane: Lane, step: string, script: string | null): boolean {
  if (entry.kind === 'step') return entry.workflow === lane.workflow && entry.step === step;
  return (
    entry.script === script && (entry.workflow === undefined || entry.workflow === lane.workflow)
  );
}

// 3. No bypass: a qualifying lane may run project code only through `pnpm gate`, as
//    a suite some check already owns, or as a declared exception. This is what makes
//    an unregistered gate impossible rather than merely undeclared.
function classify(
  lane: Lane,
  step: string,
  command: string,
  model: Model,
  owned: ReadonlySet<string>,
  declared: readonly Unrouted[],
): Failure | null {
  if (isGateInvocation(command)) {
    const id = /gate\s+([a-z0-9:-]+)/.exec(command)?.[1] ?? '';
    if (REGISTERED.has(id)) return null;
    return fail(
      'bypass',
      `${lane.workflow} / ${step}: \`pnpm gate ${id}\` names no registered check.`,
    );
  }
  // Re-running a suite a check already owns (a device lane replaying an owned
  // integration file under a live emulator) hides nothing.
  const units = commandUnits(command, model);
  if (
    units.length > 0 &&
    units.every((unit) => [...owned].some((have) => unitCovers(have, unit)))
  ) {
    return null;
  }
  const script = invokedScript(command, model.scripts);
  if (declared.some((entry) => isUnrouted(entry, lane, step, script))) return null;
  const hint = script
    ? `Run it as \`pnpm gate <id>\` (script "${script}" must belong to a registered check)`
    : 'Register the gate it runs, or declare the step in UNROUTED';
  return fail(
    'bypass',
    `${lane.workflow} / ${step}: project code outside the runner — \`${command}\`. ${hint}.`,
  );
}

function bypass(model: Model, declared: readonly Unrouted[]): Failure[] {
  const owned = new Set(CHECK_CATALOG.flatMap((spec) => checkUnits(spec, model)));
  return model.lanes
    .filter((lane) => lane.qualifying)
    .flatMap((lane) =>
      projectCommands(lane, model).flatMap(({ step, command }) => {
        const failure = classify(lane, step, command, model, owned, declared);
        return failure ? [failure] : [];
      }),
    );
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

// 5. No inert declaration. Every entry must still describe something the tree does,
//    and an opaque-runner declaration must still change the audit — so deleting the
//    step a declaration covers is loud rather than silent.
function inertStep(
  entry: Extract<Unrouted, { kind: 'step' }>,
  qualifying: readonly Lane[],
): Failure[] {
  const matches = qualifying
    .filter((lane) => lane.workflow === entry.workflow)
    .flatMap((lane) => lane.steps.filter((step) => step.name === entry.step));
  if (matches.length === 1) return [];
  const detail =
    matches.length === 0 ? 'matches no step; remove it' : `matches ${matches.length} steps`;
  return [fail('inert', `UNROUTED step ${entry.workflow} / "${entry.step}" ${detail}.`)];
}

function inertScript(
  entry: Extract<Unrouted, { kind: 'script' }>,
  qualifying: readonly Lane[],
  model: Model,
): Failure[] {
  const used = qualifying
    .filter((lane) => entry.workflow === undefined || lane.workflow === entry.workflow)
    .flatMap((lane) => projectCommands(lane, model))
    .some(({ command }) => invokedScript(command, model.scripts) === entry.script);
  if (used) return [];
  return [
    fail(
      'inert',
      `UNROUTED script "${entry.script}" is run by no qualifying lane outside the runner; remove it.`,
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
  return [
    ...declared.flatMap((entry) =>
      entry.kind === 'step' ? inertStep(entry, qualifying) : inertScript(entry, qualifying, model),
    ),
    ...inertOpaque(model),
  ];
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

export function audit(model: Model, declared: readonly Unrouted[] = UNROUTED): Failure[] {
  return [
    ...unowned(model),
    ...bypass(model, declared),
    ...pathCoverage(model),
    ...inert(model, declared),
    ...unregisteredSuites(model),
    ...orphanProjects(model),
  ];
}
