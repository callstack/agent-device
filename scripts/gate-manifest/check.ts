// `pnpm check:gate-manifest` — runs the derived gate manifest (#1429) against the real tree.
//
// Deterministic and offline by construction: every input is a file in the checkout (workflows,
// local actions, package.json, vitest.config.ts, the affected selector's own source, and
// `git ls-files`). Nothing here calls the GitHub API. Branch-protection required-contexts drift
// is a separate, online, scheduled concern and must never become a dependency of this PR gate —
// a gate that needs a token is a gate that goes green when the token expires.
//
// Failures name both sides and the fix. That is the whole product: the message has to be enough
// for an agent to act on without reading this file.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHECK_CATALOG } from '../check-affected/checks.ts';
import { selectChecks } from '../check-affected/model.ts';
import { deriveCategories } from './path-category-samples.ts';
import {
  missingCatalogJobs,
  unreachableCatalogClaims,
  type CatalogEntry,
} from './catalog-wiring.ts';
import type { ResolveContext, Terminal, UnresolvedEdge } from './execution-terminals.ts';
import { pathFilterMatches, triggersOnPath } from './path-filters.ts';
import {
  unreachablePathCategories,
  unrepresentedRules,
  type PathCategory,
} from './path-categories.ts';
import { readSelectorRules } from './selector-rules.ts';
import { suiteUniverse, unownedTerminals } from './suite-ownership.ts';
import { buildLanes, parseWorkflow, type WorkflowFile } from './workflow-lanes.ts';
import {
  CATALOG_CLAIM_WAIVERS,
  DECLARED_EDGES,
  DOCS_LANE_OWNERS,
  FORWARDED_SELECTOR_RULES,
  GATE_RUNNERS,
  LOCAL_ONLY,
  TRANSPARENT_WRAPPERS,
  type DocsLaneOwner,
} from './waivers.ts';
import { vitestProjectNames } from './vitest-projects.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function read(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}

function listFiles(...pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', ...pathspecs], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

// --- Sources ----------------------------------------------------------------

const SELECTOR_SOURCE = 'scripts/check-affected/model.ts';

const workflows: WorkflowFile[] = listFiles('.github/workflows/*.yml', '.github/workflows/*.yaml')
  .map((file) => parseWorkflow(file, read(file)))
  .sort((left, right) => left.file.localeCompare(right.file));

const actions = new Map(
  listFiles('.github/actions/*/action.yml', '.github/actions/*/action.yaml').map((file) => [
    path.posix.dirname(file),
    read(file),
  ]),
);

const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const packageScripts = new Map(Object.entries(packageJson.scripts ?? {}));
const vitestProjects = vitestProjectNames('vitest.config.ts', read('vitest.config.ts'));
const selector = readSelectorRules(
  SELECTOR_SOURCE,
  read(SELECTOR_SOURCE),
  FORWARDED_SELECTOR_RULES,
);
const selectorRules = selector.rules;

const trackedFiles = listFiles();
const trackedSet = new Set(trackedFiles);

function expandTestPaths(pattern: string): readonly string[] {
  if (trackedSet.has(pattern)) return [pattern];
  const matches = trackedFiles.filter((file) => pathFilterMatches(pattern, file));
  // An unmatched pattern stays visible as its own terminal: a test glob that matches nothing
  // must surface as unowned work, not vanish into an empty set and read as covered.
  return matches.length > 0 ? matches : [pattern];
}

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    packageScripts,
    actions,
    vitestProjects,
    expandTestPaths,
    transparentWrappers: new Set(TRANSPARENT_WRAPPERS.map((entry) => entry.file)),
    declaredTerminals: new Map(DECLARED_EDGES.map((entry) => [entry.file, entry.reaches])),
    gateRunners: new Set(GATE_RUNNERS.map((entry) => entry.file)),
    ...overrides,
  };
}

const ctx = context();
const lanes = buildLanes(workflows, ctx);
const suites = suiteUniverse(ctx);

/** Every terminal the whole model resolves to, for differencing a waiver against its absence. */
function resolvedTerminals(candidate: ResolveContext): Set<Terminal> {
  return new Set([
    ...buildLanes(workflows, candidate).flatMap((lane) => [...lane.terminals]),
    ...suiteUniverse(candidate).flatMap((suite) => [...suite.terminals]),
  ]);
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((member) => right.has(member));
}

