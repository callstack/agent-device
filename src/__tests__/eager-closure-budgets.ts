// Per-entry eager-closure budgets -- the ADR-0019 loading-shape probe (#1739, #1960).
//
// ADR-0019's "Implementation-laziness" section requires platform-package façades to stay
// implementation-lazy and is explicit that a startup-time threshold alone is not a substitute for
// preserving the loading shape (`docs/adr/0019-request-bound-platform-runtime.md`): "the tracking
// issue owns the exact probe and planted-red procedure." #1950 built the AST-level walker
// (`eager-import-closure.fixtures.ts`); #1959/#1969 fixed two more instances of the regression
// class by hand. This table generalizes the proof: every package entry surface gets an exact pin
// on how many repo modules importing it evaluates, plus a standing assertion that the closure
// never reaches a concrete platform implementation before discovery/binding selects one.
//
// The six `packages/platform-*/src/index.ts` façades are the reason this gate exists. Each one
// evaluates exactly ONE module today -- itself -- because its metadata is inline, its contract
// imports are `import type` (erased), and every implementation loads through a function-scoped
// `await import`. That is precisely ADR-0019's "metadata-eager and implementation-lazy" property,
// and a single static value import would silently destroy it while every other gate stayed green:
// R3/R13 govern import DIRECTION (may this file reach that one at all), never evaluation WEIGHT.
//
// Entry files are repo-root-relative, and are the KEYS of the two records below. Keying by path
// is what makes a duplicate row unwritable rather than merely discouraged: a repeated key in an
// object literal is a TypeScript error (ts1117), so the "exactly one row per entry" claim is
// enforced by the compiler instead of by a runtime check that a `Set` conversion would hide.

import path from 'node:path';
import { facadeEntryFiles } from '../../scripts/layering/package-boundaries.ts';

export type EagerClosureBudget = {
  /** Stable label for test names and failure messages -- the entry's repo-relative path. */
  id: string;
  /** Repo-root-relative path to the module a consumer imports. */
  entryFile: string;
  /**
   * The EXACT number of repo modules `eagerClosureOf(entryFile)` evaluates, asserted with
   * equality rather than `<=`.
   *
   * A `<=` ceiling looks stricter than it is: the moment an entry legitimately shrinks, the
   * unchanged row silently becomes headroom, and the next regression up to the old number passes
   * unnoticed. Equality is what "only ever ratchets down" actually requires -- the same shape
   * `test-file-size-ratchet.test.ts` uses for file length and R9/R10 use for cycle size and
   * writer counts: growing fails, and shrinking ALSO fails until the row is lowered in the same
   * PR, so the gain is kept rather than banked as slack.
   *
   * Seeded from measurement, never rounded up. The regression this catches is a single static
   * import dragging a subtree in, measured by #1969 at 5-12% of the whole suite's import work
   * each; a row carrying "a few files" of spare room silently absorbs the small end of exactly
   * that.
   */
  budget: number;
  /**
   * 'facade' rows are the package entry surfaces discovered by `facadeEntryFiles`, and the
   * exhaustiveness test requires every discovered file to have exactly one row. 'hub' rows are
   * hand-designated, high-fan-in modules that value-import an entry surface for only a slice of
   * it (ADR-0019's other named case, and the shape #1969 fixed at five sites). There is no
   * mechanical way to enumerate "every hub" the way a manifest enumerates every entry surface, so
   * hub membership is a reviewed judgment call.
   */
  kind: 'facade' | 'hub';
  /**
   * When true, the closure must not evaluate any concrete platform implementation
   * (`PLATFORM_IMPLEMENTATION_PATTERNS`) OTHER than the entry file itself -- ADR-0019's rule that
   * implementation must not load before discovery/binding selects an owner. The self-exclusion is
   * what makes this meaningful for the platform packages: `packages/platform-apple/src/index.ts`
   * necessarily matches the pattern, so a naive check could only ever be vacuously false there;
   * excluding just the entry turns the assertion into "this façade evaluates none of its own
   * mechanics", which is the actual ADR-0019 property.
   *
   * Every package entry surface sets this true (verified: none reaches an implementation today).
   * Hub rows set it false -- a hub is a CONSUMER of façades, not neutral vocabulary, and three of
   * them legitimately hold the R3-permitted static platform seam that has not migrated yet.
   */
  denyPlatformImplementations: boolean;
};

/**
 * A concrete platform implementation: the legacy daemon-owned `src/platforms/<family>/` tree, or
 * a private `@agent-device/platform-<family>` workspace package. ADR-0019 names both as "concrete
 * device mechanics" that platform-neutral code reaches only through contracts.
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
 * Measured 2026-08-22 on `04e4c23b9` (post-#1969, which granularized the contracts entry surface
 * from 15 subpaths to 70 and moved the hubs off the wide façades). Exact pins; see the `budget`
 * field doc for why there is no headroom.
 */
