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
//   now carries it, or its closure fits the ceiling -- and a stale row fails.
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
  'src/core/command-descriptor/registry.ts',
  'src/core/command-descriptor/platform-execution-entry.ts',
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

/** The no-growth verdict: `null` unless the head closure is larger than the merge-base one. */
export function classifyGrowth(id: string, base: number, head: number): string | null {
  if (head <= base) return null;
  return (
    `${id} evaluates ${head} modules on import; the merge-base evaluated ${base}. Something ` +
    'that used to load on demand now loads eagerly, or a new static edge was added: move it ' +
    'behind a function-scoped `await import`.'
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

/**
 * Where an existing entry grew: the shortest import route to the first module the merge-base did
 * not evaluate, plus how many more there are. The walk is breadth-first, so the first one in
 * closure order is the shallowest, which is where the new edge almost always is.
 */
export function describeClosureGrowth(
  graph: ReadonlyMap<string, string | null>,
  baseClosure: ReadonlySet<string>,
  entryPath: string,
  repoRoot: string,
): string {
  const added = [...graph.keys()].filter((file) => file !== entryPath && !baseClosure.has(file));
  const first = added[0];
  if (first === undefined) return '  (no module is new against the merge-base)';
  const more = added.length > 1 ? `\n  (+${added.length - 1} more newly evaluated module(s))` : '';
  return `  ${formatImportChain(graph, first, repoRoot)}${more}`;
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
 * The import chain from a closure's entry down to `target`, rendered one edge per line.
 *
 * #1960 asks a violation to "name the offending edge chain". A sorted set of evaluated files names
 * the destination but not the route, which leaves the reader to rediscover by hand which import
 * actually pulled it in. `eagerClosureGraphOf` records each file's discoverer, so the route is
 * just a walk back up, and because that walk is breadth-first the route is the shortest one.
 */
function formatImportChain(
  graph: ReadonlyMap<string, string | null>,
  target: string,
  repoRoot: string,
): string {
  const chain: string[] = [];
  for (let at: string | null | undefined = target; at != null; at = graph.get(at)) {
    chain.push(path.relative(repoRoot, at));
    if (chain.length > 64) break; // defensive: a cycle would otherwise spin here
  }
  return chain.reverse().join('\n      -> ');
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