const baselineTerminals = resolvedTerminals(ctx);

/** The universe under `candidate`, for differencing a declaration against its absence. */
function suiteIds(candidate: ResolveContext): Set<string> {
  return new Set(suiteUniverse(candidate).map((suite) => suite.id));
}

/**
 * How much the gate would report under `candidate`. The two waiver kinds are effective in
 * different ways, so they need different differentials: a TRANSPARENT_WRAPPERS entry changes
 * what a command RESOLVES to (the terminal set moves), while a DECLARED_EDGES entry changes
 * what is OWNED — remove it and the suites behind the opaque runner go unowned, even though
 * the terminal set is unchanged because the suites still name them.
 */
function reportedProblems(candidate: ResolveContext, waived: ReadonlySet<Terminal>): number {
  const candidateLanes = buildLanes(workflows, candidate);
  const candidateSuites = suiteUniverse(candidate);
  return (
    unownedTerminals(candidateSuites, candidateLanes, waived).length +
    candidateLanes.reduce((total, lane) => total + lane.unresolved.length, 0) +
    candidateSuites.reduce((total, suite) => total + suite.unresolved.length, 0)
  );
}

// --- Assertions -------------------------------------------------------------

const failures: string[] = [];

function fail(title: string, lines: readonly string[], fix: string): void {
  failures.push([`✖ ${title}`, ...lines.map((line) => `    ${line}`), `  fix: ${fix}`].join('\n'));
}

// 1. Every execution edge resolves, or is waived.
const unresolved: UnresolvedEdge[] = [
  ...lanes.flatMap((lane) => [...lane.unresolved]),
  ...suites.flatMap((suite) => [...suite.unresolved]),
];
if (unresolved.length > 0) {
  fail(
    `${unresolved.length} execution edge(s) could not be resolved`,
    unresolved.map((edge) => `${edge.source} [${edge.step}] ${edge.kind}: ${edge.detail}`),
    'repair the edge, or classify it in scripts/gate-manifest/waivers.ts with a reason and a ' +
      'tracking issue (DECLARED_EDGES for an opaque runner, TRANSPARENT_WRAPPERS for an argv ' +
      'forwarder)',
  );
}

// 2. Every suite's work is reachable from some lane, or waived local-only.
const waivedTerminals = new Set(LOCAL_ONLY.map((entry) => entry.terminal));
const unowned = unownedTerminals(suites, lanes, waivedTerminals);
if (unowned.length > 0) {
  fail(
    `${unowned.length} unit(s) of work are not reachable from any workflow job`,
    unowned.map((entry) => `${entry.terminal}  (needed by ${entry.suites.join(', ')})`),
    'wire it into a workflow job, or declare it in LOCAL_ONLY in ' +
      'scripts/gate-manifest/waivers.ts with a reason and a tracking issue',
  );
}