export const FACADE_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  // --- @agent-device/ad-replay ---
  'packages/ad-replay/src/index.ts': 58,

  // --- @agent-device/ad-script ---
  'packages/ad-script/src/index.ts': 37,

  // --- @agent-device/capture-kit ---
  'packages/capture-kit/src/index.ts': 26,

  // --- @agent-device/contracts ---
  'packages/contracts/src/alert-contract.ts': 1,
  'packages/contracts/src/android-input-ownership.ts': 1,
  'packages/contracts/src/android-snapshot-quality.ts': 1,
  'packages/contracts/src/android-system-chrome.ts': 1,
  'packages/contracts/src/app-deployment-runtime-plan.ts': 3,
  'packages/contracts/src/app-deployment-runtime.ts': 1,
  'packages/contracts/src/app-inventory-runtime.ts': 1,
  'packages/contracts/src/app-log-runtime.ts': 1,
  'packages/contracts/src/app-state-runtime.ts': 1,
  'packages/contracts/src/apple-multitouch-support.ts': 5,
  'packages/contracts/src/application-lifecycle-interaction.ts': 7,
  'packages/contracts/src/application-lifecycle-runtime-plan.ts': 3,
  'packages/contracts/src/application-lifecycle-runtime.ts': 1,
  'packages/contracts/src/async-lifecycle.ts': 1,
  'packages/contracts/src/audio-probe-result.ts': 1,
  'packages/contracts/src/audio-probe-support.ts': 5,
  'packages/contracts/src/back-mode.ts': 1,
  'packages/contracts/src/click-button.ts': 3,
  'packages/contracts/src/command-platform-execution.ts': 2,
  'packages/contracts/src/device-readiness-runtime.ts': 1,
  'packages/contracts/src/device-shutdown-runtime.ts': 1,
  'packages/contracts/src/durable-resource-envelope.ts': 1,
  'packages/contracts/src/durable-resource.ts': 1,
  'packages/contracts/src/element-text-runtime.ts': 4,
  'packages/contracts/src/facades/capture.ts': 9,
  'packages/contracts/src/facades/client.ts': 2,
  'packages/contracts/src/facades/command.ts': 9,
  'packages/contracts/src/facades/device.ts': 8,
  'packages/contracts/src/facades/divergence.ts': 3,
  'packages/contracts/src/facades/interaction.ts': 25,
  'packages/contracts/src/facades/observability.ts': 7,
  'packages/contracts/src/facades/platform.ts': 42,
  'packages/contracts/src/facades/progress.ts': 1,
  'packages/contracts/src/facades/recording.ts': 3,
  'packages/contracts/src/facades/remote.ts': 2,
  'packages/contracts/src/facades/replay.ts': 3,
  'packages/contracts/src/facades/session.ts': 5,
  'packages/contracts/src/facades/snapshot.ts': 8,
  'packages/contracts/src/focus-runtime.ts': 4,
  'packages/contracts/src/gesture-input.ts': 13,
  'packages/contracts/src/gesture-normalization.ts': 14,
  'packages/contracts/src/gesture-plan-types.ts': 1,
  'packages/contracts/src/gesture-plan.ts': 12,
  'packages/contracts/src/interaction-error.ts': 1,
  'packages/contracts/src/interaction-guarantees.ts': 1,
  'packages/contracts/src/interactor-types.ts': 1,
  'packages/contracts/src/logs-runtime-plan.ts': 5,
  'packages/contracts/src/navigation.ts': 1,
  'packages/contracts/src/network-runtime-plan.ts': 5,
  'packages/contracts/src/network-runtime.ts': 1,
  'packages/contracts/src/platform-module.ts': 5,
  'packages/contracts/src/platform-runtime-host.ts': 1,
  'packages/contracts/src/platform-runtime-operations.ts': 2,
  'packages/contracts/src/platform-runtime-unavailable.ts': 15,
  'packages/contracts/src/platform-runtime.ts': 6,
  'packages/contracts/src/record-runtime-cutover.ts': 7,
  'packages/contracts/src/screen-recording-runtime-plan.ts': 5,
  'packages/contracts/src/screen-recording-runtime.ts': 1,
  'packages/contracts/src/screenshot-runtime.ts': 4,
  'packages/contracts/src/scroll-command.ts': 3,
  'packages/contracts/src/scroll-gesture.ts': 10,
  'packages/contracts/src/selector-observation-runtime.ts': 1,
  'packages/contracts/src/settings.ts': 3,
  'packages/contracts/src/snapshot-runtime.ts': 3,
  'packages/contracts/src/startup-recovery-fence.ts': 1,
  'packages/contracts/src/tv-remote.ts': 3,
  'packages/contracts/src/type-text-runtime.ts': 4,
  'packages/contracts/src/viewport-runtime.ts': 1,
  'packages/contracts/src/wait-runtime-plan.ts': 1,
  'packages/contracts/src/wait.ts': 1,

  // --- @agent-device/kernel ---
  'packages/kernel/src/bounds.ts': 1,
  'packages/kernel/src/collections.ts': 1,
  'packages/kernel/src/contracts.ts': 4,
  'packages/kernel/src/device.ts': 4,
  'packages/kernel/src/errors.ts': 2,
  'packages/kernel/src/rect.ts': 1,
  'packages/kernel/src/redaction.ts': 1,
  'packages/kernel/src/snapshot.ts': 1,

  // --- @agent-device/maestro ---
  'packages/maestro/src/index.ts': 104,

  // --- @agent-device/platform-*: ADR-0019's metadata-eager/implementation-lazy façades. Each
  // evaluates only itself; every implementation sits behind a function-scoped `await import`.
  // A pin of 1 is the tightest statement of that property the walker can make.
  'packages/platform-android/src/index.ts': 1,

  // --- @agent-device/platform-apple ---
  'packages/platform-apple/src/index.ts': 1,

  // --- @agent-device/platform-harmonyos ---
  'packages/platform-harmonyos/src/index.ts': 1,

  // --- @agent-device/platform-linux ---
  'packages/platform-linux/src/index.ts': 1,

  // --- @agent-device/platform-vega ---
  'packages/platform-vega/src/index.ts': 1,

  // --- @agent-device/platform-web ---
  'packages/platform-web/src/index.ts': 1,

  // --- @agent-device/provider-limrun ---
  'packages/provider-limrun/src/index.ts': 29,

  // --- @agent-device/provider-webdriver ---
  'packages/provider-webdriver/src/index.ts': 49,

  // --- @agent-device/replay-test ---
  'packages/replay-test/src/index.ts': 19,

  // --- @agent-device/selectors ---
  'packages/selectors/src/ast.ts': 16,
  'packages/selectors/src/engine.ts': 19,
  'packages/selectors/src/index.ts': 50,

  // --- @agent-device/xml ---
  'packages/xml/src/index.ts': 3,
});

