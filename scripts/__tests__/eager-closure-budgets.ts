// Per-entry eager-closure budgets -- the ADR-0019 loading-shape probe (#1739, #1960).
//
// ADR-0019's "Implementation-laziness" section requires platform-package façades to stay
// implementation-lazy and says a startup-time threshold alone does not preserve the loading
// shape (`docs/adr/0019-request-bound-platform-runtime.md`). The AST walker in
// `src/__tests__/eager-import-closure.fixtures.ts` counts the repo modules that importing an
// entry evaluates; this module says what count each entry may have. R13 governs import
// DIRECTION (may this file reach that one at all), never evaluation WEIGHT.
//
// Entries are every package entry surface `facadeEntryFiles` discovers plus the hand-listed hubs
// below. Each falls under one rule, chosen by its category, which is derived from its path:
//
// - `platform-facade` (`packages/platform-<family>/src/index.ts`): EXACT. It evaluates one
//   module, itself -- metadata inline, contract imports type-only, every implementation behind a
//   function-scoped `await import`. A single static value import destroys the property.
// - Every other entry that exists at the merge-base with origin/main: NO GROWTH. Its closure may
//   not be larger than the closure of the same file (renames followed) in the committed
//   merge-base tree, read through `committed-source-tree.ts`. Shrinking needs no edit: there is
//   no number to keep in step, and the next merge-base keeps the gain.
// - An entry absent at the merge-base: a per-category CEILING (`NEW_ENTRY_CEILINGS`). At or
//   under it, nothing to write. Over it, one `APPROVED_OVER_CEILING` row naming the issue, the
//   reason, and an owner; the row records no number, and the merge-base carries the entry from
//   the next PR on. A row is stale once nothing can read it -- the entry is gone, the merge-base
//   now carries it, or its closure fits the ceiling -- and a stale row fails, EXCEPT where the
//   merge-base is the head itself and no row is readable at all (`staleApprovalRows`).
//
// Independent of size, a façade entry's closure must never reach a concrete platform
// implementation (`PLATFORM_IMPLEMENTATION_PATTERNS`) before discovery or binding selects an
// owner -- the ADR-0019 property itself, and the reason the exceptions below are named.

import path from 'node:path';
import { facadeEntryFiles } from '../layering/package-boundaries.ts';

export type EntryCategory =
  | 'platform-facade'
  | 'vocabulary-facade'
  | 'domain-facade'
  | 'mechanics-surface';

export type EagerClosureEntry = {
  /** Stable label for test names and failure messages -- the entry's repo-relative path. */
  id: string;
  /** Repo-root-relative path to the module a consumer imports. */
  entryFile: string;
  /**
   * 'facade' entries are the package entry surfaces `facadeEntryFiles` discovers. 'hub' entries
   * are hand-designated, high-fan-in modules that value-import an entry surface for only a slice
   * of it (ADR-0019's other named case, the shape #1969 fixed at five sites). Nothing enumerates
   * "every hub" the way a manifest enumerates every entry surface, so membership is reviewed.
   */
  kind: 'facade' | 'hub';
  category: EntryCategory;
  /**
   * When true, the closure must not evaluate any concrete platform implementation
   * (`PLATFORM_IMPLEMENTATION_PATTERNS`) OTHER than the entry file itself -- ADR-0019's rule that
   * implementation must not load before discovery/binding selects an owner. The self-exclusion is
   * what makes this meaningful for the platform packages: `packages/platform-apple/src/index.ts`
   * necessarily matches the pattern, so a naive check could only ever be vacuously false there;
   * excluding just the entry turns the assertion into "this façade evaluates none of its own
   * mechanics", which is the actual ADR-0019 property.
   *
   * Every package entry surface sets this true except the runner mechanics and named Apple
   * domain/mechanics facet entries (see the exceptions below), whose closure IS the implementation
   * intentionally exposed through that subpath.
   * Hub rows set it false -- a hub is a CONSUMER of façades, not neutral vocabulary, and three of
   * them legitimately hold R13-permitted static platform-package seams.
   */
  denyPlatformImplementations: boolean;
};

