// `pnpm check:gate-manifest` — runs the derived gate manifest (#1429) against the real tree.
//
// Deterministic and offline by construction: every input is a file in the checkout (workflows,
// local actions, package.json, vitest.config.ts, `git ls-files`). Nothing here calls the GitHub
// API. Branch-protection required-contexts drift is a separate, online, scheduled concern and
// must never become a dependency of this PR gate — a gate that needs a token is a gate that
// goes green when the token expires.
//
// Failures name both sides and the fix. That is the whole product: the message has to be
// enough for an agent to act on without reading this file.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CHECK_CATALOG } from '../check-affected/checks.ts';
import { selectChecks } from '../check-affected/model.ts';
import {
  buildLanes,
  missingCatalogJobs,
  parseWorkflow,
  pathFilterMatches,
  suiteUniverse,
  triggersOnPath,
  unownedTerminals,
  unreachableCatalogClaims,
  unreachablePathCategories,
  type CatalogEntry,
  type PathCategory,
  type ResolveContext,
  type UnresolvedEdge,
  type WorkflowFile,
} from './model.ts';
import {
  CATALOG_CLAIM_WAIVERS,
  DECLARED_EDGES,
  DOCS_LANE_OWNERS,
  LOCAL_ONLY,
  TRANSPARENT_WRAPPERS,
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

const trackedFiles = listFiles();
const trackedSet = new Set(trackedFiles);

const ctx: ResolveContext = {
  packageScripts,
  actions,
  vitestProjects,
  expandTestPaths: (pattern) => {
    if (trackedSet.has(pattern)) return [pattern];
    const matches = trackedFiles.filter((file) => pathFilterMatches(pattern, file));
    // An unmatched pattern stays visible as its own terminal: a test glob that matches nothing
    // must surface as unowned work, not vanish into an empty set and read as covered.
    return matches.length > 0 ? matches : [pattern];
  },
  transparentWrappers: new Set(TRANSPARENT_WRAPPERS.map((entry) => entry.file)),
  declaredTerminals: new Map(DECLARED_EDGES.map((entry) => [entry.file, entry.reaches])),
};

const lanes = buildLanes(workflows, ctx);
const suites = suiteUniverse(ctx);

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

// 3. Every waiver still applies. A stale waiver is a hole with a comment on it.
const laneTerminals = new Set(lanes.flatMap((lane) => [...lane.terminals]));
const suiteTerminals = new Set(suites.flatMap((suite) => [...suite.terminals]));
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
  ...DECLARED_EDGES.flatMap((entry) =>
    entry.reaches
      .filter((terminal) => terminal.startsWith('vitest:'))
      .filter((terminal) => !vitestProjects.includes(terminal.slice('vitest:'.length)))
      .map((terminal) => `DECLARED_EDGES "${entry.file}" claims unknown project "${terminal}"`),
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
const PATH_CATEGORY_SAMPLES: readonly { label: string; path: string }[] = [
  { label: 'production source', path: 'src/commands/press.ts' },
  { label: 'workspace package source', path: 'packages/kernel/src/errors.ts' },
  { label: 'platform package source', path: 'packages/platform-android/src/index.ts' },
  { label: 'node integration test', path: 'test/integration/smoke-cli.test.ts' },
  { label: 'Swift runner source', path: 'apple/runner/Sources/Runner/main.swift' },
  { label: 'Android helper source', path: 'android/snapshot-helper/src/main/Snapshot.kt' },
  { label: 'macOS helper source', path: 'apple/macos-helper/Sources/Helper/main.swift' },
  { label: 'MCP registry metadata', path: 'server.json' },
  { label: 'Expo test app', path: 'examples/test-app/App.tsx' },
  { label: 'replay-compat corpus', path: 'test/replay-compat/entry.ad' },
];
const categories: PathCategory[] = PATH_CATEGORY_SAMPLES.map(({ label, path: sample }) => {
  const plan = selectChecks({ changedFiles: [sample] });
  return {
    label,
    path: sample,
    // A fail-open sample would demand every check reach every path, which is not the claim
    // being tested; the samples are chosen to classify cleanly and this asserts they still do.
    checks: plan.failOpen ? [] : plan.checks,
  };
});
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
const docsFailures = DOCS_LANE_OWNERS.flatMap((owner) => {
  const workflow = workflows.find((candidate) => candidate.file === owner.workflow);
  if (!workflow) return [`${owner.workflow} does not exist (declared owner of "${owner.path}")`];
  const job = workflow.jobs.find((candidate) => candidate.id === owner.job);
  if (!job) return [`${owner.workflow} defines no job "${owner.job}"`];
  if (!triggersOnPath(workflow.triggers, owner.path)) {
    return [`${owner.workflow} no longer triggers on "${owner.path}"`];
  }
  const lane = lanes.find(
    (candidate) => candidate.workflow === owner.workflow && candidate.job === owner.job,
  );
  if (!lane || lane.terminals.size === 0) {
    return [`${owner.workflow}#${owner.job} runs no resolvable gate for "${owner.path}"`];
  }
  return [];
});
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
    `${LOCAL_ONLY.length + DECLARED_EDGES.length + TRANSPARENT_WRAPPERS.length} owned waivers.`,
);