// 3. Every waiver still earns its place. A stale waiver is a hole with a comment on it, and an
//    INERT one is worse: it reads as a considered exception while changing nothing, so the day
//    the edge it describes comes back nobody is told. Existence is not enough — each waiver is
//    re-resolved with itself removed and must actually change the outcome.
const laneTerminals = new Set(lanes.flatMap((lane) => [...lane.terminals]));
const suiteTerminals = new Set(suites.flatMap((suite) => [...suite.terminals]));
const baselineProblems = reportedProblems(ctx, waivedTerminals);
const staleWaivers = [
  ...LOCAL_ONLY.filter((entry) => !suiteTerminals.has(entry.terminal)).map(
    (entry) => `LOCAL_ONLY "${entry.terminal}" matches no suite terminal`,
  ),
  ...LOCAL_ONLY.filter((entry) => laneTerminals.has(entry.terminal)).map(
    (entry) => `LOCAL_ONLY "${entry.terminal}" now runs in CI — drop the waiver`,
  ),
  ...TRANSPARENT_WRAPPERS.filter((entry) => !trackedSet.has(entry.file)).map(
    (entry) => `TRANSPARENT_WRAPPERS "${entry.file}" does not exist`,
  ),
  ...DECLARED_EDGES.filter((entry) => !trackedSet.has(entry.file)).map(
    (entry) => `DECLARED_EDGES "${entry.file}" does not exist`,
  ),
  ...GATE_RUNNERS.filter((entry) => !trackedSet.has(entry.file)).map(
    (entry) => `GATE_RUNNERS "${entry.file}" does not exist`,
  ),
  // A gate runner earns its place by putting a suite in the universe that would not be there
  // without it. Matching nothing means the script that ran it was renamed or deleted — and this
  // list is the only thing holding those suites in, so an entry that has quietly stopped
  // applying takes the gate with it.
  //
  // Each entry is weighed ALONE against the undeclared universe rather than by removing it from
  // the list: two entries reached by one script would otherwise each look redundant because of
  // the other, and both would be reported inert while both were load-bearing.
  ...GATE_RUNNERS.filter((entry) =>
    sameSet(
      suiteIds(context({ gateRunners: new Set() })),
      suiteIds(context({ gateRunners: new Set([entry.file]) })),
    ),
  ).map(
    (entry) =>
      `GATE_RUNNERS "${entry.file}" changes nothing — no package script outside the ` +
      `test:/check: convention runs it, so the declaration is inert`,
  ),
  ...DECLARED_EDGES.flatMap((entry) =>
    entry.reaches
      .filter((terminal) => terminal.startsWith('vitest:'))
      .filter((terminal) => !vitestProjects.includes(terminal.slice('vitest:'.length)))
      .map((terminal) => `DECLARED_EDGES "${entry.file}" claims unknown project "${terminal}"`),
  ),
  // Applied-reachability: drop the waiver and the resolved terminal set must move.
  ...TRANSPARENT_WRAPPERS.filter((entry) =>
    sameSet(
      baselineTerminals,
      resolvedTerminals(
        context({
          transparentWrappers: new Set(
            TRANSPARENT_WRAPPERS.filter((other) => other.file !== entry.file).map(
              (other) => other.file,
            ),
          ),
        }),
      ),
    ),
  ).map(
    (entry) =>
      `TRANSPARENT_WRAPPERS "${entry.file}" changes nothing — no resolved command forwards ` +
      `through it, so the waiver is inert`,
  ),
  // A forwarded-rule waiver is applied-reachable when the statement it fingerprints is really
  // there — and only once. Matching none means the statement changed or moved, so the reviewed
  // claim no longer describes live code; matching several means one claim now stands for code
  // nobody looked at. Either way the waiver has stopped meaning what it said.
  ...FORWARDED_SELECTOR_RULES.map((entry, index) => ({
    entry,
    matches: selector.waiverMatches[index] ?? 0,
  }))
    .filter(({ matches }) => matches !== 1)
    .map(({ entry, matches }) =>
      matches === 0
        ? `FORWARDED_SELECTOR_RULES ${entry.file}#${entry.enclosing} matches no forwarding ` +
          `statement — the statement it waives changed, moved, or is gone, so the waiver is ` +
          `inert. It fingerprints: ${entry.statement}`
        : `FORWARDED_SELECTOR_RULES ${entry.file}#${entry.enclosing} matches ${matches} ` +
          `statements — one waiver cannot stand for several forwards; review each and give it ` +
          `its own entry, or write the rules as literals`,
    ),
  ...DECLARED_EDGES.filter(
    (entry) =>
      reportedProblems(
        context({
          declaredTerminals: new Map(
            DECLARED_EDGES.filter((other) => other.file !== entry.file).map((other) => [
              other.file,
              other.reaches,
            ]),
          ),
        }),
        waivedTerminals,
      ) <= baselineProblems,
  ).map(
    (entry) =>
      `DECLARED_EDGES "${entry.file}" changes nothing — every suite behind it is owned without ` +
      `the declaration, so the waiver is inert`,
  ),
];
if (staleWaivers.length > 0) {
  fail(
    `${staleWaivers.length} waiver(s) no longer apply`,
    staleWaivers,
    'remove the stale entry from scripts/gate-manifest/waivers.ts',
  );
}