/**
 * A concrete platform implementation lives in a private `@agent-device/platform-<family>`
 * workspace package. The retired `src/platforms/<family>/` spelling remains matched so a
 * reintroduced legacy path cannot launder an eager edge past this guard.
 */
export const PLATFORM_IMPLEMENTATION_PATTERNS: RegExp[] = [
  /[/\\]platforms[/\\](apple|android|harmonyos|vega|linux|web)[/\\]/,
  /[/\\]packages[/\\]platform-(apple|android|harmonyos|vega|linux|web)[/\\]/,
];

/**
 * Every workspace-package entry surface, delegated to the single owner of that question in
 * `scripts/layering/package-boundaries.ts`.
 *
 * Re-exported rather than reimplemented. The first version of this gate carried its own
 * one-level `readdir` of each package's `src/facades`, which disagreed with R11's recursive,
 * manifest-first discovery in two ways at once: it missed nested façade files, and it missed
 * every package that publishes its entry surface straight from the manifest -- including all six
 * `packages/platform-<family>/src/index.ts` façades, the exact subject of the ADR-0019 rule this
 * gate exists to enforce. Two discovery implementations is one more than the number that can be
 * correct, so there is now one.
 */
export function discoverFacadeEntryFiles(repoRoot: string): string[] {
  return facadeEntryFiles(repoRoot);
}

/**
 * Designated hubs: entry points whose closure the whole suite or every CLI run pays for.
 * `src/platform-runtime.ts` is the ADR-0019 composition root, the one production module allowed
 * to value-import a concrete platform package; its no-growth rule is also the assertion that
 * composing the registry stays metadata-eager.
 */
export const HUB_ENTRY_FILES: readonly string[] = [
  'src/cli.ts',
  'src/platform-runtime.ts',
  'src/core/interactors/register-builtins.ts',
  'src/daemon/session-teardown.ts',
];

/** A platform façade evaluates exactly this many modules: itself. */
export const PLATFORM_FACADE_CLOSURE = 1;

/**
 * Ceilings for entries that do not exist at the merge-base, per category.
 * Provisional: per-category p75 at e624ef9d3f (2026-09-02); Day-0 maintainer decision pending.
 */
export const NEW_ENTRY_CEILINGS: Readonly<Record<EntryCategory, number>> = Object.freeze({
  'platform-facade': 1,
  'vocabulary-facade': 4,
  'domain-facade': 20,
  'mechanics-surface': 71,
});

/**
 * First-introduced entries allowed over their category ceiling, keyed by repo-relative entry
 * path. No measured value: the merge-base carries the entry from the next PR on.
 */
export const APPROVED_OVER_CEILING: Readonly<
  Record<string, { issue: string; reason: string; owner: string }>
> = Object.freeze({});