/**
 * Designated hub modules: high-fan-in entry points whose closure the whole suite (or every CLI
 * run) pays for.
 *
 * `cli.ts` and `session-teardown.ts` already carry ad hoc pins naming individual expensive
 * modules (`cli-startup-import-closure.test.ts`, `session-teardown-import-closure.test.ts`); the
 * five after them are the hubs #1969 moved off the wide contracts façades, pinned there by name
 * (`contracts-entry-closure.test.ts`). Those tests state a STRONGER property for the one module
 * each names; these pins add the general layer -- any unexpected growth, not only the shape
 * someone already thought to forbid.
 *
 * `src/platform-runtime.ts` is the ADR-0019 composition root, the one production module allowed
 * to value-import a concrete platform package. It evaluates all six family façades (metadata
 * only), so its pin is also the assertion that composing the registry stays metadata-eager.
 */
export const HUB_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  'src/cli.ts': 361,
  'src/platform-runtime.ts': 31,
  'src/core/dispatch.ts': 100,
  'src/core/capabilities.ts': 76,
  'src/core/command-descriptor/registry.ts': 66,
  'src/core/command-descriptor/platform-execution-entry.ts': 3,
  'src/core/interactors/register-builtins.ts': 73,
  'src/daemon/session-teardown.ts': 89,
});

function toRows(
  budgets: Readonly<Record<string, number>>,
  kind: 'facade' | 'hub',
): EagerClosureBudget[] {
  return Object.entries(budgets).map(([entryFile, budget]) => ({
    id: entryFile,
    entryFile,
    budget,
    kind,
    denyPlatformImplementations: kind === 'facade',
  }));
}

/**
 * The two records as one list. Uniqueness WITHIN each record is a compile error; the only
 * duplicate still expressible is the same path appearing in both, which
 * `eager-closure-budgets.test.ts` asserts against on this array, before any `Set` conversion
 * could absorb it.
 */
export const EAGER_CLOSURE_BUDGETS: EagerClosureBudget[] = [
  ...toRows(FACADE_BUDGETS, 'facade'),
  ...toRows(HUB_BUDGETS, 'hub'),
];

/**
 * The ratchet verdict for one row: `null` when the pin is exact, otherwise the finding to report.
 *
 * Pure and separately tested, so both directions have a test that fails when the rule is wrong --
 * an `<=` comparison passes every under-budget case, and no assertion over the real tree can
 * distinguish that from a correct rule while the tree happens to match its pins.
 */