// 4. CHECK_CATALOG.ciJobs must name jobs that exist.
const catalog: CatalogEntry[] = CHECK_CATALOG.map((entry) => ({
  id: entry.id,
  script: entry.kind.type === 'script' ? entry.kind.script : null,
  ciJobs: entry.ciJobs,
}));
const missingJobs = missingCatalogJobs(catalog, lanes);
if (missingJobs.length > 0) {
  // Naming both sides is the point, but "both sides" means the claim and the plausible real
  // names — dumping all ~75 job names buries the answer the reader came for.
  const suggest = (job: string, known: readonly string[]): string => {
    const words = job
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter((word) => word.length > 2);
    const close = known.filter((candidate) =>
      words.some((word) => candidate.toLowerCase().includes(word)),
    );
    return (close.length > 0 ? close : known).slice(0, 5).join(', ');
  };
  fail(
    `${missingJobs.length} CHECK_CATALOG entry/entries name a CI job that no workflow defines`,
    missingJobs.map(
      (miss) =>
        `check "${miss.check}" claims job "${miss.job}", which does not exist ` +
        `(did you mean: ${suggest(miss.job, miss.known)}?)`,
    ),
    'update ciJobs in scripts/check-affected/checks.ts to the current job name, or restore the job',
  );
}

// 5. And those jobs must really run the catalog's script, edge by edge.
const claimWaivers = new Set(CATALOG_CLAIM_WAIVERS.map((entry) => entry.terminal));
const unwaivedClaimIds = new Set(
  unreachableCatalogClaims(catalog, lanes, ctx, new Set()).map((miss) => miss.check),
);
const staleClaimWaivers = CATALOG_CLAIM_WAIVERS.filter(
  (entry) => !unwaivedClaimIds.has(entry.terminal),
).map(
  (entry) =>
    `CATALOG_CLAIM_WAIVERS "${entry.terminal}" is no longer needed` +
    (CHECK_CATALOG.some((candidate) => candidate.id === entry.terminal)
      ? ' — the claim now resolves on its own'
      : ' — no catalog entry has that id'),
);
if (staleClaimWaivers.length > 0) {
  fail(
    `${staleClaimWaivers.length} catalog-claim waiver(s) no longer apply`,
    staleClaimWaivers,
    'remove the stale entry from CATALOG_CLAIM_WAIVERS in scripts/gate-manifest/waivers.ts',
  );
}
const unreachableClaims = unreachableCatalogClaims(catalog, lanes, ctx, claimWaivers);
if (unreachableClaims.length > 0) {
  fail(
    `${unreachableClaims.length} CHECK_CATALOG claim(s) are not reachable from the jobs named`,
    unreachableClaims.map(
      (miss) =>
        `check "${miss.check}" claims [${miss.jobs.join(', ')}] mirror it, but together those ` +
        `jobs never reach: ${miss.missing.join(', ')}`,
    ),
    'run the missing work from one of those jobs (directly or through an intermediate script), ' +
      'correct ciJobs, or add the check id to CATALOG_CLAIM_WAIVERS with a reason',
  );
}

// 6. A category's owning job must actually fire on a PR touching only that category.
//
//    The category universe is derived from the selector's own ownership rules
//    (selector-rules.ts), so it cannot fall behind the selector. These samples only supply a
//    representative PATH per category; assertion 6a fails when the selector grows a rule no
//    sample exercises, which is what stops this from degrading into a hand-picked list.
const categories: PathCategory[] = deriveCategories(selectChecks);

// 6a. The samples must cover the whole derived category universe.
const unrepresented = unrepresentedRules(selectorRules, categories);
if (unrepresented.length > 0) {
  fail(
    `${unrepresented.length} affected-selector category/categories have no representative path`,
    unrepresented.map(
      (rule) => `"${rule}" is a live selector rule that no PATH_CATEGORY_SAMPLES entry exercises`,
    ),
    `add a sample path that the selector routes through that rule to PATH_CATEGORY_SAMPLES in ` +
      `scripts/gate-manifest/check.ts, so its owning jobs' triggers are checked too`,
  );
}
const failOpenSamples = categories.filter((category) => category.checks.length === 0);
if (failOpenSamples.length > 0) {
  fail(
    `${failOpenSamples.length} path-category sample(s) no longer classify`,
    failOpenSamples.map(
      (category) => `"${category.path}" (${category.label}) now fails open in the selector`,
    ),
    'pick a representative path for the category that the affected-selector still routes, in ' +
      'PATH_CATEGORY_SAMPLES in scripts/gate-manifest/check.ts',
  );
}
// 6b. A sample must be a real tracked file. The selector classifies by prefix, so a made-up path
//     still resolves and the gate still reads green — while asserting "a PR touching only this
//     path fires that job" about a path no PR can ever touch. Worse, a fictional path can sit on
//     the wrong side of a `paths:` filter that every real member of its category is inside, so
//     the reachability below would be checking a case that does not occur.
const untrackedSamples = categories.filter((category) => !trackedSet.has(category.path));
if (untrackedSamples.length > 0) {
  fail(
    `${untrackedSamples.length} path-category sample(s) name a file that does not exist`,
    untrackedSamples.map(
      (category) => `"${category.path}" (${category.label}) is not a tracked file`,
    ),
    'point the sample at a real tracked file in that category, in PATH_CATEGORY_SAMPLES in ' +
      'scripts/gate-manifest/path-category-samples.ts',
  );
}

