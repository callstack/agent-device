// Derived, fail-open check selector for `pnpm check:affected --base <ref>`.
//
// The model turns a set of changed paths into a plan of local checks with
// stable, machine-readable reasoning. It is intentionally source-of-truth
// derived rather than a hand-maintained path-to-check registry (issue #1181):
//
//   - Vitest owns affected-test discovery through its native `related`
//     command and static module graph; this model only decides when that
//     existing tool applies;
//   - the lint/typecheck/layering/fallow gates are always-on for their input
//     categories, so they are never silently skipped (issue constraint);
//   - a small explicit build-ownership layer covers Swift, Android helpers,
//     the macOS helper, MCP metadata, and the public package surface — the
//     only paths whose owning build the sources of truth cannot derive.
//
// Anything the model cannot confidently classify fails open to the full check
// set: unknown paths, workflow/tooling, the selector's own sources, and
// ambiguous files under an owned root that only resolve to `format` (e.g. a
// non-.ts fixture whose owning suite cannot be derived). Existing GitHub CI
// remains authoritative; this only optimizes local/agent feedback.

import { WIRE_SURFACE_FILES } from '../../test/wire-compat/surface.ts';
import { deviceLaneOwnership } from './device-lanes.ts';

// The canonical gate universe. Every gate CI runs is one of these — including the
// ones that drive their own runner (fuzz, mutation, the Maestro differential) and
// the command-reference docs gate, which used to be reachable only as a workflow
// job nothing in this repo could name. The run-gate action is the only way a CI lane
// declares ownership, so `check:gate-manifest` fails when a registered check has no lane.
// Raw shell earns no ownership credit.
export type CheckId =
  | 'format'
  | 'lint'
  | 'typecheck'
  | 'test-app-typecheck'
  | 'layering'
  | 'di-seams'
  | 'fallow'
  | 'mcp-metadata'
  | 'build'
  | 'package'
  | 'vitest-related'
  | 'unit'
  | 'unit-ci'
  | 'coverage'
  | 'provider-integration'
  | 'integration-node'
  | 'macos-coverage'
  | 'integration-progress'
  | 'swift-runner-ios'
  | 'swift-runner-macos'
  | 'android-helpers'
  | 'macos-helper'
  | 'web-smoke'
  | 'replay-compat'
  | 'daemon-wire-compat'
  // Tooling gates: each proves one of the checkers above still behaves.
  | 'affected-selector'
  | 'gate-manifest'
  | 'gate-manifest-model'
  | 'depgraph'
  | 'tmpdir-leaks'
  | 'tmpdir-leaks-model'
  | 'coverage-model'
  | 'wire-compat-model'
  | 'production-exports'
  | 'bundle-owner-files'
  | 'freerange'
  | 'fixture-cache'
  | 'fixture-fallback'
  | 'command-docs'
  | 'agent-guidance'
  | 'xctest-selection'
  // Gates that drive their own runner — declared nowhere, registered here.
  | 'maestro-conformance'
  | 'maestro-differential'
  | 'maestro-regenerate'
  | 'fuzz-parsers'
  | 'mutation'
  | 'mutation-affected'
  | 'mutation-check'
  | 'mutation-model'
  | 'concurrency-torture'
  | 'replay-ios'
  | 'replay-ios-device'
  | 'replay-macos'
  | 'replay-linux'
  | 'linux-command-evidence'
  | 'replay-android';

// The complete local check universe. A fail-open plan selects all of these;
// keep it in sync with the catalog in checks.ts (asserted by the self-test).
export const ALL_CHECKS: readonly CheckId[] = [
  'format',
  'lint',
  'typecheck',
  'test-app-typecheck',
  'layering',
  'di-seams',
  'fallow',
  'mcp-metadata',
  'build',
  'package',
  // Real daemon/process integration owns host-global lifecycle state and must
  // run before the related-project workload heats the host.
  'integration-node',
  'macos-coverage',
  'vitest-related',
  'unit',
  'unit-ci',
  'coverage',
  'provider-integration',
  'integration-progress',
  'swift-runner-ios',
  'swift-runner-macos',
  'android-helpers',
  'macos-helper',
  'web-smoke',
  'replay-compat',
  'daemon-wire-compat',
  'affected-selector',
  'gate-manifest',
  'gate-manifest-model',
  'depgraph',
  'tmpdir-leaks',
  'tmpdir-leaks-model',
  'coverage-model',
  'wire-compat-model',
  'production-exports',
  'bundle-owner-files',
  'freerange',
  'fixture-cache',
  'fixture-fallback',
  'command-docs',
  'agent-guidance',
  'xctest-selection',
  'maestro-conformance',
  'maestro-differential',
  'maestro-regenerate',
  'fuzz-parsers',
  'mutation',
  'mutation-affected',
  'mutation-check',
  'mutation-model',
  'concurrency-torture',
  'replay-ios',
  'replay-ios-device',
  'replay-macos',
  'replay-linux',
  'linux-command-evidence',
  'replay-android',
];

