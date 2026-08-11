// Every guarantee the gate manifest makes, as assertions over the model.
//
// All of them are phrased against one primitive — `covered(check, path)` from
// model.ts — so there is no per-guarantee machinery to keep honest. What used to
// be six subsystems (shell-command parsing, terminal resolution, catalog wiring,
// path categories, selector-rule extraction, waiver provenance) is the eight
// functions below, because CI can only reach a gate through `pnpm gate <id>`.

import { CHECK_CATALOG, type CheckSpec } from '../check-affected/checks.ts';
import { selectChecks } from '../check-affected/model.ts';
import { PATH_SAMPLES, UNROUTED, type Unrouted } from './declarations.ts';
import {
  commandSegments,
  commandUnits,
  covered,
  invokedScript,
  scriptUnits,
  triggersOnPath,
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

/**
 * Commands that run this project's own code, as opposed to shell, SDK and CLI
 * setup. Deliberately narrow: `cp scripts/size-report.mjs …` and
 * `git diff -- scripts/…` name a path under scripts/ without executing anything.
 */
function projectCommands(lane: Lane, model: Model): { step: string; command: string }[] {
  const found: { step: string; command: string }[] = [];
  for (const step of lane.steps) {
    for (const command of step.commands) {
      for (const segment of commandSegments(command)) {
        // A recorder that cannot fail the lane gates nothing.
        if (/\|\|\s*true\s*$/.test(segment)) continue;
        // Repeating a script's body verbatim is credited by the model, not bypassed.
        if (
          lane.verbatim.some(
            (name) => model.scripts[name]?.replace(/\s+/g, ' ') === segment.replace(/\s+/g, ' '),
          )
        ) {
          continue;
        }
        const [executable = ''] = segment.split(/\s+/);
        const runsProjectFile =
          /^(?:node|sh|bash)$/.test(executable) &&
          /(?:^|\s)\.?\/?(?:scripts\/\S+|src\/bin\.ts)/.test(segment);
        const isProject =
          isGateInvocation(segment) ||
          invokedScript(segment, model.scripts) !== null ||
          runsProjectFile;
        if (isProject) found.push({ step: step.name, command: segment });
      }
    }
  }
  return found;
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
function bypass(model: Model, declared: readonly Unrouted[]): Failure[] {
  const owned = new Set(CHECK_CATALOG.flatMap((spec) => unitsOf(spec, model)));
  const failures: Failure[] = [];
  for (const lane of model.lanes) {
    if (!lane.qualifying) continue;
    for (const { step, command } of projectCommands(lane, model)) {
      if (isGateInvocation(command)) {
        const id = /gate\s+([a-z0-9:-]+)/.exec(command)?.[1] ?? '';
        if (!REGISTERED.has(id)) {
          failures.push(
            fail(
              'bypass',
              `${lane.workflow} / ${step}: \`pnpm gate ${id}\` names no registered check.`,
            ),
          );
        }
        continue;
      }
      // Re-running a suite a check already owns (a device lane replaying an owned
      // integration file under a live emulator) hides nothing.
      const units = commandUnits(command, model);
      if (
        units.length > 0 &&
        units.every((unit) => [...owned].some((have) => unitCovers(have, unit)))
      )
        continue;
      const script = invokedScript(command, model.scripts);
      if (declared.some((entry) => isUnrouted(entry, lane, step, script))) continue;
      const hint = script
        ? `Run it as \`pnpm gate <id>\` (script "${script}" must belong to a registered check)`
        : 'Register the gate it runs, or declare the step in UNROUTED';
      failures.push(
        fail(
          'bypass',
          `${lane.workflow} / ${step}: project code outside the runner — \`${command}\`. ${hint}.`,
        ),
      );
    }
  }
  return failures;
}

// 4. Per-path coverage (#1420's class): every check a real selector run activates
//    for a sample path must be run by a lane that a PR touching only that path
//    actually starts. G2 can stay green while this fails — that is the point.
function pathCoverage(model: Model): Failure[] {
  const failures: Failure[] = [];
  for (const sample of PATH_SAMPLES) {
    const plan = selectChecks({
      changedFiles: [sample.path],
      ...(sample.packageEntryFiles ? { packageEntryFiles: sample.packageEntryFiles } : {}),
    });
    // A fail-open sample would demand every check reach every path, which is not
    // the claim; `samples` below asserts each one still classifies.
    if (plan.failOpen) continue;
    for (const id of plan.checks) {
      const spec = CHECK_CATALOG.find((entry) => entry.id === id);
      if (!spec) continue;
      const result = covered(spec, sample.path, model);
      if (result.covered) continue;
      failures.push(
        fail(
          'path-coverage',
          `a PR touching only ${sample.path} (${sample.label}) selects "${id}", but no lane ` +
            `that the change starts runs ${result.missing.join(', ')}.`,
        ),
      );
    }
  }
  return failures;
}

// 5. Samples are real files. A fictional path resolves by prefix and reads green
//    while asserting about a change no PR can make.
function samples(model: Model): Failure[] {
  return PATH_SAMPLES.flatMap((sample) => {
    if (!model.trackedFiles.has(sample.path)) {
      return [
        fail('samples', `sample path ${sample.path} (${sample.label}) is not tracked in git.`),
      ];
    }
    const plan = selectChecks({
      changedFiles: [sample.path],
      ...(sample.packageEntryFiles ? { packageEntryFiles: sample.packageEntryFiles } : {}),
    });
    if (plan.failOpen) {
      return [
        fail(
          'samples',
          `sample path ${sample.path} (${sample.label}) now fails open; pick a classifying path.`,
        ),
      ];
    }
    return [];
  });
}

// 6. No inert declaration. Every entry must still describe something the tree does,
//    and an opaque-runner declaration must still change the audit — so deleting the
//    step a declaration covers is loud rather than silent.
function inert(model: Model, declared: readonly Unrouted[]): Failure[] {
  const failures: Failure[] = [];
  const qualifying = model.lanes.filter((lane) => lane.qualifying);
  for (const entry of declared) {
    if (entry.kind === 'step') {
      const matches = qualifying
        .filter((lane) => lane.workflow === entry.workflow)
        .flatMap((lane) => lane.steps.filter((step) => step.name === entry.step));
      if (matches.length === 0) {
        failures.push(
          fail(
            'inert',
            `UNROUTED step ${entry.workflow} / "${entry.step}" matches no step; remove it.`,
          ),
        );
      }
      if (matches.length > 1) {
        failures.push(
          fail(
            'inert',
            `UNROUTED step ${entry.workflow} / "${entry.step}" matches ${matches.length} steps.`,
          ),
        );
      }
      continue;
    }
    const used = qualifying
      .filter((lane) => entry.workflow === undefined || lane.workflow === entry.workflow)
      .flatMap((lane) => projectCommands(lane, model))
      .some(({ command }) => invokedScript(command, model.scripts) === entry.script);
    if (!used) {
      failures.push(
        fail(
          'inert',
          `UNROUTED script "${entry.script}" is run by no qualifying lane outside the runner; remove it.`,
        ),
      );
    }
  }
  for (const script of Object.keys(model.opaque)) {
    if (!(script in model.scripts)) {
      failures.push(
        fail('inert', `opaque-runner declaration "${script}" is not a package.json script.`),
      );
      continue;
    }
    const without = { ...model.opaque };
    delete without[script];
    const reduced = { ...model, opaque: without };
    if (summarize(unowned(reduced)) === summarize(unowned(model))) {
      failures.push(
        fail(
          'inert',
          `opaque-runner declaration "${script}" changes nothing; the units it names are covered anyway.`,
        ),
      );
    }
  }
  return failures;
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
      unitsOf(spec, model),
    ),
  );
}

// 7. Every suite belongs to a check. A script that runs a Vitest project or a
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

function unitsOf(spec: CheckSpec, model: Model): string[] {
  return spec.kind.type === 'vitest-related'
    ? model.vitestProjects.map((name) => `vitest:${name}`)
    : scriptUnits(spec.kind.script, model);
}

// 8. Every Vitest project is somebody's suite. A project added to the config with
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
    ...samples(model),
    ...inert(model, declared),
    ...unregisteredSuites(model),
    ...orphanProjects(model),
  ];
}

export { triggersOnPath };