const pathMisses = unreachablePathCategories(categories, catalog, workflows, lanes, new Set());
if (pathMisses.length > 0) {
  fail(
    `${pathMisses.length} path category/categories are excluded from their own gate`,
    pathMisses.map(
      (miss) =>
        `${miss.category} ("${miss.path}") routes to check "${miss.check}", whose job ` +
        `"${miss.job}" lives in ${miss.workflow} and does not trigger on that path`,
    ),
    "widen the owning workflow's pull_request paths/paths-ignore filters, or move the check to " +
      'a lane that fires on those paths',
  );
}

// 7. Docs paths ci.yml drops must have a declared owner that really fires on them.

/** How many units of work the lane a docs-lane owner names actually resolves to. */
function declaredOwnerGateCount(owner: DocsLaneOwner): number {
  const lane = lanes.find(
    (candidate) => candidate.workflow === owner.workflow && candidate.job === owner.job,
  );
  return lane?.terminals.size ?? 0;
}

/**
 * Everything a declared docs-lane owner has to keep being true. Enumerated rather than nested
 * so the claim "pr-preview.yml's command-docs-gate covers website/**" is checked in the three
 * independent ways it can quietly stop holding: the job goes away, the trigger stops matching
 * the path, or the job stops running anything at all.
 */
const DOCS_OWNER_CONDITIONS: readonly {
  broken: (owner: DocsLaneOwner, workflow: WorkflowFile) => boolean;
  problem: (owner: DocsLaneOwner) => string;
}[] = [
  {
    broken: (owner, workflow) => !workflow.jobs.some((candidate) => candidate.id === owner.job),
    problem: (owner) => `defines no job "${owner.job}"`,
  },
  {
    broken: (owner, workflow) => !triggersOnPath(workflow.triggers, owner.path),
    problem: (owner) => `no longer triggers on "${owner.path}"`,
  },
  {
    broken: (owner) => declaredOwnerGateCount(owner) === 0,
    problem: (owner) => `runs no resolvable gate for "${owner.path}"`,
  },
];

function docsOwnerFailure(owner: DocsLaneOwner): string | null {
  const workflow = workflows.find((candidate) => candidate.file === owner.workflow);
  if (!workflow) return `${owner.workflow} does not exist (declared owner of "${owner.path}")`;
  const broken = DOCS_OWNER_CONDITIONS.find((condition) => condition.broken(owner, workflow));
  return broken ? `${owner.workflow}#${owner.job} ${broken.problem(owner)}` : null;
}

const docsFailures = DOCS_LANE_OWNERS.map(docsOwnerFailure).filter(
  (failure): failure is string => failure !== null,
);
if (docsFailures.length > 0) {
  fail(
    `${docsFailures.length} declared docs-lane owner(s) no longer hold`,
    docsFailures,
    'restore the owning job/trigger, or update DOCS_LANE_OWNERS in ' +
      'scripts/gate-manifest/waivers.ts',
  );
}

// --- Report -----------------------------------------------------------------

if (failures.length > 0) {
  console.error(`Gate manifest (#1429) failed.\n\n${failures.join('\n\n')}\n`);
  process.exit(1);
}

const prLanes = lanes.filter((lane) => lane.kind === 'pull-request').length;
console.log(
  `Gate manifest OK: ${suites.length} suites (${vitestProjects.length} Vitest projects) owned ` +
    `across ${lanes.length} jobs in ${workflows.length} workflows (${prLanes} PR-triggered); ` +
    `${CHECK_CATALOG.length} catalog entries wired to live jobs; ` +
    `${selectorRules.length} selector categories represented and reachable; ` +
    `${
      LOCAL_ONLY.length +
      DECLARED_EDGES.length +
      GATE_RUNNERS.length +
      TRANSPARENT_WRAPPERS.length +
      FORWARDED_SELECTOR_RULES.length
    } owned waivers.`,
);