/** The category is a function of the path, never a hand-written column. */
export function entryCategoryOf(entryFile: string): EntryCategory {
  if (/^packages\/platform-[^/]+\/src\/index\.ts$/.test(entryFile)) return 'platform-facade';
  if (entryFile.startsWith('packages/contracts/')) return 'vocabulary-facade';
  if (/^packages\/[^/]+\/src\//.test(entryFile)) return 'domain-facade';
  if (entryFile.startsWith('src/')) return 'mechanics-surface';
  throw new Error(`${entryFile} is neither a package entry surface nor a src/ hub`);
}

/**
 * Mechanics facets inside platform packages. Their entry surfaces ARE platform implementation,
 * so the deny-platform assertion is meaningless for them: the whole closure is the mechanics
 * being exported. Their weight stays under the no-growth rule.
 */
const PLATFORM_MECHANICS_ENTRY_PREFIXES = [
  'packages/platform-apple/src/runner/',
  'packages/platform-android/src/mechanics.ts',
] as const;

const APPLE_DOMAIN_MECHANICS_ENTRY_FILES: ReadonlySet<string> = new Set([
  'packages/platform-apple/src/app-lifecycle-facade.ts',
  'packages/platform-apple/src/app-resolution-facade.ts',
  'packages/platform-apple/src/debug-symbols-facade.ts',
  'packages/platform-apple/src/doctor-facade.ts',
  'packages/platform-apple/src/install-artifact-facade.ts',
  'packages/platform-apple/src/macos-facade.ts',
  'packages/platform-apple/src/perf-facade.ts',
  'packages/platform-apple/src/physical-device-facade.ts',
  'packages/platform-apple/src/runner-operations-facade.ts',
  'packages/platform-apple/src/runner-owner-facade.ts',
  'packages/platform-apple/src/simctl-facade.ts',
  'packages/platform-apple/src/simulator-facade.ts',
  'packages/platform-apple/src/tool-provider-facade.ts',
]);

function toEntry(entryFile: string, kind: 'facade' | 'hub'): EagerClosureEntry {
  return {
    id: entryFile,
    entryFile,
    kind,
    category: entryCategoryOf(entryFile),
    denyPlatformImplementations:
      kind === 'facade' &&
      !PLATFORM_MECHANICS_ENTRY_PREFIXES.some((prefix) =>
        prefix.endsWith('/') ? entryFile.startsWith(prefix) : entryFile === prefix,
      ) &&
      !APPLE_DOMAIN_MECHANICS_ENTRY_FILES.has(entryFile),
  };
}

/** Every entry the gate measures: the discovered façades, then the hubs. */
export function eagerClosureEntries(repoRoot: string): EagerClosureEntry[] {
  return [
    ...discoverFacadeEntryFiles(repoRoot).map((file) => toEntry(file, 'facade')),
    ...HUB_ENTRY_FILES.map((file) => toEntry(file, 'hub')),
  ];
}

/**
 * The no-growth verdict: `null` unless the head closure is larger than the merge-base one.
 *
 * The closing sentence deliberately does not prescribe one fix. #2423's review found that a
 * generic "move it behind a dynamic import" sent five reviewers toward the wrong change: the
 * growth there was a small new module that belonged in a module every affected entry already
 * evaluated, not behind a lazy boundary. There are two common causes and two remedies, and which
 * applies is exactly what the added-module listing this verdict is always printed alongside
 * (`describeClosureGrowth`) is for.
 */
export function classifyGrowth(id: string, base: number, head: number): string | null {
  if (head <= base) return null;
  return (
    `${id} evaluates ${head} modules on import; the merge-base evaluated ${base}. That means ` +
    'either a new static edge was added, or something that used to load on demand now loads ' +
    'eagerly. The fix is either to give the new code a home in a module the closure already ' +
    'evaluates, or to move the new edge behind a function-scoped `await import` -- see the ' +
    'added module(s) below for which one fits.'
  );
}

/** The ceiling verdict for a first-introduced entry: `null` when it fits or is approved. */
export function classifyNewEntry(
  id: string,
  category: EntryCategory,
  head: number,
  approved: boolean,
): string | null {
  const ceiling = NEW_ENTRY_CEILINGS[category];
  if (head <= ceiling || approved) return null;
  return (
    `${id} is a new ${category} entry evaluating ${head} modules on import, over the ` +
    `${category} ceiling of ${ceiling}. Make its heavy edges lazy, or add an ` +
    'APPROVED_OVER_CEILING row naming the issue, the reason, and an owner.'
  );
}

/**
 * The `APPROVED_OVER_CEILING` rows that can no longer change any verdict, so their removal is the
 * only thing left to do with them: the entry is gone, the merge-base now carries it, or its
 * closure fits the ceiling after all.
 *
 * The verdict is only readable from a commit that carries work of its own. When the merge-base IS
 * the head -- a push to `main`, or any commit `main` already carries -- nothing is
 * first-introduced by construction, so EVERY row reads as stale whatever its real state. The
 * approving PR's own merge commit is exactly that shape, so judging staleness there made each
 * approval a guaranteed red `main` one commit after it landed (#2329, run 34099687663): the row
 * is required to merge the PR, and the merge that follows it is the run that calls the row dead.
 * Deferring to the next branch loses no enforcement -- a row that outlives its PR is reported
 * there, on the first commit whose merge-base could have read it.
 */
export function staleApprovalRows(
  approvals: readonly string[],
  introduced: ReadonlyMap<string, { category: EntryCategory; closureSize: number }>,
  mergeBaseIsHead: boolean,
): string[] {
  if (mergeBaseIsHead) return [];
  return approvals.filter((id) => {
    const entry = introduced.get(id);
    return entry === undefined || entry.closureSize <= NEW_ENTRY_CEILINGS[entry.category];
  });
}

/**
 * Failure-output caps. A violation has to fit in a terminal to be read: `src/cli.ts` evaluates
 * 363 modules, and one eagerly-imported platform subtree can pull in hundreds, so both
 * diagnostics below print a few owning edges with a couple of representative routes each and
 * count what they left out, rather than emitting a chain per module.
 */
const REPORTED_EDGES = 4;
const REPORTED_ROUTES_PER_EDGE = 2;

/**
 * The entry's own direct import that `file` came in through -- walk the discovery chain back up
 * until the next step would be the entry itself.
 *
 * This is the unit both diagnostics group by, because it is the unit a reader can act on: the
 * fix for "too much evaluates" is almost always to change one of the entry's own imports.
 */
function owningEdgeOf(
  graph: ReadonlyMap<string, string | null>,
  entryPath: string,
  file: string,
): string | null {
  let current = file;
  for (let hops = 0; hops < 64; hops += 1) {
    const parent = graph.get(current);
    if (parent === undefined || parent === null) return null;
    if (parent === entryPath) return current;
    current = parent;
  }
  return null;
}

/** `files` bucketed by the entry's direct import they arrived through, heaviest bucket first. */
function groupByOwningEdge(
  graph: ReadonlyMap<string, string | null>,
  entryPath: string,
  files: readonly string[],
): { edge: string; members: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const edge = owningEdgeOf(graph, entryPath, file) ?? file;
    const members = groups.get(edge);
    if (members) members.push(file);
    else groups.set(edge, [file]);
  }
  return [...groups]
    .map(([edge, members]) => ({ edge, members }))
    .sort((left, right) => right.members.length - left.members.length);
}

