// Every guarantee the gate manifest makes, as assertions over the model.
//
// All of them are phrased against one primitive — `covered(check, path)` from model.ts —
// so there is no per-guarantee machinery to keep honest.
//
// The scope is "is this gate still running?", and nothing wider: shell this model does not
// recognise earns no ownership credit, so the failure direction is a check reported unowned,
// never a check waved through.

import { CHECK_CATALOG } from '../check-affected/checks.ts';
import {
  GATE_ACTIONS,
  GATE_CONDITIONS,
  REPORTING_SCRIPTS,
  UNPROVABLE_OWNERS,
} from './declarations.ts';
import { categories, checkUnits, covered, scriptUnits, type Model } from './model.ts';

export type Failure = { readonly assertion: string; readonly message: string };

const HEADINGS: Readonly<Record<string, string>> = {
  owned: 'Registered checks no lane runs',
  gate: 'Gate ids that name no registered check',
  condition: 'Gate steps behind an `if:` nobody has ruled on',
  surface: 'Execution surfaces the manifest does not model',
  'path-coverage': 'Paths whose selected checks no triggered lane runs',
  registered: 'Suites and projects no registered check covers',
  inert: 'Declarations that no longer apply',
};

/**
 * The failures as the command prints them, grouped by assertion so a rewiring round sees
 * the whole picture instead of one error per run.
 *
 * Any assertion without a heading is still printed, under its own name — a new finding must
 * never be silently swallowed by the thing whose job is to surface it.
 */
export function formatFailures(failures: readonly Failure[]): string {
  const named = Object.keys(HEADINGS);
  const unnamed = [...new Set(failures.map((failure) => failure.assertion))]
    .filter((assertion) => !named.includes(assertion))
    .sort();
  const groups: [string, string][] = [
    ...Object.entries(HEADINGS),
    ...unnamed.map((assertion): [string, string] => [assertion, `Other failures (${assertion})`]),
  ];
  const lines = groups.flatMap(([assertion, heading]) => {
    const group = failures.filter((failure) => failure.assertion === assertion);
    if (group.length === 0) return [];
    return ['', `${heading}:`, ...group.map((failure) => `  - ${failure.message}`)];
  });
  return [...lines, '', `gate manifest: ${failures.length} failure(s).`, ''].join('\n');
}

const REGISTERED = new Set(CHECK_CATALOG.map((spec) => spec.id as string));

function fail(assertion: string, message: string): Failure {
  return { assertion, message };
}

