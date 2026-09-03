// The canonical gate registry: every check this repo can run, and how to run it.
//
// One entry per gate, and one universe — the affected-selector's vocabulary and
// the set of gates CI runs are the same list, because CI may only invoke a gate
// through the structural run-gate action. That lets the manifest derive the
// workflow→check mapping from YAML fields without interpreting shell.
//
// The jobs that run a check are NOT recorded here. They are derived from the
// workflows by scripts/gate/model.ts, so the "GitHub-authoritative" claim an
// agent reads before skipping a check locally cannot go stale.

import { ALL_CHECKS, type CheckId } from './model.ts';
import { DEFAULT_VITEST_MAX_WORKERS } from '../lib/vitest-concurrency.ts';

export type CheckKind =
  | { readonly type: 'script'; readonly script: string }
  | { readonly type: 'vitest-related' };

export type CheckSpec = {
  readonly id: CheckId;
  readonly label: string;
  readonly kind: CheckKind;
  // Whether `--run` should attempt the check locally. Device/emulator lanes,
  // network/toolchain-gated lanes, long scheduled sweeps (mutation, fuzz,
  // torture), and the instrumented coverage run stay authoritative on
  // GitHub CI.
  readonly localRunnable: boolean;
};

function gate(id: CheckId, label: string, script: string, localRunnable = true): CheckSpec {
  return { id, label, kind: { type: 'script', script }, localRunnable };
}

export const CHECK_CATALOG: readonly CheckSpec[] = [
  gate('format', 'Formatting (oxfmt)', 'format:check'),
  gate('lint', 'Lint (oxlint)', 'lint'),
  gate('typecheck', 'Typecheck (tsc)', 'typecheck'),
  // The test app intentionally owns a separate Expo dependency graph. Do not
  // make every root-checkout validation install it implicitly.
  gate('test-app-typecheck', 'Expo test app typecheck', 'test-app:typecheck', false),
  gate(
    'test-app-security',
    'Expo test app image-size parser security test',
    'test-app:security',
    false,
  ),
  gate('layering', 'Import-direction layering guard', 'check:layering'),
  gate('di-seams', 'Test-only DI seam guard', 'check:di-seams'),
  gate('fallow', 'Fallow code-quality audit', 'check:fallow'),
  gate('mcp-metadata', 'MCP registry metadata sync', 'check:mcp-metadata'),
  gate('build', 'Build (tsdown + declarations)', 'build'),
  gate('package', 'Published package (publint, attw, clean-install resolution)', 'check:package'),
  gate('integration-node', 'Node integration smoke', 'test:integration:node'),
  gate('macos-coverage', 'macOS command coverage manifest', 'test:integration:macos-coverage'),
  gate(
    'ios-snapshot-differential',
    'iOS snapshot Swift/TypeScript differential',
    'test:ios-snapshot-differential',
    false,
  ),
  {
    id: 'vitest-related',
    label: 'Tests related by Vitest module graph',
    kind: { type: 'vitest-related' },
    localRunnable: true,
  },
  gate('unit', 'Unit + smoke suite', 'check:unit'),
  // CI owns the default coverage run; the scripts remain available for explicit local diagnosis.
  gate('coverage', 'Changed-line coverage', 'check:coverage-changed', false),
  gate('provider-integration', 'Provider-backed integration suite', 'test:integration:provider'),
  gate(
    'integration-progress',
    'Integration architecture-progress gate',
    'test:integration:progress:check',
  ),
  gate('swift-runner-ios', 'Swift runner build (iOS)', 'build:xcuitest:ios', false),
  gate('swift-runner-macos', 'Swift runner build (macOS)', 'build:xcuitest:macos', false),
  // `build:android`, not `build:android-snapshot-helper`: the Android lane needs both
  // helpers packaged into `android/*/dist` (what the replay host verifies), where the
  // build script writes only the snapshot helper into `.tmp/`.
  gate('android-helpers', 'Android helper builds (snapshot + IME)', 'build:android', false),
  gate('macos-helper', 'macOS helper build', 'build:macos-helper', false),
  gate('web-smoke', 'Live web platform smoke', 'test:smoke:web', false),
  // Needs full history and tags, so it runs in the shared fetch-depth: 0 job
  // rather than inside the shallow-clone-safe unit lane.
  gate('replay-compat', 'Replay-compat corpus provenance (released blobs)', 'check:replay-compat'),
  gate(
    'daemon-wire-compat',
    'Daemon RPC wire surface vs. last released tag',
    'check:daemon-wire-compat',
  ),

  // --- Tooling gates ---------------------------------------------------------
  // Each proves one of the checkers above still behaves. They were always real CI
  // steps; before the registry became canonical, nothing in the repo could name
  // them, so nothing could ask whether they still ran.
  //
  // `unit-ci` is the CI form of the unit suite under coverage. Local affected checks use Vitest's
  // related graph without instrumentation; CI owns the full coverage run and changed-line verdict.
  gate('unit-ci', 'CI unit suite under coverage', 'test:coverage:ci', false),
  gate('affected-selector', 'Affected-check selector model', 'check:affected:test'),
  gate('gate-manifest', 'Gate manifest — every gate owned and wired', 'check:gate-manifest'),
  gate('gate-manifest-model', 'Gate manifest model', 'check:gate-manifest:test'),
  gate('depgraph', 'Dependency graph report model', 'depgraph:test'),
  gate('tmpdir-leaks', 'Leaked test tmpdir detector', 'check:tmpdir-leaks'),
  gate('tmpdir-leaks-model', 'TMPDIR redirection model', 'check:tmpdir-leaks:test'),
  gate('coverage-model', 'Changed-line coverage model', 'check:coverage-changed:test'),
  gate('wire-compat-model', 'Wire-compat rules model', 'check:daemon-wire-compat:test'),
  gate('production-exports', 'Production-unused exports', 'check:production-exports'),
  gate('bundle-owner-files', 'Bundle owner-file manifest', 'check:bundle-owner-files'),
  // Not locally runnable: the audit takes ~90s, more than the pre-push affected
  // path should pay on every scripts/** edit. It runs on plain Node; CI needs
  // no runtime beyond the default toolchain.
  gate('freerange', 'Numeric range audit', 'check:freerange', false),
  gate('fixture-cache', 'Trusted fixture-artifact selection', 'test:fixture-cache'),
  gate('fixture-fallback', 'Fixture-app cache-failure fallback', 'test:fixture-fallback'),
  gate('command-docs', 'Command reference doc coverage', 'check:command-docs'),
  gate('agent-guidance', 'Agent guidance ownership and context budgets', 'check:agent-guidance'),
  // Parses ios.yml and the Swift sources; no Xcode, no simulator, so it runs anywhere.
  gate(
    'xctest-selection',
    'Runner XCTest selection and package-source boundary',
    'check:xctest-selection',
  ),

  // --- Gates that drive their own runner -------------------------------------
  // The ones no naming convention could find: an executable terminal for
  // `scripts/fuzz/run.ts` and one for `scripts/size-report.mjs` are the same
  // shape, and only one of them can fail a build. Registering them is what tells
  // the two apart, and `pnpm gate` is what keeps the registration load-bearing —
  // delete an entry and its lane stops resolving, instead of the suite quietly
  // leaving the universe.
  gate('maestro-conformance', 'Maestro conformance fixtures', 'maestro:conformance'),
  gate(
    'maestro-differential',
    'Maestro differential oracle',
    'maestro:conformance:differential',
    false,
  ),
  gate(
    'maestro-regenerate',
    'Maestro fixture regeneration is a no-op',
    'maestro:conformance:regenerate',
    false,
  ),
  gate('fuzz-parsers', 'Parser fuzz invariants', 'fuzz:parsers', false),
  gate('mutation', 'Mutation sweep', 'mutation:run', false),
  gate('mutation-affected', 'Affected mutation shard selection', 'mutation:affected', false),
  gate('mutation-check', 'Mutation score for an existing report', 'mutation:check', false),
  gate('mutation-model', 'Mutation harness self-test', 'mutation:test'),
  gate(
    'concurrency-torture',
    'Session/lease/lock torture sweep',
    'test:concurrency-torture',
    false,
  ),
  gate('replay-ios', 'iOS simulator replay suite', 'test:replay:ios', false),
  gate('replay-ios-device', 'iOS physical device replay suite', 'test:replay:ios-device', false),
  gate('replay-macos', 'macOS replay suite', 'test:replay:macos', false),
  gate('replay-linux', 'Linux replay suite', 'test:replay:linux', false),
  gate(
    'linux-command-evidence',
    'Linux command evidence suite',
    'test:linux:command-evidence',
    false,
  ),
  gate('replay-android', 'Android replay suite', 'test:replay:android', false),
];