/** Deepest routes first: a leaf names the far end of the chain, not just the edge again. */
function representativeRoutes(
  graph: ReadonlyMap<string, string | null>,
  members: readonly string[],
  repoRoot: string,
): string[] {
  return [...members]
    .sort((left, right) => chainLength(graph, right) - chainLength(graph, left))
    .slice(0, REPORTED_ROUTES_PER_EDGE)
    .map((file) => `    ${formatImportChain(graph, file, repoRoot)}`);
}

/**
 * Shared bounded rendering for both diagnostics: the top `REPORTED_EDGES` owning edges, each with
 * up to `REPORTED_ROUTES_PER_EDGE` representative routes, plus an explicit count of everything
 * omitted so a truncated report never reads as a complete one.
 */
function renderOwningEdges(
  graph: ReadonlyMap<string, string | null>,
  repoRoot: string,
  groups: readonly { edge: string; members: string[] }[],
  noun: string,
): string {
  const shown = groups.slice(0, REPORTED_EDGES);
  const sections = shown.map(({ edge, members }) => {
    const routes = representativeRoutes(graph, members, repoRoot);
    const hiddenRoutes = members.length - routes.length;
    const more = hiddenRoutes > 0 ? `\n    (+${hiddenRoutes} more ${noun} under this edge)` : '';
    return (
      `  ${path.relative(repoRoot, edge)} -- ${members.length} ${noun} under this edge:\n` +
      `${routes.join('\n')}${more}`
    );
  });
  const hiddenGroups = groups.slice(REPORTED_EDGES);
  const hiddenMembers = hiddenGroups.reduce((total, group) => total + group.members.length, 0);
  const tail =
    hiddenGroups.length > 0
      ? `\n  (+${hiddenGroups.length} more owning edge(s), ${hiddenMembers} ${noun})`
      : '';
  return `${sections.join('\n')}${tail}`;
}

/**
 * A bounded account of WHERE an entry's evaluated modules come from: its heaviest direct imports,
 * each with a couple of representative routes into what they pull in.
 *
 * What it shows: the entry's direct edges ranked by how many modules enter the closure THROUGH
 * THEM -- attribution by shortest import route, since the walk is breadth-first -- capped, with
 * the omitted counts stated. When a regression is a new import on the entry itself, which is the
 * common case, that edge is new and everything under it is attributed to it, so it sorts to the
 * top and the offending route is the first thing printed.
 *
 * This is the diagnostic for an entry with no merge-base closure to diff against;
 * `describeClosureGrowth` names the exact delta for one that has it.
 */