export function classifyBudget(id: string, actual: number, budget: number): string | null {
  if (actual === budget) return null;
  if (actual > budget) {
    return (
      `${id} evaluates ${actual} modules on import, pinned at ${budget}. Either something that ` +
      'used to load on demand now loads eagerly (fix the import), or the growth is deliberate ' +
      'and this row moves to the new number in the same PR.'
    );
  }
  return (
    `${id} evaluates ${actual} modules on import, pinned at ${budget}. It shrank -- lower its ` +
    `pin to ${actual} in this PR so the ratchet keeps the gain instead of leaving headroom a ` +
    'later regression could grow back into.'
  );
}

/** How many direct edges, and how many chains within one, an over-pin failure prints. */
const REPORTED_EDGES = 4;
const REPORTED_CHAINS_PER_EDGE = 2;

/** Modules reached from `file` in the breadth-first tree, in discovery order. */
function subtreeOf(childrenOf: ReadonlyMap<string, string[]>, file: string): string[] {
  const found: string[] = [];
  const queue = [file];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === undefined) continue;
    found.push(current);
    for (const child of childrenOf.get(current) ?? []) queue.push(child);
  }
  return found;
}

/**
 * A bounded account of WHERE an entry's evaluated modules come from: its heaviest direct imports,
 * each with a couple of representative routes into the subtree it pulls in.
 *
 * What it shows: the direct edges of the entry ranked by how many modules enter the closure
 * THROUGH THEM -- attribution by shortest import route, since the walk is breadth-first -- capped
 * at `REPORTED_EDGES` edges and `REPORTED_CHAINS_PER_EDGE` chains each. When a regression is a new
 * import on the entry itself, which is the common case, that edge is new and its whole subtree is
 * attributed to it, so it sorts to the top and the offending route is the first thing printed.
 *
 * What it does NOT show: a diff against a recorded baseline. This gate persists each entry's
 * module COUNT, not its module identity, so it cannot say "these three modules are new" -- only
 * "these edges account for the weight". A regression added deep inside an already-large subtree
 * is therefore attributed to the top-level edge containing it, not to the exact file that changed.
 * Naming the true delta would mean checking in ~1,500 module paths and rewriting them on every
 * contracts refactor; the count plus this attribution was judged the better trade. Reconstruct an
 * exact delta when you need one by running the walker on the merge base.
 */
export function describeClosurePressure(
  graph: ReadonlyMap<string, string | null>,
  entryPath: string,
  repoRoot: string,
): string {
  const childrenOf = new Map<string, string[]>();
  for (const [file, parent] of graph) {
    if (parent === null) continue;
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(file);
    else childrenOf.set(parent, [file]);
  }

  const ranked = (childrenOf.get(entryPath) ?? [])
    .map((edge) => ({ edge, subtree: subtreeOf(childrenOf, edge) }))
    .sort((left, right) => right.subtree.length - left.subtree.length);
  if (ranked.length === 0) return '  (no eager edges: this entry evaluates only itself)';

  const sections = ranked.slice(0, REPORTED_EDGES).map(({ edge, subtree }) => {
    // Deepest-first: a leaf names the far end of the route, which is more informative than
    // re-printing the edge itself.
    const deepest = [...subtree]
      .sort((left, right) => chainLength(graph, right) - chainLength(graph, left))
      .slice(0, REPORTED_CHAINS_PER_EDGE);
    const routes = deepest.map((file) => `    ${formatImportChain(graph, file, repoRoot)}`);
    return (
      `  ${path.relative(repoRoot, edge)} -- ${subtree.length} module(s) enter through this ` +
      `edge:\n${routes.join('\n')}`
    );
  });
  const omitted = ranked.length - Math.min(ranked.length, REPORTED_EDGES);
  const tail = omitted > 0 ? `\n  (+${omitted} more direct edge(s), smaller)` : '';
  return `${sections.join('\n')}${tail}`;
}

function chainLength(graph: ReadonlyMap<string, string | null>, target: string): number {
  let length = 0;
  for (let at: string | null | undefined = target; at != null; at = graph.get(at)) {
    length += 1;
    if (length > 64) break;
  }
  return length;
}

/**
 * The import chain from a closure's entry down to `target`, rendered one edge per line.
 *
 * #1960 asks a violation to "name the offending edge chain". A sorted set of evaluated files names
 * the destination but not the route, which leaves the reader to rediscover by hand which import
 * actually pulled it in. `eagerClosureGraphOf` records each file's discoverer, so the route is
 * just a walk back up, and because that walk is breadth-first the route is the shortest one.
 */
export function formatImportChain(
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
