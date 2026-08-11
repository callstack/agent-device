// Every guarantee the gate manifest makes, as assertions over the model.
//
// All of them are phrased against one primitive — `covered(check, path)` from
// model.ts — so there is no per-guarantee machinery to keep honest. What used to
// be six subsystems (shell-command parsing, terminal resolution, catalog wiring,
// path categories, selector-rule extraction, waiver provenance) is the handful of
// functions below, because CI can only reach a gate through `pnpm gate <id>`.

import { CHECK_CATALOG } from '../check-affected/checks.ts';
import { NON_GATE_STEPS, type Unrouted } from './declarations.ts';
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
 * A step whose shell is nothing but gate invocations. `${{ … }}` is stripped first
 * (GitHub evaluates it before the shell); a trailing `true` is allowed so a
 * `pnpm gate x || true` envelope recorder still reads as a gate step.
 */
function isGateStep(run: string): boolean {
  const segments = commandSegments(stripExpressions(run));
  return (
    segments.length > 0 &&
    segments.every((segment) => GATE_CALL.test(segment) || segment === 'true')
  );
}

const GATE_CALL = /^pnpm(?:\s+--\S+)*\s+gate\s+([a-z0-9:-]+)/;

function gateIds(run: string): string[] {
  return commandSegments(stripExpressions(run)).flatMap((segment) => {
    const id = GATE_CALL.exec(segment)?.[1];
    return id ? [id] : [];
  });
}

function isUnrouted(entry: Unrouted, step: { source: string; name: string }): boolean {
  return entry.workflow === step.source && entry.step === step.name;
}

// 3. No bypass — asserted as a CONSTRUCTION rule, not by analysing what a command does.
//
//    Every `run:` block in a qualifying lane must be either a `pnpm gate <id>`
//    invocation or an inventoried exception. Nothing inspects the command's content.
//
//    Three review rounds established why. Content analysis was defeated by `pnpm exec`,
//    then by `pnpm exec --` and `npx --yes`, then by
//    `node -e 'import("./scripts/layering/check.ts")'`. Each fix bought exactly the next
//    spelling, because "does this text run project code?" is not decidable from text:
//    `-e`, `eval`, a heredoc and base64 are all available. So the question is no longer
//    asked. A step is allowed because of its SHAPE, and anything else is listed by a
//    human — which is the only boundary an unknown spelling cannot walk through.
function bypass(model: Model, declared: readonly Unrouted[]): Failure[] {
  // Keyed on the DECLARING file, so a composite action shared by eight lanes is
  // inventoried once rather than once per caller.
  const seen = new Map<string, { source: string; name: string; run: string }>();
  for (const lane of model.lanes.filter((entry) => entry.qualifying)) {
    for (const step of lane.steps) {
      if (step.run !== undefined) {
        seen.set(`${step.source}\u0000${step.name}`, {
          source: step.source,
          name: step.name,
          run: step.run,
        });
      }
    }
  }
  return [...seen.values()].flatMap((step) => {
    if (isGateStep(step.run)) {
      return gateIds(step.run)
        .filter((id) => !REGISTERED.has(id))
        .map((id) =>
          fail(
            'bypass',
            `${step.source} / ${step.name}: \`pnpm gate ${id}\` names no registered check.`,
          ),
        );
    }
    if (declared.some((entry) => isUnrouted(entry, step))) return [];
    return [
      fail(
        'bypass',
        `${step.source} / ${step.name}: a \`run:\` step reached by a qualifying lane must be ` +
          `\`pnpm gate <id>\` or listed in NON_GATE_STEPS.`,
      ),
    ];
  });
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
  const matches = new Set(
    qualifying
      .flatMap((lane) => lane.steps)
      .filter(
        (step) =>
          step.run !== undefined && step.source === entry.workflow && step.name === entry.step,
      )
      .map((step) => step.run),
  );
  if (matches.size === 1) return [];
  const detail =
    matches.size === 0
      ? 'matches no `run:` step a qualifying lane reaches; remove it'
      : `matches ${matches.size} distinct steps`;
  return [fail('inert', `NON_GATE_STEPS ${entry.workflow} / "${entry.step}" ${detail}.`)];
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
    ...pathCoverage(model),
    ...inert(model, declared),
    ...unregisteredSuites(model),
    ...orphanProjects(model),
  ];
}
