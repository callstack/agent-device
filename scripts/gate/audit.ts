// Structural owners, path reachability, and suite registration over the derived model.

import { CHECK_CATALOG } from '../check-affected/checks.ts';
import { REPORTING_SCRIPTS, UNPROVABLE_OWNERS } from './declarations.ts';
import { categories, checkUnits, covered, scriptUnits, type Model } from './model.ts';

export type Failure = { readonly assertion: string; readonly message: string };

const HEADINGS: Readonly<Record<string, string>> = {
  owned: 'Registered checks no lane declares',
  gate: 'Gate ids that name no registered check',
  surface: 'Execution surfaces the manifest does not model',
  'path-coverage': 'Paths whose selected checks no triggered lane runs',
  registered: 'Suites and projects no registered check covers',
};

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

// Every registered check is declared by some qualifying lane, unit by unit.
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
        `check "${spec.id}" is not declared by any pull_request/schedule lane: ${missing}. ` +
          `Add a run-gate action step for \`${spec.id}\`, or drop the check.`,
      ),
    ];
  });
}

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

function attestedUnits(model: Model): Set<string> {
  return new Set(
    CHECK_CATALOG.filter((spec) => spec.kind.type !== 'vitest-related').flatMap((spec) =>
      checkUnits(spec, model),
    ),
  );
}

function isSuite(unit: string, script: string): boolean {
  if (unit.startsWith('vitest:') || unit.startsWith('node-test:')) return true;
  if (script in REPORTING_SCRIPTS) return false;
  return unit === `script:${script}` && script.startsWith('test:');
}

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
    ...laneSurfaces(model),
    ...pathCoverage(model),
    ...unregisteredSuites(model),
    ...orphanProjects(model),
  ];
}
