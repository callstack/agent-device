// Per-entry eager-closure budgets -- the ADR-0019 loading-shape probe (#1739, #1960).
//
// ADR-0019's "Implementation-laziness" section requires platform-package façades to stay
// implementation-lazy and is explicit that a startup-time threshold alone is not a substitute for
// preserving the loading shape (`docs/adr/0019-request-bound-platform-runtime.md`): "the tracking
// issue owns the exact probe and planted-red procedure." #1950 built the AST-level walker
// (`eager-import-closure.fixtures.ts`); #1959/#1969 fixed two more instances of the regression
// class by hand. This table generalizes the proof: every package entry surface gets a numeric
// ceiling on how many repo modules importing it may evaluate, plus a standing assertion that the
// closure never reaches a concrete platform implementation before discovery/binding selects one.
//
// The six `packages/platform-*/src/index.ts` façades are the reason this gate exists. Each one
// evaluates exactly ONE module today -- itself -- because its metadata is inline, its contract
// imports are `import type` (erased), and every implementation loads through a function-scoped
// `await import`. That is precisely ADR-0019's "metadata-eager and implementation-lazy" property,
// and a single static value import would silently destroy it while every other gate stayed green:
// R3/R13 govern import DIRECTION (may this file reach that one at all), never evaluation WEIGHT.
//
// Entry files are repo-root-relative.

import fs from 'node:fs';
import path from 'node:path';
import { readWorkspacePackages } from '../../scripts/layering/package-boundaries.ts';

