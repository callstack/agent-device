// Structural owners, path reachability, and suite registration over the derived model.

import { CHECK_CATALOG } from '../check-affected/checks.ts';
import type { CheckId } from '../check-affected/model.ts';
import {
  MANUAL_ONLY_OWNERS,
  type ManualOnlyOwner,
  REPORTING_SCRIPTS,
  UNPROVABLE_OWNERS,
} from './declarations.ts';
import { categories, checkUnits, covered, scriptUnits, type Model } from './model.ts';

export type Failure = { readonly assertion: string; readonly message: string };

/** The hand-written half of the manifest, injectable so its own removal can be tested. */
export type GateDeclarations = {
  readonly manualOnly: Readonly<Record<string, ManualOnlyOwner>>;
  readonly unprovable: Readonly<Record<string, string>>;
};

const DECLARED: GateDeclarations = {
  manualOnly: MANUAL_ONLY_OWNERS,
  unprovable: UNPROVABLE_OWNERS,
};

const HEADINGS: Readonly<Record<string, string>> = {
  owned: 'Registered checks no lane declares',
  'manual-only': 'Manual-only declarations no dispatch lane backs',
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

// Every registered check is declared by some qualifying lane, unit by unit. The two declared
// exemptions differ in kind: UNPROVABLE_OWNERS says "it runs, this loader cannot see it",
// MANUAL_ONLY_OWNERS says "nothing runs it automatically" — and check.ts reports the latter by
// name so the gap is read as a gap.
function unowned(model: Model, declarations: GateDeclarations): Failure[] {
  const exempt = { ...declarations.unprovable, ...declarations.manualOnly };
  return CHECK_CATALOG.flatMap((spec) => {
    const result = covered(spec, null, model);
    if (result.covered || spec.id in exempt) return [];
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

/**
 * `workflow_dispatch` and nothing else. Read from the trigger names rather than from
 * `qualifying`, which only says "not pull_request/schedule": `push`, `release` and friends are
 * non-qualifying too, and every one of them starts the run without a human.
 */
function dispatchOnly(lane: Model['lanes'][number]): boolean {
  return (
    lane.triggers.length > 0 && lane.triggers.every((trigger) => trigger === 'workflow_dispatch')
  );
}

function describeTriggers(lane: Model['lanes'][number]): string {
  return lane.triggers.length > 0 ? lane.triggers.join(', ') : 'no trigger at all';
}

// A manual-only declaration is an attestation about a lane, so the lane has to back it: the
// job still exists, still runs on dispatch and nothing else, and (unless its gate lives inside
// a surface the loader cannot open) still declares the gate. Without this, deleting the parked
// job — or quietly re-triggering it — would leave the manifest green and still printing the
// check as manual-only: parked coverage silently turned into deleted or unattested coverage.
function manualOnly(model: Model, declared: Readonly<Record<string, ManualOnlyOwner>>): Failure[] {
  return Object.entries(declared).flatMap(([id, owner]) => {
    if (!REGISTERED.has(id)) {
      return [fail('manual-only', `"${id}" names no registered check. Drop the declaration.`)];
    }
    const lane = model.lanes.find((candidate) => candidate.label === owner.lane);
    if (!lane) {
      return [
        fail(
          'manual-only',
          `"${id}" is declared manual-only on lane "${owner.lane}", which no workflow defines. ` +
            `Nothing runs this check at all — restore the job, or drop the check.`,
        ),
      ];
    }
    if (lane.qualifying) {
      return [
        fail(
          'manual-only',
          `"${id}" is declared manual-only, but "${owner.lane}" runs on pull_request/schedule ` +
            `again. Delete the MANUAL_ONLY_OWNERS entry so the check counts as wired.`,
        ),
      ];
    }
    if (!dispatchOnly(lane)) {
      return [
        fail(
          'manual-only',
          `"${owner.lane}" is triggered by ${describeTriggers(lane)}, so "${id}" is not ` +
            `manual-only — "manual" is a claim about who starts the run, and every trigger ` +
            `other than workflow_dispatch starts it without them. Restore a dispatch-only ` +
            `workflow, or declare what actually runs the check.`,
        ),
      ];
    }
    if (!owner.opaque && !lane.gates.includes(id as CheckId)) {
      return [
        fail(
          'manual-only',
          `"${owner.lane}" no longer declares gate "${id}", so the manual-only declaration ` +
            `attests to a step that is gone. Restore the run-gate step, or drop the check.`,
        ),
      ];
    }
    return [];
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

export function audit(model: Model, declarations: GateDeclarations = DECLARED): Failure[] {
  return [
    ...unowned(model, declarations),
    ...manualOnly(model, declarations.manualOnly),
    ...gateIds(model),
    ...laneSurfaces(model),
    ...pathCoverage(model),
    ...unregisteredSuites(model),
    ...orphanProjects(model),
  ];
}
