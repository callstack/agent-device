// Per-entry eager-closure budgets -- the ADR-0019 loading-shape probe (#1739, #1960).
//
// ADR-0019's "Implementation-laziness" section requires platform-package façades to stay
// implementation-lazy and is explicit that a startup-time threshold alone is not a substitute for
// preserving the loading shape (`docs/adr/0019-request-bound-platform-runtime.md`): "the tracking
// issue owns the exact probe and planted-red procedure." #1950 built the AST-level walker
// (`eager-import-closure.fixtures.ts`) and proved the planted-red procedure on one file
// (`session-teardown.ts`'s android-helper denylist, kept below as its own ad hoc test). This
// table generalizes that proof: every workspace-package façade gets a numeric ceiling on how many
// repo modules importing it may evaluate, plus -- for façades whose contract is
// implementation-neutral vocabulary -- a standing assertion that the closure never reaches a
// concrete platform implementation before discovery/binding selects one.
//
// Entry files are repo-root-relative.

export type EagerClosureBudget = {
  /** Stable label for test names and failure messages -- the entry's repo-relative path. */
  id: string;
  /** Repo-root-relative path to the module a consumer imports. */
  entryFile: string;
  /**
   * Upper bound on `eagerClosureOf(entryFile).length`. Seeded from the file's CURRENT measured
   * closure size (recorded in the trailing comment on each entry below) plus a few files of
   * headroom for ordinary drift. A regression of the class this gate exists to catch -- a static
   * value import of a heavy module that used to be lazy -- costs tens to low-hundreds of extra
   * evaluated modules (#1960 simulation: single-file regressions of this class cost 5-12% of
   * suite import work each), far past any of this table's headroom.
   */
  budget: number;
  /**
   * 'facade' entries are discovered mechanically -- every `.ts` file under a `src/facades/`
   * directory -- and the exhaustiveness test in `eager-closure-budgets.test.ts` requires each one
   * to appear here exactly once. 'hub' entries are hand-designated, high-fan-in files that
   * value-import a façade for only a slice of it (ADR-0019's other named case). There is no
   * mechanical way to enumerate "every hub" the way a façade directory enumerates every façade,
   * so membership is a reviewed judgment call -- the same judgment call the two existing ad hoc
   * pins this table's mechanism is built to generalize already made by hand.
   */
  kind: 'facade' | 'hub';
  /**
   * When true, the closure must never evaluate a concrete platform implementation (matched by
   * `PLATFORM_IMPLEMENTATION_PATTERNS`) -- the ADR-0019 rule that a façade whose contract is
   * implementation-neutral vocabulary may not evaluate implementation before discovery/binding
   * selects one. Hub entries default this false: a hub is a *consumer* of façades, not vocabulary
   * itself, and may legitimately reach one platform family already (e.g. session teardown's Apple
   * perf cleanup steps) through its own lazy seam. Verified, not merely assumed -- see the
   * measurement note on the `src/daemon/session-teardown.ts` entry below.
   */
  denyPlatformImplementations: boolean;
};

/**
 * A concrete platform implementation: the legacy daemon-owned `src/platforms/<family>/` tree, or
 * a `@agent-device/platform-<family>` workspace package. ADR-0019 names both as "concrete device
 * mechanics" that platform-neutral code may depend on only through contracts, never directly.
 */
export const PLATFORM_IMPLEMENTATION_PATTERNS: RegExp[] = [
  /[/\\]platforms[/\\](apple|android|harmonyos|vega|linux|web)[/\\]/,
  /[/\\]packages[/\\]platform-(apple|android|harmonyos|vega|linux|web)[/\\]/,
];

function facade(entryFile: string, budget: number): EagerClosureBudget {
  return { id: entryFile, entryFile, budget, kind: 'facade', denyPlatformImplementations: true };
}

function hub(entryFile: string, budget: number): EagerClosureBudget {
  return { id: entryFile, entryFile, budget, kind: 'hub', denyPlatformImplementations: false };
}

export const EAGER_CLOSURE_BUDGETS: EagerClosureBudget[] = [
  // packages/contracts/src/facades/*.ts -- measured 2026-08-22 on origin/main (base e5bfde3d1);
  // budget = actual + a few files of headroom. All 14 are implementation-neutral vocabulary per
  // ADR-0019 ("Contracts may depend on kernel vocabulary but never on concrete platform
  // packages or daemon implementation types"), so all deny platform implementations.
  facade('packages/contracts/src/facades/client.ts', 4), // actual 2
  facade('packages/contracts/src/facades/command.ts', 12), // actual 9
  facade('packages/contracts/src/facades/device.ts', 11), // actual 8
  facade('packages/contracts/src/facades/interaction.ts', 30), // actual 25
  facade('packages/contracts/src/facades/capture.ts', 12), // actual 9
  facade('packages/contracts/src/facades/platform.ts', 48), // actual 42
  facade('packages/contracts/src/facades/session.ts', 8), // actual 5
  facade('packages/contracts/src/facades/recording.ts', 6), // actual 3
  facade('packages/contracts/src/facades/observability.ts', 10), // actual 7
  facade('packages/contracts/src/facades/remote.ts', 4), // actual 2
  facade('packages/contracts/src/facades/replay.ts', 6), // actual 3
  facade('packages/contracts/src/facades/snapshot.ts', 11), // actual 8
  facade('packages/contracts/src/facades/divergence.ts', 6), // actual 3
  facade('packages/contracts/src/facades/progress.ts', 3), // actual 1

  // Designated hub modules (ADR-0019's other named case): high-fan-in entry points that already
  // hold their own ad hoc eager-closure pin (`cli-startup-import-closure.test.ts`,
  // `session-teardown-import-closure.test.ts`). Those files keep their existing, MORE specific
  // assertions -- each names an individual known-expensive module, a stronger property for that
  // one module than a numeric ceiling gives. This table adds a second, general-purpose layer: a
  // size ceiling that catches ANY unexpected growth at the entry, not only the one pattern each ad
  // hoc test already watches for.
  hub('src/cli.ts', 420), // actual 386
  // session-teardown.ts already eagerly evaluates 24 Apple perf/runner modules under
  // src/platforms/apple/ (that migration hasn't happened yet -- only the Android perf/
  // snapshot-helper pair is lazy today, per the ad hoc test above), so denyPlatformImplementations
  // stays false here: turning it on would fail on today's real, reviewed state, not a regression.
  hub('src/daemon/session-teardown.ts', 140), // actual 121
];
