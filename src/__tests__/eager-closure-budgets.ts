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
   * Every package entry surface sets this true except the runner mechanics
   * facet entries (see PLATFORM_MECHANICS_ENTRY_PREFIX below), whose closure
   * IS the implementation.
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
  'packages/ad-replay/src/index.ts': 57,

  // --- @agent-device/ad-script ---
  'packages/ad-script/src/index.ts': 37,

  // --- @agent-device/platform-apple/runner ---
  // #2040 extraction: the façade stays types/pure-helpers/bundle-ids; the whole
  // client implementation loads only through the './client' subpath, which the
  // root composition module reaches behind its consumers' dynamic imports.
  'packages/platform-apple/src/runner/index.ts': 13,
  'packages/platform-apple/src/runner/client.ts': 46,
  'packages/platform-apple/src/runner/test-host.ts': 2,

  // --- @agent-device/capture-kit ---
  // R60 review: audio-probe split into descriptor/status/recovery/live-process modules (+3 files).
  'packages/capture-kit/src/index.ts': 32,
  'packages/capture-kit/src/png-resize.ts': 18,
  'packages/capture-kit/src/png-rgb-difference.ts': 1,
  'packages/capture-kit/src/png-size.ts': 3,
  'packages/capture-kit/src/png-worker-client.ts': 10,
  'packages/capture-kit/src/png.ts': 3,
  'packages/capture-kit/src/screenshot-density.ts': 6,
  'packages/capture-kit/src/screenshot-diff-pixels.ts': 1,
  'packages/capture-kit/src/mobile-snapshot-semantics.ts': 10,
  'packages/capture-kit/src/snapshot-occlusion.ts': 10,
  'packages/capture-kit/src/snapshot-quality-backend-capabilities.ts': 1,
  'packages/capture-kit/src/snapshot-quality-verdict.ts': 2,

  // --- @agent-device/host-kit ---
  'packages/host-kit/src/archive.ts': 9,
  'packages/host-kit/src/command.ts': 7,
  'packages/host-kit/src/diagnostics.ts': 3,
  'packages/host-kit/src/file.ts': 12,
  'packages/host-kit/src/process.ts': 12,
  'packages/host-kit/src/request.ts': 5,
  'packages/host-kit/src/retry.ts': 6,
  'packages/host-kit/src/version.ts': 4,

  // --- @agent-device/contracts ---
  'packages/contracts/src/alert-contract.ts': 1,
  'packages/contracts/src/android-clipboard-support.ts': 1,
  // Added by #2041 (adb/IME cluster extraction): shared helper-artifact and touch-plan
  // vocabulary moved out of src/platforms/android.
  'packages/contracts/src/android-helper-artifacts.ts': 3,
  'packages/contracts/src/android-touch-plan.ts': 13,
  'packages/contracts/src/android-input-ownership.ts': 1,
  'packages/contracts/src/android-observation.ts': 1,
  'packages/contracts/src/android-snapshot-quality.ts': 1,
  'packages/contracts/src/android-system-chrome.ts': 1,
  'packages/contracts/src/app-deployment-runtime-plan.ts': 3,
  'packages/contracts/src/app-deployment-runtime.ts': 1,
  'packages/contracts/src/app-inventory-runtime.ts': 1,
  'packages/contracts/src/app-log-runtime.ts': 1,
  'packages/contracts/src/app-state-runtime.ts': 1,
  'packages/contracts/src/apple-runner-request.ts': 1,
  'packages/contracts/src/apple-multitouch-support.ts': 6,
  'packages/contracts/src/application-lifecycle-interaction.ts': 7,
  'packages/contracts/src/application-lifecycle-runtime-plan.ts': 3,
  'packages/contracts/src/application-lifecycle-runtime.ts': 1,
  'packages/contracts/src/async-lifecycle.ts': 1,
  'packages/contracts/src/audio-probe-result.ts': 1,
  'packages/contracts/src/audio-probe-runtime.ts': 1,
  'packages/contracts/src/audio-probe-runtime-host.ts': 1,
  'packages/contracts/src/audio-probe-support.ts': 5,
  'packages/contracts/src/audio-runtime-plan.ts': 5,
  'packages/contracts/src/back-mode.ts': 1,
  'packages/contracts/src/boot-failure.ts': 1,
  'packages/contracts/src/click-button.ts': 3,
  'packages/contracts/src/clipboard.ts': 1,
  'packages/contracts/src/command-platform-execution.ts': 2,
  'packages/contracts/src/daemon-owner-cleanup.ts': 1,
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
  'packages/contracts/src/facades/observability.ts': 7,
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
  'packages/contracts/src/gesture-admission.ts': 6,
  'packages/contracts/src/gesture-runtime.ts': 5,
  'packages/contracts/src/gesture-plan.ts': 12,
  'packages/contracts/src/host-diagnostics.ts': 1,
  'packages/contracts/src/interaction.ts': 1,
  'packages/contracts/src/interaction-error.ts': 1,
  'packages/contracts/src/interaction-guarantees.ts': 1,
  'packages/contracts/src/interactor-types.ts': 1,
  'packages/contracts/src/keyboard.ts': 1,
  'packages/contracts/src/logs-runtime-plan.ts': 5,
  'packages/contracts/src/managed-web-backend.ts': 1,
  'packages/contracts/src/navigation.ts': 1,
  'packages/contracts/src/network-runtime-plan.ts': 5,
  'packages/contracts/src/network-runtime.ts': 1,
  'packages/contracts/src/network-traffic.ts': 1,
  'packages/contracts/src/platform-module.ts': 5,
  'packages/contracts/src/platform-plugin.ts': 1,
  'packages/contracts/src/platform-providers.ts': 1,
  'packages/contracts/src/platform-resource-cleanup.ts': 1,
  'packages/contracts/src/platform-runtime-host.ts': 1,
  'packages/contracts/src/platform-runtime-operations.ts': 2,
  'packages/contracts/src/platform-runtime-unavailable.ts': 30,
  'packages/contracts/src/platform-runtime.ts': 6,
  'packages/contracts/src/perf-runtime-host.ts': 1,
  'packages/contracts/src/perf-runtime-operation-builder.ts': 3,
  'packages/contracts/src/perf-runtime-plan.ts': 7,
  'packages/contracts/src/perf-runtime.ts': 1,
  'packages/contracts/src/record-runtime-execution.ts': 7,
  'packages/contracts/src/react-native-overlay.ts': 1,
  'packages/contracts/src/runner-lease-context.ts': 1,
  'packages/contracts/src/screen-recording-runtime-plan.ts': 5,
  'packages/contracts/src/screen-recording-runtime.ts': 1,
  'packages/contracts/src/screen-recording-runtime-host.ts': 1,
  'packages/contracts/src/screenshot-runtime.ts': 4,
  'packages/contracts/src/scroll-command.ts': 3,
  'packages/contracts/src/scroll-gesture.ts': 10,
  'packages/contracts/src/scroll-runtime.ts': 4,
  'packages/contracts/src/selector-observation-runtime.ts': 1,
  'packages/contracts/src/settings.ts': 3,
  'packages/contracts/src/snapshot-presentation.ts': 2,
  'packages/contracts/src/snapshot-runtime.ts': 3,
  'packages/contracts/src/snapshot-timeout-evidence.ts': 1,
  'packages/contracts/src/startup-recovery-fence.ts': 1,
  'packages/contracts/src/tv-remote.ts': 3,
  'packages/contracts/src/type-text-runtime.ts': 4,
  'packages/contracts/src/touch-runtime.ts': 4,
  'packages/contracts/src/viewport-runtime.ts': 1,
  'packages/contracts/src/wait-runtime-plan.ts': 1,
  'packages/contracts/src/wait.ts': 1,

  // --- @agent-device/kernel ---
  'packages/kernel/src/bounds.ts': 1,
  'packages/kernel/src/collections.ts': 1,
  'packages/kernel/src/contracts.ts': 4,
  'packages/kernel/src/device.ts': 4,
  'packages/kernel/src/errors.ts': 2,
  // Added by #2041: keyed async lock moved from src/utils for the extracted IME lifecycle.
  'packages/kernel/src/keyed-lock.ts': 1,
  'packages/kernel/src/rect-center.ts': 2,
  'packages/kernel/src/rect.ts': 1,
  'packages/kernel/src/device-isolation.ts': 1,
  'packages/kernel/src/location-coordinates.ts': 3,
  'packages/kernel/src/record.ts': 3,
  'packages/kernel/src/scoped-provider.ts': 1,
  'packages/kernel/src/source-value.ts': 3,
  'packages/kernel/src/success-text.ts': 1,
  'packages/kernel/src/ttl-memo.ts': 1,
  'packages/kernel/src/redaction.ts': 1,
  'packages/kernel/src/scroll-indicator.ts': 1,
  'packages/kernel/src/snapshot.ts': 1,

  // --- @agent-device/maestro ---
  'packages/maestro/src/index.ts': 106,

  // --- @agent-device/platform-*: ADR-0019's metadata-eager/implementation-lazy façades. Each
  // evaluates only itself; every implementation sits behind a function-scoped `await import`.
  // A pin of 1 is the tightest statement of that property the walker can make.
  'packages/platform-android/src/index.ts': 1,
  // Transitional #2041 subpaths for the extracted adb/IME cluster; the root shims re-export
  // them, so their closures carry what src/platforms/android/adb-executor.ts et al. carried
  // before the move. Deleted together with the shims once the perf/trace migration lands.
  'packages/platform-android/src/adb-executor.ts': 10,
  'packages/platform-android/src/adb-host.ts': 1,
  'packages/platform-android/src/ime-helper.ts': 6,
  'packages/platform-android/src/ime-lifecycle.ts': 17,

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
  'packages/replay-test/src/index.ts': 20,

  // --- @agent-device/selectors ---
  'packages/selectors/src/ast.ts': 16,
  'packages/selectors/src/engine.ts': 19,
  'packages/selectors/src/index.ts': 50,

  // --- @agent-device/xml ---
  'packages/xml/src/index.ts': 3,

  // Added by #1993 (device-inventory context moved out of core).
  'packages/contracts/src/back-runtime.ts': 1,
  // Added by Wave 6 R55/R56/R57/R58/R59: the clipboard, app-switcher, app-event, settings and
  // alert facets,
  // plus the local interaction set Android and Linux used to hold a byte-identical copy of each.
  // The set is its own module rather than part of the interactor catalog so the catalog's closure
  // stays leaf-thin -- every module the set pulls in is one its two consumers already evaluate.
  'packages/contracts/src/alert-runtime.ts': 1,
  'packages/contracts/src/app-event-runtime.ts': 1,
  'packages/contracts/src/app-switcher-runtime.ts': 1,
  'packages/contracts/src/clipboard-runtime.ts': 1,
  'packages/contracts/src/settings-runtime.ts': 1,
  'packages/contracts/src/local-interactor-operation-set.ts': 26,
  'packages/contracts/src/home-runtime.ts': 1,
  'packages/contracts/src/interactor-operation-catalog.ts': 14,
  'packages/contracts/src/keyboard-runtime.ts': 3,
  'packages/contracts/src/orientation-runtime.ts': 1,
  'packages/contracts/src/tv-remote-runtime.ts': 1,
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
  // 363 -> 365 in #2004, which cuts per-invocation work and pays two modules for it:
  // `@agent-device/kernel/ttl-memo` (version.ts now resolves the package version and the project root
  // once per process instead of re-reading package.json several times an invocation) and
  // `src/daemon/client/daemon-launch-spec.ts` (the launch-entry probe, split out of the 726-line
  // daemon-client-lifecycle.ts). Both run on the path every local command already takes, so
  // neither has a lazy seam to hide behind -- unlike `src/daemon/code-signature-cache.ts`, which
  // the same PR added and only a source checkout reaches, and which therefore loads on demand
  // (`resolveLocalDaemonCodeSignature`) rather than appearing here.
  // #2054 splits daemon cleanup and managed web backend into separate neutral contract entries;
  // the CLI already loads both command modules, so the second one-module contract is deliberate.
  // #2027 splits the 705-line `commands/command-input.ts` into the three leaf modules the
  // common-field table needs to exist without an import cycle: `input-readers.ts` (record
  // readers), `input-audience.ts` (who may write a key), and `common-input-fields.ts` (the table
  // itself). Every command schema already evaluated all three concerns; the growth is three more
  // module records for the same code, with no new subtree behind any of them.
  'src/cli.ts': 380,
  'src/platform-runtime.ts': 47,
  'src/core/command-descriptor/registry.ts': 67,
  'src/core/command-descriptor/platform-execution-entry.ts': 3,
  'src/core/interactors/register-builtins.ts': 6,
  // R64 removes the perf plugin facet and keeps collector binding behind the selected runtime
  // operation. Teardown now owns only neutral durable-resource cleanup; platform collectors load
  // through the perf host when an admitted operation actually runs.
  'src/daemon/session-teardown.ts': 68,
});