export function describeClosurePressure(
  graph: ReadonlyMap<string, string | null>,
  entryPath: string,
  repoRoot: string,
): string {
  const evaluated = [...graph.keys()].filter((file) => file !== entryPath);
  if (evaluated.length === 0) return '  (no eager edges: this entry evaluates only itself)';
  return renderOwningEdges(
    graph,
    repoRoot,
    groupByOwningEdge(graph, entryPath, evaluated),
    'module(s)',
  );
}

/** How many of `added` a growth diagnostic names individually before it just counts the rest. */
const REPORTED_ADDED_MODULES = 10;

/** Head-closure files absent from the merge-base closure -- what actually grew, entry excluded. */
export function addedModules(
  graph: ReadonlyMap<string, string | null>,
  baseClosure: ReadonlySet<string>,
  entryPath: string,
): string[] {
  return [...graph.keys()].filter((file) => file !== entryPath && !baseClosure.has(file));
}

/**
 * Every newly evaluated module against the merge-base (bounded to `REPORTED_ADDED_MODULES`), each
 * with the shortest static import route from the entry down to it.
 *
 * #2423's review is why this names more than one module: the previous version of this diagnostic
 * printed only the FIRST added module, which hid the pattern when the real growth was one small
 * new module reached from several places. A reader saw one chain, read it as "this one edge
 * should be lazy", and proposed a dynamic import for what was actually a shared constant -- five
 * times, across five separate CI failures, because nothing in any one entry's message showed that
 * the "new" modules were mostly the same one. Listing every added module (still bounded) lets a
 * reader see that shape from a single failure.
 */
export function describeClosureGrowth(
  graph: ReadonlyMap<string, string | null>,
  baseClosure: ReadonlySet<string>,
  entryPath: string,
  repoRoot: string,
): string {
  const added = addedModules(graph, baseClosure, entryPath);
  if (added.length === 0) return '  (no module is new against the merge-base)';
  const shown = added.slice(0, REPORTED_ADDED_MODULES);
  const lines = shown.map((file) => `  ${formatImportChainArrow(graph, file, repoRoot)}`);
  const hidden = added.length - shown.length;
  const more = hidden > 0 ? `\n  (+${hidden} more newly evaluated module(s))` : '';
  return `${lines.join('\n')}${more}`;
}

/**
 * The same bounded shape for the platform-implementation assertion.
 *
 * One eagerly imported platform subtree drags in hundreds of implementation modules, so listing
 * every offender with its own full chain buries the single import that caused all of them. This
 * groups the offenders by the entry's own import they arrived through -- which is the edge to
 * make lazy -- and caps the output the same way (#1965 review).
 */
export function describePlatformOffenders(
  graph: ReadonlyMap<string, string | null>,
  entryPath: string,
  repoRoot: string,
  offenders: readonly string[],
): string {
  if (offenders.length === 0) return '';
  return renderOwningEdges(
    graph,
    repoRoot,
    groupByOwningEdge(graph, entryPath, offenders),
    'platform implementation module(s)',
  );
}

/**
 * The hops from a closure's entry down to `target`, repo-relative, shallowest first.
 *
 * #1960 asks a violation to "name the offending edge chain". A sorted set of evaluated files names
 * the destination but not the route, which leaves the reader to rediscover by hand which import
 * actually pulled it in. `eagerClosureGraphOf` records each file's discoverer, so the route is
 * just a walk back up, and because that walk is breadth-first the route is the shortest one.
 */
function chainTo(
  graph: ReadonlyMap<string, string | null>,
  target: string,
  repoRoot: string,
): string[] {
  const chain: string[] = [];
  for (let at: string | null | undefined = target; at != null; at = graph.get(at)) {
    chain.push(path.relative(repoRoot, at));
    if (chain.length > 64) break; // defensive: a cycle would otherwise spin here
  }
  return chain.reverse();
}