export function getCheckSpec(id: CheckId): CheckSpec {
  const spec = CHECK_CATALOG.find((entry) => entry.id === id);
  if (!spec) throw new Error(`No catalog entry for check "${id}".`);
  return spec;
}

// Resolve the runnable command for a check. Script-backed checks are validated
// against package.json so a renamed/removed script fails loudly instead of
// silently skipping a gate. `fallow` threads the same --base the audit uses.
export function resolveCommand(
  spec: CheckSpec,
  scripts: Readonly<Record<string, string>>,
  base: string,
  changedFiles: readonly string[] = [],
): string[] {
  if (spec.kind.type === 'vitest-related') {
    return [
      'pnpm',
      'exec',
      'vitest',
      'related',
      '--run',
      '--passWithNoTests',
      `--maxWorkers=${DEFAULT_VITEST_MAX_WORKERS}`,
      ...changedFiles,
    ];
  }
  const { script } = spec.kind;
  if (!(script in scripts)) {
    throw new Error(
      `Check "${spec.id}" references package.json script "${script}", which does not exist.`,
    );
  }
  const command = ['pnpm', 'run', script];
  if (spec.id === 'fallow') command.push('--base', base);
  return command;
}

// Guard: the catalog must cover exactly the CheckId universe. The self-test
// asserts this so a new check cannot ship half-wired.
export function assertCatalogComplete(): void {
  const catalogIds = new Set(CHECK_CATALOG.map((entry) => entry.id));
  const missing = ALL_CHECKS.filter((id) => !catalogIds.has(id));
  const extra = CHECK_CATALOG.filter((entry) => !ALL_CHECKS.includes(entry.id)).map((e) => e.id);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Check catalog out of sync with ALL_CHECKS. Missing: [${missing.join(', ')}]; ` +
        `extra: [${extra.join(', ')}].`,
    );
  }
}
