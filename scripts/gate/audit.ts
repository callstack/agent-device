// Every guarantee the gate manifest makes, as assertions over the model.
//
// All of them are phrased against one primitive — `covered(check, path)` from
// model.ts — so there is no per-guarantee machinery to keep honest. What used to
// be six subsystems (shell-command parsing, terminal resolution, catalog wiring,
// path categories, selector-rule extraction, waiver provenance) is the handful of
// functions below, because CI can only reach a gate through `pnpm gate <id>`.

import { CHECK_CATALOG } from '../check-affected/checks.ts';
import { loadBaseline, reasonFor, type BaselineEntry } from './baseline.ts';
import {
  ALLOWED_ENV,
  EXTERNAL_ACTIONS,
  GATE_ACTIONS,
  type ExternalAction,
} from './declarations.ts';
import { categories, checkUnits, covered, scriptUnits, type Model } from './model.ts';
import { commandSegments, stripExpressions } from './shell.ts';
import type { Lane } from './workflows.ts';

export type Failure = { readonly assertion: string; readonly message: string };

const HEADINGS: Readonly<Record<string, string>> = {
  owned: 'Registered checks no lane runs',
  bypass: 'Project code run outside `pnpm gate`',
  gate: 'Gate ids that name no registered check',
  env: 'Environment variables that are not on the allowlist',
  external: 'Third-party actions with no declaration',
  surface: 'Execution surfaces the manifest does not model',
  'path-coverage': 'Paths whose selected checks no triggered lane runs',
  inert: 'Declarations that no longer apply',
  registered: 'Suites and projects no registered check covers',
};

/**
 * The failures as the command prints them, grouped by assertion so a rewiring round sees
 * the whole picture instead of one error per run.
 *
 * Lives here, next to the assertions, because the two drift apart otherwise: `external`
 * was added to the audit and not to the reporter, so `pnpm check:gate-manifest` counted an
 * undeclared action and printed none of the guidance for fixing it. Any assertion without
 * a heading is therefore still printed, under its own name — a new finding must never be
 * silently swallowed by the thing whose job is to surface it.
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
 * An inline `VAR=… pnpm gate x` is the same thing spelled in the shell, and is rejected
 * the same way: `commandSegments` keeps the prefix, and the grammar starts at `pnpm`.
 */