/** The import chain from a closure's entry down to `target`, rendered one edge per line. */
function formatImportChain(
  graph: ReadonlyMap<string, string | null>,
  target: string,
  repoRoot: string,
): string {
  return chainTo(graph, target, repoRoot).join('\n      -> ');
}

/**
 * The same route as `formatImportChain`, arrow-joined on one line -- compact enough to list
 * several of them (`describeClosureGrowth`) without the multi-line chain format burying the list
 * itself under indentation.
 */
function formatImportChainArrow(
  graph: ReadonlyMap<string, string | null>,
  target: string,
  repoRoot: string,
): string {
  return chainTo(graph, target, repoRoot).join(' → ');
}

/** How many hops from the entry down to `target`, bounded so a cycle cannot spin. */
function chainLength(graph: ReadonlyMap<string, string | null>, target: string): number {
  let length = 0;
  for (let at: string | null | undefined = target; at != null; at = graph.get(at)) {
    length += 1;
    if (length > 64) break;
  }
  return length;
}

/** A growing entry's contribution to the cross-entry shared-homes aggregation below. */
export type GrowthForAggregation = {
  /** The entry's label, matching `EagerClosureEntry.id`. */
  id: string;
  /** This entry's added modules (absolute paths), as `addedModules` returns them. */
  added: readonly string[];
  /** This entry's merge-base closure graph -- gives both membership and forward edges. */
  baseGraph: ReadonlyMap<string, string | null>;
};

/** How many candidate homes `describeSharedGrowthHomes` names before it just counts the rest. */
const MAX_SHARED_HOMES = 30;

/**
 * The workspace package (or the root `src/` mechanics tree) a repo-relative path lives under --
 * the scope `describeSharedGrowthHomes` searches for an existing home, since a candidate outside
 * the added module's own package is not a home the added module could plausibly move into.
 */
function packageOf(relativeFile: string): string {
  const match = /^(packages\/[^/]+)\//.exec(relativeFile);
  return match ? match[1] : 'src';
}

/** True when nothing in `graph` records `candidate` as the direct importer of a same-package file. */
function hasNoInPackageChild(
  candidate: string,
  pkg: string,
  graph: ReadonlyMap<string, string | null>,
  repoRoot: string,
): boolean {
  for (const [child, parent] of graph) {
    if (parent === candidate && packageOf(path.relative(repoRoot, child)) === pkg) return false;
  }
  return true;
}

/** Every entry that grew, indexed by each of its added modules -- one entry may appear under several. */
function groupGrowthsByAddedModule(
  growths: readonly GrowthForAggregation[],
): Map<string, GrowthForAggregation[]> {
  const entriesByAddedModule = new Map<string, GrowthForAggregation[]>();
  for (const growth of growths) {
    for (const added of growth.added) {
      const group = entriesByAddedModule.get(added);
      if (group) group.push(growth);
      else entriesByAddedModule.set(added, [growth]);
    }
  }
  return entriesByAddedModule;
}

/**
 * One added-module group's contribution to the candidate homes: when at least two entries grew
 * by `added`, every merge-base module the first entry evaluates that is (a) in the added
 * module's own package, (b) not already claimed as a home for a different added module, and (c)
 * also evaluated by every other entry in the group, is recorded as a home -- mutating
 * `homePackage` and `homeGraph` in place.
 */
function collectSharedHomesForGroup(
  added: string,
  group: readonly GrowthForAggregation[],
  repoRoot: string,
  homePackage: Map<string, string>,
  homeGraph: Map<string, ReadonlyMap<string, string | null>>,
): void {
  if (group.length < 2) return;
  const [first, ...rest] = group;
  if (!first) return;
  const pkg = packageOf(path.relative(repoRoot, added));
  for (const candidate of first.baseGraph.keys()) {
    if (homePackage.has(candidate)) continue;
    if (packageOf(path.relative(repoRoot, candidate)) !== pkg) continue;
    if (!rest.every((other) => other.baseGraph.has(candidate))) continue;
    homePackage.set(candidate, pkg);
    homeGraph.set(candidate, first.baseGraph);
  }
}