export type EagerClosureBudget = {
  /** Stable label for test names and failure messages -- the entry's repo-relative path. */
  id: string;
  /** Repo-root-relative path to the module a consumer imports. */
  entryFile: string;
  /**
   * Exact number of repo modules `eagerClosureOf(entryFile)` evaluates today, asserted as an
   * upper bound (`<=`). Seeded from measurement, with NO headroom: this is a ratchet, matching
   * how the repo pins R9 type-cycle size, R10 writer/owner counts, and test-file line counts --
   * "existing pins only shrink; a new pin requires measured justification"
   * (`docs/agents/testing.md`). Slack is not neutral here. The regression this gate exists to
   * catch is a single static import that drags a subtree in, and #1969 measured that class at
   * 5-12% of the whole suite's import work each; a ceiling carrying "a few files" of spare room
   * is a ceiling that silently absorbs the small end of exactly that. Growth is fine -- it just
   * has to be a visible number change in the diff of the PR that causes it.
   */
  budget: number;
  /**
   * 'facade' entries are discovered mechanically by `discoverFacadeEntryFiles`, and the
   * exhaustiveness test in `eager-closure-budgets.test.ts` requires each discovered file to appear
   * here exactly once. 'hub' entries are hand-designated, high-fan-in modules that value-import an
   * entry surface for only a slice of it (ADR-0019's other named case, and the specific shape
   * #1969 fixed at five sites). There is no mechanical way to enumerate "every hub" the way a
   * manifest enumerates every entry surface, so hub membership is a reviewed judgment call.
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
   * Hub entries set it false -- a hub is a CONSUMER of façades, not neutral vocabulary, and three
   * of them legitimately hold the R3-permitted static platform seam that has not migrated yet.
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
 * Every workspace-package entry surface, repo-root-relative and sorted.
 *
 * Ownership is the package MANIFEST: whatever a `package.json` `exports` map points at is an entry
 * a consumer can import, so that is what needs a loading-shape budget. Files under a
 * `src/facades/` directory are added on top, exactly as `scripts/layering/package-boundaries.ts`'s
 * R11 façade gate composes its own set (`readWorkspacePackages(...).exportTargets` plus every
 * `/src/facades/` source), and for the same reason: a façade directory is a façade whether or not
 * a manifest happens to point at it yet.
 *
 * Deriving from manifests rather than scanning `packages/<pkg>/src/facades/` is not a detail. Six
 * platform packages have no `facades/` directory at all -- each publishes `./src/index.ts` -- so a
 * directory-only scan silently omits the exact files ADR-0019's implementation-laziness rule is
 * about, and the gate would claim to prove the loading shape while never looking at it.
 *
 * `readWorkspacePackages` is reused rather than reimplemented so the two gates cannot drift into
 * disagreeing about what a package entry surface is.
 */
export function discoverFacadeEntryFiles(repoRoot: string): string[] {
  const found = new Set<string>();
  for (const pkg of readWorkspacePackages(repoRoot)) {
    for (const target of pkg.exportTargets.values()) found.add(target);
  }
  const packagesDir = path.join(repoRoot, 'packages');
  const srcRoots = ['src'];
  for (const entry of fs.readdirSync(packagesDir).sort()) {
    if (fs.existsSync(path.join(packagesDir, entry, 'src'))) srcRoots.push(`packages/${entry}/src`);
  }
  for (const srcRoot of srcRoots) {
    const facadesDir = path.join(repoRoot, srcRoot, 'facades');
    if (!fs.existsSync(facadesDir)) continue;
    for (const file of fs.readdirSync(facadesDir).sort()) {
      if (file.endsWith('.ts')) found.add(`${srcRoot}/facades/${file}`);
    }
  }
  return [...found].filter((file) => fs.existsSync(path.join(repoRoot, file))).sort();
}

/**
 * The import chain from a closure's entry down to `target`, rendered one edge per line.
 *
 * #1960 asks a violation to "name the offending edge chain". A sorted set of evaluated files names
 * the destination but not the route, which leaves the reader to rediscover by hand which import
 * actually pulled it in -- the "budget exceeded, go spelunking" failure the issue rules out.
 * `eagerClosureGraphOf` records each file's discoverer, so the route is just a walk back up.
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
  return chain.reverse().join('\n    -> ');
}

function facade(entryFile: string, budget: number): EagerClosureBudget {
  return { id: entryFile, entryFile, budget, kind: 'facade', denyPlatformImplementations: true };
}

function hub(entryFile: string, budget: number): EagerClosureBudget {
  return { id: entryFile, entryFile, budget, kind: 'hub', denyPlatformImplementations: false };
}

/**
 * Measured 2026-08-22 on `03c398406` (post-#1969, which granularized the contracts entry surface
 * from 15 subpaths to 70 and moved the hubs off the wide façades). Budgets are exact; see the
 * `budget` field doc for why there is no headroom.
 */
export const EAGER_CLOSURE_BUDGETS: EagerClosureBudget[] = [
  // --- @agent-device/ad-replay / ad-script / capture-kit ---
  facade('packages/ad-replay/src/index.ts', 58),
  facade('packages/ad-script/src/index.ts', 37),
  facade('packages/capture-kit/src/index.ts', 26),

  // --- @agent-device/contracts: the shared vocabulary package. #1969 gave every module its own
  // entry subpath precisely so a consumer needing one symbol stops evaluating a 32-module union;
  // these budgets are what keeps each narrow entry narrow.
  facade('packages/contracts/src/alert-contract.ts', 1),
  facade('packages/contracts/src/android-input-ownership.ts', 1),
  facade('packages/contracts/src/android-snapshot-quality.ts', 1),
  facade('packages/contracts/src/android-system-chrome.ts', 1),
  facade('packages/contracts/src/app-deployment-runtime-plan.ts', 3),
  facade('packages/contracts/src/app-deployment-runtime.ts', 1),
  facade('packages/contracts/src/app-inventory-runtime.ts', 1),
  facade('packages/contracts/src/app-log-runtime.ts', 1),
  facade('packages/contracts/src/app-state-runtime.ts', 1),
  facade('packages/contracts/src/apple-multitouch-support.ts', 5),
  facade('packages/contracts/src/application-lifecycle-interaction.ts', 7),
  facade('packages/contracts/src/application-lifecycle-runtime-plan.ts', 3),
  facade('packages/contracts/src/application-lifecycle-runtime.ts', 1),
  facade('packages/contracts/src/async-lifecycle.ts', 1),
  facade('packages/contracts/src/audio-probe-result.ts', 1),
  facade('packages/contracts/src/audio-probe-support.ts', 5),
  facade('packages/contracts/src/back-mode.ts', 1),
  facade('packages/contracts/src/click-button.ts', 3),
  facade('packages/contracts/src/command-platform-execution.ts', 2),
  facade('packages/contracts/src/device-readiness-runtime.ts', 1),
  facade('packages/contracts/src/device-shutdown-runtime.ts', 1),
  facade('packages/contracts/src/durable-resource-envelope.ts', 1),
  facade('packages/contracts/src/durable-resource.ts', 1),
  facade('packages/contracts/src/element-text-runtime.ts', 4),
  facade('packages/contracts/src/facades/capture.ts', 9),
  facade('packages/contracts/src/facades/client.ts', 2),
  facade('packages/contracts/src/facades/command.ts', 9),
  facade('packages/contracts/src/facades/device.ts', 8),
  facade('packages/contracts/src/facades/divergence.ts', 3),
  facade('packages/contracts/src/facades/interaction.ts', 25),
  facade('packages/contracts/src/facades/observability.ts', 7),
  facade('packages/contracts/src/facades/platform.ts', 42),
  facade('packages/contracts/src/facades/progress.ts', 1),
  facade('packages/contracts/src/facades/recording.ts', 3),
  facade('packages/contracts/src/facades/remote.ts', 2),
  facade('packages/contracts/src/facades/replay.ts', 3),
  facade('packages/contracts/src/facades/session.ts', 5),
  facade('packages/contracts/src/facades/snapshot.ts', 8),
  facade('packages/contracts/src/focus-runtime.ts', 4),
  facade('packages/contracts/src/gesture-input.ts', 13),
  facade('packages/contracts/src/gesture-normalization.ts', 14),
  facade('packages/contracts/src/gesture-plan-types.ts', 1),
  facade('packages/contracts/src/gesture-plan.ts', 12),
  facade('packages/contracts/src/interaction-error.ts', 1),
  facade('packages/contracts/src/interaction-guarantees.ts', 1),
  facade('packages/contracts/src/interactor-types.ts', 1),
  facade('packages/contracts/src/logs-runtime-plan.ts', 5),
  facade('packages/contracts/src/navigation.ts', 1),
  facade('packages/contracts/src/network-runtime-plan.ts', 5),
  facade('packages/contracts/src/network-runtime.ts', 1),
  facade('packages/contracts/src/platform-module.ts', 5),
  facade('packages/contracts/src/platform-runtime-host.ts', 1),
  facade('packages/contracts/src/platform-runtime-operations.ts', 2),
  facade('packages/contracts/src/platform-runtime-unavailable.ts', 15),
  facade('packages/contracts/src/platform-runtime.ts', 6),
  facade('packages/contracts/src/record-runtime-cutover.ts', 7),
  facade('packages/contracts/src/screen-recording-runtime-plan.ts', 5),
  facade('packages/contracts/src/screen-recording-runtime.ts', 1),
  facade('packages/contracts/src/screenshot-runtime.ts', 4),
  facade('packages/contracts/src/scroll-command.ts', 3),
  facade('packages/contracts/src/scroll-gesture.ts', 10),
  facade('packages/contracts/src/selector-observation-runtime.ts', 1),
  facade('packages/contracts/src/settings.ts', 3),
  facade('packages/contracts/src/snapshot-runtime.ts', 3),
  facade('packages/contracts/src/startup-recovery-fence.ts', 1),
  facade('packages/contracts/src/tv-remote.ts', 3),
  facade('packages/contracts/src/type-text-runtime.ts', 4),
  facade('packages/contracts/src/viewport-runtime.ts', 1),
  facade('packages/contracts/src/wait-runtime-plan.ts', 1),
  facade('packages/contracts/src/wait.ts', 1),

  // --- @agent-device/kernel ---
  facade('packages/kernel/src/bounds.ts', 1),
  facade('packages/kernel/src/collections.ts', 1),
  facade('packages/kernel/src/contracts.ts', 4),
  facade('packages/kernel/src/device.ts', 4),
  facade('packages/kernel/src/errors.ts', 2),
  facade('packages/kernel/src/rect.ts', 1),
  facade('packages/kernel/src/redaction.ts', 1),
  facade('packages/kernel/src/snapshot.ts', 1),

  // --- @agent-device/maestro ---
  facade('packages/maestro/src/index.ts', 104),

  // --- @agent-device/platform-*: ADR-0019's metadata-eager/implementation-lazy façades. Each
  // evaluates only itself; every implementation sits behind a function-scoped `await import`.
  // A budget of 1 is the tightest statement of that property the walker can make.
  facade('packages/platform-android/src/index.ts', 1),
  facade('packages/platform-apple/src/index.ts', 1),
  facade('packages/platform-harmonyos/src/index.ts', 1),
  facade('packages/platform-linux/src/index.ts', 1),
  facade('packages/platform-vega/src/index.ts', 1),
  facade('packages/platform-web/src/index.ts', 1),

  // --- providers, replay-test, selectors, xml ---
  facade('packages/provider-limrun/src/index.ts', 29),
  facade('packages/provider-webdriver/src/index.ts', 49),
  facade('packages/replay-test/src/index.ts', 19),
  facade('packages/selectors/src/ast.ts', 16),
  facade('packages/selectors/src/engine.ts', 19),
  facade('packages/selectors/src/index.ts', 50),
  facade('packages/xml/src/index.ts', 3),

  // --- Designated hub modules ---
  // High-fan-in entry points whose closure the whole suite (or every CLI run) pays for. The first
  // two already carry their own ad hoc pins naming individual expensive modules
  // (`cli-startup-import-closure.test.ts`, `session-teardown-import-closure.test.ts`); the five
  // after them are the hubs #1969 moved off the wide contracts façades, pinned there by name
  // (`contracts-entry-closure.test.ts`). Those tests state a STRONGER property for the one module
  // each names; these budgets add the general layer -- any unexpected growth, not only the shape
  // someone already thought to forbid.
  hub('src/cli.ts', 361),
  // The ADR-0019 composition root: the one production module allowed to value-import a concrete
  // platform package. It evaluates all six family façades (6 modules, all metadata-only), so its
  // budget is also the assertion that composing the registry stays metadata-eager overall.
  hub('src/platform-runtime.ts', 31),
  hub('src/core/dispatch.ts', 100),
  hub('src/core/capabilities.ts', 76),
  hub('src/core/command-descriptor/registry.ts', 66),
  hub('src/core/command-descriptor/platform-execution-entry.ts', 3),
  hub('src/core/interactors/register-builtins.ts', 73),
  hub('src/daemon/session-teardown.ts', 89),
];