export type SelectionReason = {
  check: CheckId;
  path: string;
  rule: string;
  detail: string;
};

export type FailOpenReason = {
  path: string;
  rule: 'workflow-tooling' | 'selector-owning' | 'unknown-path' | 'ambiguous-path';
  detail: string;
};

export type CheckPlan = {
  failOpen: boolean;
  checks: CheckId[];
  reasons: SelectionReason[];
  failOpenReasons: FailOpenReason[];
  docsOnlyPaths: string[];
};

export type SelectInput = {
  changedFiles: readonly string[];
  // Public package entry source files, derived from package.json `exports`.
  packageEntryFiles?: readonly string[];
};

// --- Path classification helpers -------------------------------------------
const ROOT_TOOLING = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.lib.json',
  'tsdown.config.ts',
  'vitest.config.ts',
  '.fallowrc.json',
  'oxlint.config.ts',
  '.oxfmtrc.json',
  '.npmrc',
]);

function isSelectorOwning(file: string): boolean {
  return file.startsWith('scripts/check-affected/') && !file.endsWith('.md');
}

function isWorkflowTooling(file: string): boolean {
  // A workspace package manifest or tsconfig rewires module resolution for
  // every consumer, so it fails open like root tooling does.
  const packageTooling = /^packages\/[^/]+\/(?:package\.json|tsconfig\.json)$/.test(file);
  return (
    file.startsWith('.github/') ||
    file.startsWith('scripts/') ||
    packageTooling ||
    ROOT_TOOLING.has(file)
  );
}

export function isDocs(file: string): boolean {
  // skills/ Markdown is agent guidance prose with no owning suite (the
  // SkillGym harness was removed), so it classifies as docs like the rest.
  return (
    file.startsWith('docs/') ||
    file.startsWith('website/') ||
    file === 'README.md' ||
    file === 'LICENSE' ||
    file.endsWith('.md')
  );
}

function isTestPath(file: string): boolean {
  return /\.test\.ts$/.test(file) || /(?:^|\/)__tests__\//.test(file);
}

// --- Ownership rules --------------------------------------------------------
// Each rule inspects one changed file and returns the reasons it contributes.
// Splitting the selection into small, independent rules keeps every function
// simple and makes the derivation self-documenting.
type FileFacts = {
  file: string;
  isTs: boolean;
  underSrc: boolean;
  underTest: boolean;
  isSrcProd: boolean;
};

type OwnershipRule = (facts: FileFacts, input: SelectInput) => SelectionReason[];

function reason(check: CheckId, file: string, rule: string, detail: string): SelectionReason {
  return { check, path: file, rule, detail };
}

const formatGate: OwnershipRule = ({ file, underSrc, underTest }) =>
  underSrc || underTest
    ? [reason('format', file, 'gate:format', 'oxfmt covers src/ and test/')]
    : [];

const staticTsGates: OwnershipRule = ({ file, isTs, underSrc, underTest }) =>
  isTs && (underSrc || underTest)
    ? [
        reason('lint', file, 'gate:lint', 'oxlint covers the source tree'),
        reason('typecheck', file, 'gate:typecheck', 'tsc includes src/ and test/'),
        reason('fallow', file, 'gate:fallow', 'fallow audits changed TypeScript for dead code'),
      ]
    : [];

const srcProdGate: OwnershipRule = ({ file, isSrcProd }) => {
  if (!isSrcProd) return [];
  return [
    reason('layering', file, 'gate:layering', 'layering guard reads production src/ modules'),
    reason('build', file, 'src-prod', 'production source is compiled by the build'),
  ];
};

function isNodeIntegrationPath(file: string): boolean {
  return (
    file.startsWith('test/integration/') &&
    !file.slice('test/integration/'.length).includes('/') &&
    file.endsWith('.ts')
  );
}