/**
 * For each added module shared by two or more entries, the modules every one of those entries
 * already evaluates at the merge-base, scoped to the added module's own package -- the candidate
 * homes a shared symbol could plausibly move into. A module already claimed as a home for one
 * added module is not reconsidered for another.
 */
function sharedGrowthHomeCandidates(
  entriesByAddedModule: ReadonlyMap<string, readonly GrowthForAggregation[]>,
  repoRoot: string,
): {
  homePackage: Map<string, string>;
  homeGraph: Map<string, ReadonlyMap<string, string | null>>;
} {
  const homePackage = new Map<string, string>();
  const homeGraph = new Map<string, ReadonlyMap<string, string | null>>();
  for (const [added, group] of entriesByAddedModule) {
    collectSharedHomesForGroup(added, group, repoRoot, homePackage, homeGraph);
  }
  return { homePackage, homeGraph };
}

/**
 * Candidate homes with modules that have no in-package eager import of their own first --
 * a leaf module is the safer home, since adding a symbol to it cannot itself grow anyone else's
 * closure -- then alphabetically by repo-relative path.
 */
function sortHomesLeavesFirst(
  homePackage: ReadonlyMap<string, string>,
  homeGraph: ReadonlyMap<string, ReadonlyMap<string, string | null>>,
  repoRoot: string,
): string[] {
  const isLeaf = (candidate: string): boolean =>
    hasNoInPackageChild(
      candidate,
      homePackage.get(candidate) as string,
      homeGraph.get(candidate) as ReadonlyMap<string, string | null>,
      repoRoot,
    );
  return [...homePackage.keys()].sort((left, right) => {
    const leftLeaf = isLeaf(left);
    const rightLeaf = isLeaf(right);
    if (leftLeaf !== rightLeaf) return leftLeaf ? -1 : 1;
    return path.relative(repoRoot, left).localeCompare(path.relative(repoRoot, right));
  });
}

/** Renders the sorted candidate homes as the bounded, capped message block. */
function formatSharedGrowthHomes(sortedHomes: readonly string[], repoRoot: string): string {
  const shown = sortedHomes.slice(0, MAX_SHARED_HOMES);
  const hidden = sortedHomes.length - shown.length;
  const lines = shown.map((file) => `  ${path.relative(repoRoot, file)}`);
  const more = hidden > 0 ? `\n  (+${hidden} more)` : '';
  return (
    'Modules every failing entry already evaluates (possible homes for a shared symbol; not a ' +
    `statement that any of them is the right owner):\n${lines.join('\n')}${more}`
  );
}

/**
 * When two or more entries grow by the SAME newly-added module, the per-entry diagnostic above
 * cannot show the shape that actually matters: there is no old edge to make lazy, because the
 * module is brand new, so "move it behind a dynamic import" is not even coherent advice. The
 * useful question is "where does this already have a home", and the answer is scoped to what
 * every affected entry already evaluates, under the added module's own package -- a real
 * candidate list instead of "somewhere in the repo".
 *
 * #2423's review: five reviewers each independently proposed a dynamic import for a constant that
 * a module already imported eagerly wherever it was needed; the fix was moving the constant
 * there. Nothing in any one entry's own message could show that shape, because each entry's
 * diagnostic only ever describes that one entry's own closure. This runs once, after every entry
 * has been evaluated, and is silent (`null`) unless at least two entries actually share an added
 * module and that intersection is non-empty.
 *
 * Sorted with modules that have no in-package eager import of their own first when that is cheap
 * to compute -- it already is here, since a candidate's forward edges are read straight off the
 * base graph that produced it, no extra tree read required -- because a leaf module is the safer
 * home: adding a symbol to it cannot itself grow anyone else's closure.
 */
export function describeSharedGrowthHomes(
  growths: readonly GrowthForAggregation[],
  repoRoot: string,
): string | null {
  const entriesByAddedModule = groupGrowthsByAddedModule(growths);
  const { homePackage, homeGraph } = sharedGrowthHomeCandidates(entriesByAddedModule, repoRoot);
  if (homePackage.size === 0) return null;

  const sorted = sortHomesLeavesFirst(homePackage, homeGraph, repoRoot);
  return formatSharedGrowthHomes(sorted, repoRoot);
}