export function plainGateStep(step: {
  run: string;
  extras: Readonly<Record<string, string>>;
}): string[] | null {
  if (Object.keys(step.extras).length > 0) return null;
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
//
//    Round 5 found the same hole one level out: a composite action whose step is
//    `run: ${{ inputs.build-command }}` has a CONSTANT digest, so a caller could put
//    anything in the `with:` value and nothing here would move. The answer is not another
//    rule — such a value is a step of the calling lane (workflows.ts `actionInputSteps`),
//    so it arrives here and this rule already decides it. Round 6 extended the same
//    treatment to third-party actions, whose executable inputs are declared rather than
//    read (`externalActions` below).
function bypass(model: Model, declared: readonly BaselineEntry[]): Failure[] {
  const seen = new Map<string, Model['lanes'][number]['steps'][number]>();
  for (const lane of model.lanes.filter((entry) => entry.qualifying)) {
    for (const step of lane.steps) seen.set(`${step.source}\u0000${step.digest}`, step);
  }
  return [...seen.values()].flatMap((step) => {
    if (plainGateStep(step) !== null) return [];
    if (declared.some((entry) => entry.source === step.source && entry.digest === step.digest)) {
      return [];
    }
    const listedName = declared.find(
      (entry) => entry.source === step.source && entry.step === step.name,
    );
    const detail = listedName
      ? `the baseline records digest ${listedName.digest}, but the step is now ${step.digest}`
      : `it is not in the baseline (digest ${step.digest}). \`pnpm check:gate-manifest --update\` ` +
        `records it; the diff is what a reviewer reads. ${reasonFor(step.source)}`;
    return [
      fail(
        'bypass',
        `${step.source} / ${step.name}: shell a qualifying lane reaches must be ` +
          `\`pnpm gate <id>\` with no env/shell/working-directory, or inventoried — ${detail}.`,
      ),
    ];
  });
}

// 3a. Every gate id a lane claims must be registered.
//
//     Both spellings land here: an id scanned out of `pnpm gate <id>`, and one supplied to a
//     gate-valued action input (`gate: swift-runner-ios`). Checking at the lane rather than
//     at the step is what makes the second spelling safe — round 7 turned a command-valued
//     input into an id, and an id nobody validates is a typo that silently runs nothing.
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

// 3a-ii. A gate-valued action must be PROVEN to run the gate, not trusted to.
//
//     Listing an action in GATE_ACTIONS credits its callers' lanes with whatever id they
//     pass. Without this, the credit rests on the declaration alone: replace the action's
//     body with a no-op, regenerate the baseline, and every caller still counts as running
//     its gate. So the body is checked for the one shape that can honour the contract —
//     `pnpm gate "$INPUT_X"`, with `INPUT_X` bound to that input and nothing else run.
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

// 3b. Environment is checked by NAME, not by digest.
//
//     `NODE_OPTIONS=--import ./x.ts` runs code with nothing on the command line, so it has
//     to be rejected — but the previous answer, fingerprinting every inherited environment,
//     made eleven lanes carry a digest waiver for runtime versions and an Xvfb display.
//     Naming the dangerous class is both smaller and stricter: ALLOWED_ENV is an allowlist,
//     so a variable that hijacks an interpreter cannot be introduced without editing it.
function environment(model: Model, allowed: readonly string[]): Failure[] {
  const permitted = (key: string) =>
    allowed.some((entry) => (entry.endsWith('_') ? key.startsWith(entry) : key === entry));
  return model.lanes
    .filter((lane) => lane.qualifying)
    .flatMap((lane) =>
      lane.envKeys
        .filter((key) => !permitted(key))
        .map((key) =>
          fail(
            'env',
            `${lane.workflow} / ${lane.label}: \`${key}\` is not in ALLOWED_ENV. Variables that ` +
              `retarget an interpreter (NODE_OPTIONS, BASH_ENV, PERL5OPT, LD_PRELOAD, PATH) run ` +
              `code no command line names; add it deliberately if it is ordinary configuration.`,
          ),
        ),
    );
}

// 3c. Execution surfaces the model does not read are rejected rather than ignored.
//     `defaults.run` retargets the shell of every step in a lane, and a reusable-workflow
//     job runs steps from a file this loader never opens — either would make the
//     construction rule quietly incomplete. Neither is used today, which is when a
//     fail-closed rule is cheap to add.
function laneSurfaces(model: Model): Failure[] {
  return model.lanes
    .filter((lane) => lane.qualifying)
    .flatMap((lane) =>
      lane.unsupported.map((surface) =>
        fail(
          'surface',
          `${lane.workflow} / ${lane.label}: ${surface} is an execution surface the gate ` +
            `manifest does not model. Model it before using it, or the no-bypass rule is blind.`,
        ),
      ),
    );
}

// 3d. Every third-party action a qualifying lane reaches must be declared, at the pinned
//     ref, with the inputs that version executes.
//
//     Round 6: a local composite action is READ, so a `with:` value it interpolates into a
//     `run:` block arrives at the construction rule as a step. An external action cannot be
//     read, and the model treated it as contributing nothing — so
//     `reactivecircus/android-emulator-runner`'s `script:` input, which is how the Android
//     smoke lanes run their entire suite, was invisible. Declaring per sha is what turns
//     "the model knows nothing about this action" into a finding instead of silence.
//
//     Scoped to qualifying lanes, like every other assertion here: the list is then exactly
//     the third-party surface the no-bypass rule depends on, and every entry is load-bearing.
//     An action only a release lane uses is deliberately absent, and becomes required the
//     moment a workflow that gates the way in starts using it.
function externalActions(model: Model, declared: readonly ExternalAction[]): Failure[] {
  const used = new Map<string, string>();
  for (const lane of model.lanes.filter((entry) => entry.qualifying)) {
    for (const ref of lane.externals) if (!used.has(ref)) used.set(ref, lane.label);
  }
  const undeclared = [...used.keys()]
    .filter((ref) => !declared.some((entry) => entry.uses === ref))
    .sort()
    .map((ref) =>
      fail(
        'external',
        `\`uses: ${ref}\` (reached by ${used.get(ref)}) is not in EXTERNAL_ACTIONS. Read that ` +
          `version's action.yml and declare which inputs it runs as shell — an action whose ` +
          `executable inputs are unknown makes the no-bypass rule blind, as its \`script:\` input.`,
      ),
    );
  const inert = declared
    .filter((entry) => !used.has(entry.uses))
    .map((entry) =>
      fail(
        'inert',
        `EXTERNAL_ACTIONS \`${entry.uses}\` is used by no qualifying lane; the action was ` +
          `removed, its pin was bumped, or only a non-gating lane uses it.`,
      ),
    );
  return [...undeclared, ...inert];
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
function inertStep(entry: BaselineEntry, qualifying: readonly Lane[]): Failure[] {
  const matches = qualifying
    .flatMap((lane) => lane.steps)
    .filter((step) => step.source === entry.source && step.digest === entry.digest);
  if (matches.length > 0) return [];
  return [
    fail(
      'inert',
      `baseline ${entry.source} / "${entry.step}" (digest ${entry.digest}) matches no shell a ` +
        `qualifying lane reaches; the step was edited, renamed away or deleted.`,
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

function inert(model: Model, declared: readonly BaselineEntry[]): Failure[] {
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

export function audit(
  model: Model,
  declared: readonly BaselineEntry[] = loadBaseline(),
  externals: readonly ExternalAction[] = EXTERNAL_ACTIONS,
  allowedEnv: readonly string[] = ALLOWED_ENV,
): Failure[] {
  return [
    ...unowned(model),
    ...bypass(model, declared),
    ...gateIds(model),
    ...gateActionBodies(model, GATE_ACTIONS),
    ...environment(model, allowedEnv),
    ...laneSurfaces(model),
    ...externalActions(model, externals),
    ...pathCoverage(model),
    ...inert(model, declared),
    ...unregisteredSuites(model),
    ...orphanProjects(model),
  ];
}