// 1. Every registered check is run by some qualifying lane, unit by unit.
//
//    This is the assertion #1429 asked for, and the one that found the defects: on `main`,
//    `check:tmpdir-leaks`, its model tests and `test:fixture-cache` were real package
//    scripts that no workflow ran, reachable only through the `check:unit` aggregate that
//    CI never invokes.
function unowned(
  model: Model,
  unprovable: Readonly<Record<string, string>> = UNPROVABLE_OWNERS,
): Failure[] {
  return CHECK_CATALOG.flatMap((spec) => {
    const result = covered(spec, null, model);
    if (result.covered || spec.id in unprovable) return [];
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

// 2. Every gate id a lane claims must be registered.
//
//    Both spellings land here: an id scanned out of `pnpm gate <id>`, and one supplied to a
//    gate-valued action input (`gate: swift-runner-ios`). An id nobody validates is a typo
//    that silently runs nothing.
function gateIds(model: Model): Failure[] {
  return model.lanes
    .filter((lane) => lane.qualifying)
    .flatMap((lane) =>
      lane.gates
        .filter((id) => !REGISTERED.has(id))
        .map((id) =>
          fail('gate', `${lane.workflow} / ${lane.label}: "${id}" names no registered check.`),
        ),
    );
}

// 3. A conditional gate step must have its condition ruled on.
//
//    Ownership means the gate RUNS, and `if:` decides that. `if: false` on
//    `run: pnpm gate layering` disables a gate with a one-word edit while every lane still
//    looks the same, so credit is decided by a hand-written list and an undeclared
//    condition earns nothing.
//
//    Reported here as well as through the resulting unowned check, because "this condition
//    is not ruled on" names the fix and "check x is unowned" does not.
function gateConditions(model: Model): Failure[] {
  return model.lanes
    .filter((lane) => lane.qualifying)
    .flatMap((lane) =>
      lane.gateSightings.flatMap((sighting) =>
        [...new Set(sighting.conditions)]
          .filter((condition) => !(condition in GATE_CONDITIONS))
          .map((condition) =>
            fail(
              'condition',
              `${lane.workflow} / ${lane.label}: \`pnpm gate ${sighting.id}\` is guarded by ` +
                `\`if: ${condition}\`, which GATE_CONDITIONS does not rule on, so the lane earns ` +
                `no credit for it. Declare the condition with whether it counts as running.`,
            ),
          ),
      ),
    );
}

// 4. A gate-valued action must be PROVEN to run the gate, not trusted to.
//
//    Listing an action in GATE_ACTIONS credits its callers' lanes with whatever id they
//    pass. Without this, the credit rests on the declaration alone: replace the action's
//    body with a no-op and every caller still counts as running its gate.
function gateActionBodies(model: Model, actions: Readonly<Record<string, string>>): Failure[] {
  return Object.entries(actions).flatMap(([source, input]) => {
    const proof = model.gateActionBodies[source];
    const variable = `INPUT_${input.toUpperCase().replace(/-/g, '_')}`;
    if (proof?.run === `pnpm gate "$${variable}"` && proof.boundTo === input) return [];
    return [
      fail(
        'gate',
        `GATE_ACTIONS lists ${source} as running \`${input}\`, but its body does not invoke ` +
          `\`pnpm gate "$${variable}"\` with \`${variable}: \${{ inputs.${input} }}\` — it runs ` +
          `${proof === undefined ? 'no single run step' : `\`${proof.run}\``}. A caller's gate ` +
          `credit would rest on this declaration alone.`,
      ),
    ];
  });
}

// 5. Execution surfaces that would HIDE steps from the loader are rejected rather than
//    ignored. A reusable-workflow job runs steps from a file this loader never opens, so
//    its gates would be invisible and its checks would read as unowned for the wrong
//    reason. Not used today, which is when a fail-closed rule is cheap to add.
function laneSurfaces(model: Model): Failure[] {
  return model.lanes
    .filter((lane) => lane.qualifying)
    .flatMap((lane) =>
      lane.unsupported.map((surface) =>
        fail(
          'surface',
          `${lane.workflow} / ${lane.label}: ${surface} runs steps this loader never opens, ` +
            `so any gate inside it is invisible. Model it before using it.`,
        ),
      ),
    );
}

// 6. Per-path coverage (#1420's class): every check a real selector run activates for a
//    category's path must be run by a lane that a PR touching only that path actually
//    starts. Assertion 1 can stay green while this fails — that is the point.
//
//    The categories are derived (model.ts), so there is no sample list to go stale and no
//    way to assert about a path that does not exist.
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

/** Compared as a set, not a count: removing a declaration can trade one failure for another. */
function summarize(failures: readonly Failure[]): string {
  return [...new Set(failures.map((failure) => failure.message))].sort().join('\n');
}

// 7. No inert declaration. Everything hand-written here has to still be load-bearing, so
//    the file cannot accumulate entries for things that are long gone.
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

function inertReporting(model: Model): Failure[] {
  return Object.keys(REPORTING_SCRIPTS).flatMap((script) => {
    if (!(script in model.scripts)) {
      return [fail('inert', `reporting-script declaration "${script}" is not a package script.`)];
    }
    const covered = attestedUnits(model).has(`script:${script}`);
    return covered
      ? [fail('inert', `reporting-script "${script}" is covered by a check; delete the entry.`)]
      : [];
  });
}

function inertConditions(model: Model): Failure[] {
  const seen = new Set(
    model.lanes
      .filter((lane) => lane.qualifying)
      .flatMap((lane) => lane.gateSightings)
      .flatMap((sighting) => sighting.conditions),
  );
  return [
    ...Object.keys(GATE_CONDITIONS)
      .filter((condition) => !seen.has(condition))
      .map((condition) =>
        fail('inert', `gate-condition declaration \`${condition}\` guards no gate step.`),
      ),
    ...Object.keys(UNPROVABLE_OWNERS)
      .filter((id) => {
        const spec = CHECK_CATALOG.find((entry) => entry.id === id);
        return spec === undefined || covered(spec, null, model).covered;
      })
      .map((id) =>
        fail(
          'inert',
          `unprovable-owner declaration "${id}" is not needed; the check is either unregistered ` +
            `or provably owned. Delete it.`,
        ),
      ),
  ];
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

/**
 * Is this unit a test suite that needs an owner?
 *
 * A Vitest project and a `node --test` file are recognised by shape. A `script:` leaf is
 * anything else the resolver could not decompose, so shape says nothing — but a `test:*`
 * script is a suite by NAME whatever it runs underneath.
 *
 * That last clause is not cosmetic. The five `test:replay:*` scripts run
 * `node src/bin.ts test <dir>`, which resolves to a `script:` leaf, so a shape-only test
 * could not see them: four were owned because someone hand-registered them, and
 * `test:replay:android` was neither registered nor reported while the nightly ran the same
 * six `.ad` files by inlining them. A real suite with no owner and a green manifest is the
 * exact defect this file exists to make impossible.
 */
function isSuite(unit: string, script: string): boolean {
  if (unit.startsWith('vitest:') || unit.startsWith('node-test:')) return true;
  if (script in REPORTING_SCRIPTS) return false;
  return unit === `script:${script}` && script.startsWith('test:');
}

// 8. Every suite belongs to a check. A suite reachable from no registered check is one
//    nobody owns — which is how the defects on `main` stayed invisible.
function unregisteredSuites(model: Model): Failure[] {
  const owned = attestedUnits(model);
  return Object.keys(model.scripts).flatMap((script) => {
    const units = scriptUnits(script, model);
    const suites = units.filter((unit) => isSuite(unit, script));
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

// 9. Every Vitest project is somebody's suite. A project added to the config with
//    no lane running it is dead configuration that reads as coverage.
function orphanProjects(model: Model): Failure[] {
  const owned = attestedUnits(model);
  return model.vitestProjects
    .filter((name) => !owned.has(`vitest:${name}`))
    .map((name) => fail('registered', `Vitest project "${name}" is run by no registered check.`));
}

export function audit(model: Model): Failure[] {
  return [
    ...unowned(model),
    ...gateIds(model),
    ...gateConditions(model),
    ...gateActionBodies(model, GATE_ACTIONS),
    ...laneSurfaces(model),
    ...pathCoverage(model),
    ...unregisteredSuites(model),
    ...orphanProjects(model),
    ...inertOpaque(model),
    ...inertReporting(model),
    ...inertConditions(model),
  ];
}