const vitestRelatedOwnership: OwnershipRule = ({ file, isTs, underSrc, underTest }) =>
  isTs && (underSrc || underTest) && !isNodeIntegrationPath(file)
    ? [
        reason(
          'vitest-related',
          file,
          'vitest:related',
          'Vitest resolves affected tests through its static module graph',
        ),
      ]
    : [];

// Workspace package source (#1490 W0): bundled into the published artifact,
// type-checked in the root graph, covered by Vitest's module graph, and
// guarded by layering R11. Fallow scans it too — the W0 ignorePatterns entry
// claimed its resolver could not follow workspace specifiers, which stopped
// being true (it resolves @agent-device/* through each exports map), so an
// extraction into packages/ no longer takes its own dead code out of scope.
const workspacePackageOwnership: OwnershipRule = ({ file, isTs }) => {
  if (!isTs || !/^packages\/[^/]+\/src\//.test(file)) return [];
  const selections = [
    reason('format', file, 'gate:format', 'oxfmt covers packages/'),
    reason('lint', file, 'gate:lint', 'oxlint covers packages/'),
    reason('typecheck', file, 'gate:typecheck', 'tsc includes packages/'),
    reason('fallow', file, 'gate:fallow', 'fallow audits changed TypeScript for dead code'),
    reason('layering', file, 'package-src', 'layering R11 guards workspace package boundaries'),
    reason(
      'vitest-related',
      file,
      'vitest:related',
      'Vitest resolves affected tests through its static module graph',
    ),
  ];
  if (!isTestPath(file)) {
    selections.push(
      reason('build', file, 'package-src', 'package source is bundled into the published artifact'),
    );
  }
  return selections;
};

const platformPackageScenarioOwnership: OwnershipRule = ({ file, isTs }) => {
  if (!isTs || !/^packages\/platform-[^/]+\/src\//.test(file)) {
    return [];
  }
  return [
    reason(
      'unit',
      file,
      'platform-package-contract',
      'platform packages must satisfy the shared runtime contract scenarios',
    ),
    reason(
      'provider-integration',
      file,
      'platform-package-provider',
      'platform packages participate in provider-first ownership scenarios',
    ),
    reason(
      'coverage',
      file,
      'platform-package-coverage',
      'platform package changes require affected contract coverage evidence',
    ),
  ];
};

const nodeIntegrationOwnership: OwnershipRule = ({ file }) =>
  isNodeIntegrationPath(file)
    ? [reason('integration-node', file, 'node-integration', 'node --test integration smoke')]
    : [];

const macosCoverageOwnership: OwnershipRule = ({ file }) =>
  file === 'test/integration/smoke-macos-coverage.test.ts' ||
  file.startsWith('test/integration/macos-e2e/')
    ? [
        reason(
          'macos-coverage',
          file,
          'own:macos-coverage',
          'the macOS lane executes the command coverage manifest contract',
        ),
      ]
    : [];

const testAppOwnership: OwnershipRule = ({ file }) => {
  if (!file.startsWith('examples/test-app/')) return [];
  if (!/\.(?:[cm]?[jt]sx?|json)$/.test(file)) return [];
  return [
    reason('format', file, 'gate:format', 'oxfmt covers the Expo test app'),
    reason('lint', file, 'gate:lint', 'oxlint covers the Expo test app'),
    reason(
      'test-app-typecheck',
      file,
      'own:test-app',
      'the Expo test app has an isolated TypeScript dependency graph',
    ),
  ];
};

// The frozen replay-compat corpus (#1417). `.ad` fixture data would otherwise
// fail open on its extension: its only consumer is the unit-lane corpus test.
// Any corpus change — script or manifest — also runs the history-backed
// provenance verifier, which is the only gate that can prove an entry's blob
// really came from the release tag it names.
const replayCompatOwnership: OwnershipRule = ({ file }) => {
  if (!file.startsWith('test/replay-compat/')) return [];
  const selections = [
    reason(
      'replay-compat',
      file,
      'own:replay-compat-provenance',
      'corpus provenance is re-derived from released git blobs',
    ),
  ];
  if (file.endsWith('.ad')) {
    selections.push(
      reason(
        'unit',
        file,
        'own:replay-compat',
        'frozen replay-compat corpus is asserted by the unit-lane corpus test',
      ),
    );
  }
  return selections;
};

// The daemon RPC wire ledger (#1432). The wire SOURCE files are the ones that
// would otherwise slip: editing `packages/kernel/src/contracts.ts` selects
// vitest-related, but the wire gate reads that file as TEXT rather than
// importing it, so it is invisible to the module graph Vitest walks. The file
// list is read from the manifest instead of restated here, so a declaration
// added under a new file selects the gate the day it is listed.
//
// `ledger.json` needs the rule for the second reason `.ad` corpus data does:
// a non-.ts file under test/ resolves to `format` alone and would fail open.
// (`scripts/wire-compat/` needs no branch — all of scripts/ already fails open.)
const daemonWireCompatOwnership: OwnershipRule = ({ file }) => {
  if (!file.startsWith('test/wire-compat/') && !WIRE_SURFACE_FILES.includes(file)) return [];
  return [
    reason(
      'daemon-wire-compat',
      file,
      'own:daemon-wire-compat',
      'the wire ledger is compared against the last released tag',
    ),
    reason(
      'unit',
      file,
      'own:daemon-wire-compat',
      'the wire ledger is held to its source by the unit-lane gate',
    ),
  ];
};

const BUILD_OWNERSHIP: ReadonlyArray<{
  check: CheckId;
  rule: string;
  detail: string;
  owns: (file: string) => boolean;
}> = [
  // Both platform builds compile the same runner sources, and each is a separate
  // gate in a separate lane, so a Swift change owns both.
  {
    check: 'swift-runner-ios',
    rule: 'own:swift',
    detail: 'Swift runner sources require the iOS XCUITest build',
    owns: (file) => file.startsWith('apple/runner/') || file.endsWith('.swift'),
  },
  {
    check: 'swift-runner-macos',
    rule: 'own:swift',
    detail: 'Swift runner sources require the macOS XCUITest build',
    owns: (file) => file.startsWith('apple/runner/') || file.endsWith('.swift'),
  },
  // The PR lane names each runner XCTest method it runs, so renaming or deleting one
  // silently shrinks that lane. Selected here so the drift shows up on the change that
  // causes it rather than on the next nightly.
  {
    check: 'xctest-selection',
    rule: 'own:xctest-selection',
    detail: 'runner test methods must stay selected in CI and stripped from the npm source bundle',
    owns: (file) => file.startsWith('apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/'),
  },
  {
    check: 'android-helpers',
    rule: 'own:android-helpers',
    detail: 'Android helper packages have their own build',
    owns: (file) =>
      file.startsWith('android/snapshot-helper/') || file.startsWith('android/ime-helper/'),
  },
  {
    check: 'unit',
    rule: 'own:android-package-test-fixture',
    detail: 'the Android package test fixture is consumed by the unit suite',
    owns: (file) =>
      file ===
      'packages/platform-android/src/__tests__/test-utils/fixtures/android-helper-apk.fixture',
  },
  {
    check: 'macos-helper',
    rule: 'own:macos-helper',
    detail: 'macOS helper is a separate Swift package build',
    owns: (file) => file.startsWith('apple/macos-helper/'),
  },
  {
    check: 'mcp-metadata',
    rule: 'own:mcp',
    detail: 'MCP registry metadata must stay in sync',
    owns: (file) => file === 'server.json' || file === 'smithery.yaml',
  },
  // TS/Swift golden tables (`contracts/fixtures/*.json`): the vitest parity test and the
  // runner XCTest twin both read them, so a table edit owns the unit lane and both runner
  // builds. Without this a `.json` under contracts/ has no derivable owner and fails open.
  {
    check: 'unit',
    rule: 'own:golden-table',
    detail: 'the vitest parity twin asserts the TS rule against the golden table',
    owns: (file) => file.startsWith('contracts/fixtures/'),
  },
  {
    check: 'swift-runner-ios',
    rule: 'own:golden-table',
    detail: 'the runner XCTest twin asserts the Swift rule against the golden table',
    owns: (file) => file.startsWith('contracts/fixtures/'),
  },
  {
    check: 'swift-runner-macos',
    rule: 'own:golden-table',
    detail: 'the runner XCTest twin asserts the Swift rule against the golden table',
    owns: (file) => file.startsWith('contracts/fixtures/'),
  },
];

const buildOwnership: OwnershipRule = ({ file }, input) => {
  const selections = BUILD_OWNERSHIP.filter((entry) => entry.owns(file)).map((entry) =>
    reason(entry.check, file, entry.rule, entry.detail),
  );
  if ((input.packageEntryFiles ?? []).includes(file)) {
    selections.push(
      reason('build', file, 'own:public-surface', 'public package entry affects declarations'),
      reason(
        'package',
        file,
        'own:public-surface',
        'a public entry must still resolve from a clean install',
      ),
    );
  }
  return selections;
};

// Docs with an owning gate (#1420). Most Markdown has no suite, but these files
// carry executable contracts and must reach their focused workflow even when the
// main CI workflow ignores documentation.
const COMMAND_DOCS = 'website/docs/docs/commands.md';
const AGENT_GUIDANCE = new Set(['AGENTS.md', 'CONTEXT.md']);

function isAgentGuidance(file: string): boolean {
  return AGENT_GUIDANCE.has(file) || file.startsWith('docs/agents/');
}

const docsOwnership: OwnershipRule = ({ file }) =>
  isAgentGuidance(file)
    ? [
        reason(
          'agent-guidance',
          file,
          'own:agent-guidance',
          'agent guidance is held to glossary, routing, and context-budget contracts',
        ),
      ]
    : file === COMMAND_DOCS
      ? [
          reason(
            'command-docs',
            file,
            'own:command-docs',
            'the command reference is asserted against the CLI in both directions',
          ),
        ]
      : [];

// Live device lanes, by platform family (device-lanes.ts). Selected here alongside the
// static gates so a TypeScript-only Apple change carries its iOS/macOS lanes in the plan.
const deviceLaneRule: OwnershipRule = ({ file }) => deviceLaneOwnership(file);

const OWNERSHIP_RULES: readonly OwnershipRule[] = [
  formatGate,
  staticTsGates,
  srcProdGate,
  vitestRelatedOwnership,
  workspacePackageOwnership,
  platformPackageScenarioOwnership,
  nodeIntegrationOwnership,
  macosCoverageOwnership,
  testAppOwnership,
  replayCompatOwnership,
  daemonWireCompatOwnership,
  buildOwnership,
  deviceLaneRule,
];

function fileFacts(file: string): FileFacts {
  const isTs = file.endsWith('.ts') && !file.endsWith('.d.ts');
  const underSrc = file.startsWith('src/');
  return {
    file,
    isTs,
    underSrc,
    underTest: file.startsWith('test/'),
    isSrcProd: underSrc && isTs && !isTestPath(file),
  };
}

function failOpenFor(file: string): FailOpenReason | null {
  if (isSelectorOwning(file)) {
    return {
      path: file,
      rule: 'selector-owning',
      detail: 'change to the affected-check selector cannot be trusted to select itself',
    };
  }
  if (isWorkflowTooling(file)) {
    return {
      path: file,
      rule: 'workflow-tooling',
      detail: 'workflow/tooling change can alter any gate',
    };
  }
  return null;
}

// --- Selection --------------------------------------------------------------
export function selectChecks(input: SelectInput): CheckPlan {
  const reasons: SelectionReason[] = [];
  const failOpenReasons: FailOpenReason[] = [];
  const docsOnlyPaths: string[] = [];

  for (const file of input.changedFiles) {
    const failOpen = failOpenFor(file);
    if (failOpen) {
      failOpenReasons.push(failOpen);
      continue;
    }
    if (isDocs(file)) {
      const owned = docsOwnership(fileFacts(file), input);
      if (owned.length === 0) {
        docsOnlyPaths.push(file);
        continue;
      }
      reasons.push(...owned);
      continue;
    }
    const facts = fileFacts(file);
    const selections = OWNERSHIP_RULES.flatMap((rule) => rule(facts, input));
    if (selections.length === 0) {
      failOpenReasons.push({
        path: file,
        rule: 'unknown-path',
        detail: 'path has no derivable owner; run the full set to stay safe',
      });
      continue;
    }
    // `format` is an always-on gate, not evidence of test/build ownership. A
    // file we can only route to formatting (e.g. a non-.ts fixture under
    // test/) has no derivable suite owner, so treat it as ambiguous and fail
    // open rather than silently narrowing to just `format`.
    if (!selections.some((selection) => selection.check !== 'format')) {
      failOpenReasons.push({
        path: file,
        rule: 'ambiguous-path',
        detail: 'only formatting is derivable; no test/build owner, so run the full set',
      });
      continue;
    }
    reasons.push(...selections);
  }

  if (failOpenReasons.length > 0) {
    return { failOpen: true, checks: [...ALL_CHECKS], reasons, failOpenReasons, docsOnlyPaths };
  }
  const selected = new Set(reasons.map((entry) => entry.check));
  return {
    failOpen: false,
    checks: ALL_CHECKS.filter((check) => selected.has(check)),
    reasons,
    failOpenReasons,
    docsOnlyPaths,
  };
}