/**
 * The runner mechanics facet inside platform-apple (#2040). Its entry surfaces
 * ARE platform implementation, so the deny-platform assertion is meaningless
 * for them the same way it would be vacuous for a platform façade without the
 * entry-self-exclusion: the whole closure is the mechanics being exported.
 * Their weight stays pinned by the exact budgets.
 */
const PLATFORM_MECHANICS_ENTRY_PREFIX = 'packages/platform-apple/src/runner/';

/**
 * Transitional #2041 entry surfaces: the extracted Android adb/IME cluster. Unlike the six
 * metadata-eager family façades, these subpaths ARE concrete platform implementation — the root
 * shims re-export them wholesale, exactly as the pre-extraction src modules loaded. They cannot
 * satisfy "evaluates none of its own mechanics"; their rows above pin the closure size instead.
 * Deleted together with the shims and subpaths once the perf/trace migration lands.
 */
const TRANSITIONAL_PLATFORM_IMPLEMENTATION_SURFACES: ReadonlySet<string> = new Set([
  'packages/platform-android/src/adb-executor.ts',
  'packages/platform-android/src/adb-host.ts',
  'packages/platform-android/src/ime-helper.ts',
  'packages/platform-android/src/ime-lifecycle.ts',
]);

function toRows(
  budgets: Readonly<Record<string, number>>,
  kind: 'facade' | 'hub',
): EagerClosureBudget[] {
  return Object.entries(budgets).map(([entryFile, budget]) => ({
    id: entryFile,
    entryFile,
    budget,
    kind,
    denyPlatformImplementations:
      kind === 'facade' &&
      !entryFile.startsWith(PLATFORM_MECHANICS_ENTRY_PREFIX) &&
      !TRANSITIONAL_PLATFORM_IMPLEMENTATION_SURFACES.has(entryFile),
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
