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
//     only paths whose owning build the sources of truth cannot derive;
//   - SkillGym owns skill guidance (`skills/`) and its harness
//     (`test/skillgym/`): those changes select the SkillGym suite, and their
//     Markdown is skill/harness input, not inert docs.
//
// Anything the model cannot confidently classify fails open to the full check
// set: unknown paths, workflow/tooling, the selector's own sources, and
// ambiguous files under an owned root that only resolve to `format` (e.g. a
// non-.ts fixture whose owning suite cannot be derived). Existing GitHub CI
// remains authoritative; this only optimizes local/agent feedback.

export type CheckId =
  | 'format'
  | 'lint'
  | 'typecheck'
  | 'layering'
  | 'fallow'
  | 'mcp-metadata'
  | 'build'
  | 'vitest-related'
  | 'unit'
  | 'coverage'
  | 'provider-integration'
  | 'integration-node'
  | 'integration-progress'
  | 'swift-runner'
  | 'android-helpers'
  | 'macos-helper'
  | 'web-smoke'
  | 'skillgym';

// The complete local check universe. A fail-open plan selects all of these;
// keep it in sync with the catalog in checks.ts (asserted by the self-test).
export const ALL_CHECKS: readonly CheckId[] = [
  'format',
  'lint',
  'typecheck',
  'layering',
  'fallow',
  'mcp-metadata',
  'build',
  'vitest-related',
  'unit',
  'coverage',
  'provider-integration',
  'integration-node',
  'integration-progress',
  'swift-runner',
  'android-helpers',
  'macos-helper',
  'web-smoke',
  'skillgym',
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
  '.oxlintrc.json',
  '.oxfmtrc.json',
  '.npmrc',
]);

function isSelectorOwning(file: string): boolean {
  return (
    file === 'AGENTS.md' || (file.startsWith('scripts/check-affected/') && !file.endsWith('.md'))
  );
}

function isWorkflowTooling(file: string): boolean {
  return file.startsWith('.github/') || file.startsWith('scripts/') || ROOT_TOOLING.has(file);
}

function isDocs(file: string): boolean {
  // skills/ and the SkillGym harness are validated by the SkillGym suite (and
  // formatting), not treated as inert docs — even their Markdown is skill
  // guidance or harness input, so let them flow to ownership rules instead.
  if (file.startsWith('skills/') || file.startsWith('test/skillgym/')) return false;
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
  underSkills: boolean;
  isSrcProd: boolean;
};

type OwnershipRule = (facts: FileFacts, input: SelectInput) => SelectionReason[];

function reason(check: CheckId, file: string, rule: string, detail: string): SelectionReason {
  return { check, path: file, rule, detail };
}

const formatGate: OwnershipRule = ({ file, underSrc, underTest, underSkills }) =>
  underSrc || underTest || underSkills
    ? [reason('format', file, 'gate:format', 'oxfmt covers src/, test/, and skills/')]
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
  const selections = [
    reason('layering', file, 'gate:layering', 'layering guard reads production src/ modules'),
    reason('build', file, 'src-prod', 'production source is compiled by the build'),
  ];
  if (file.startsWith('src/platforms/')) {
    selections.push(
      reason(
        'provider-integration',
        file,
        'platform-src',
        'platform source shapes device/provider wire behavior',
      ),
      reason(
        'coverage',
        file,
        'platform-src',
        'Testing Matrix requires coverage for platform/device-response changes',
      ),
    );
  }
  return selections;
};

function isNodeIntegrationPath(file: string): boolean {
  return (
    file.startsWith('test/integration/') &&
    !file.slice('test/integration/'.length).includes('/') &&
    file.endsWith('.ts')
  );
}

const vitestRelatedOwnership: OwnershipRule = ({ file, isTs, underSrc, underTest }) =>
  isTs &&
  (underSrc || underTest) &&
  !isNodeIntegrationPath(file) &&
  !file.startsWith('test/skillgym/')
    ? [
        reason(
          'vitest-related',
          file,
          'vitest:related',
          'Vitest resolves affected tests through its static module graph',
        ),
      ]
    : [];

const nodeIntegrationOwnership: OwnershipRule = ({ file }) =>
  isNodeIntegrationPath(file)
    ? [reason('integration-node', file, 'node-integration', 'node --test integration smoke')]
    : [];

// SkillGym validates skill guidance (`skills/`) and owns its harness
// (`test/skillgym/`); AGENTS.md routes skill-prompt/assertion changes here.
const skillgymOwnership: OwnershipRule = ({ file, underSkills }) =>
  underSkills || file.startsWith('test/skillgym/')
    ? [
        reason(
          'skillgym',
          file,
          'own:skillgym',
          'SkillGym suite validates skill guidance and its harness',
        ),
      ]
    : [];

const BUILD_OWNERSHIP: ReadonlyArray<{
  check: CheckId;
  rule: string;
  detail: string;
  owns: (file: string) => boolean;
}> = [
  {
    check: 'swift-runner',
    rule: 'own:swift',
    detail: 'Swift runner sources require the XCUITest build',
    owns: (file) => file.startsWith('apple/runner/') || file.endsWith('.swift'),
  },
  {
    check: 'android-helpers',
    rule: 'own:android-helpers',
    detail: 'Android helper packages have their own build',
    owns: (file) =>
      file.startsWith('android/snapshot-helper/') ||
      file.startsWith('android/multitouch-helper/'),
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
];

const buildOwnership: OwnershipRule = ({ file }, input) => {
  const selections = BUILD_OWNERSHIP.filter((entry) => entry.owns(file)).map((entry) =>
    reason(entry.check, file, entry.rule, entry.detail),
  );
  if ((input.packageEntryFiles ?? []).includes(file)) {
    selections.push(
      reason('build', file, 'own:public-surface', 'public package entry affects declarations'),
    );
  }
  return selections;
};

const OWNERSHIP_RULES: readonly OwnershipRule[] = [
  formatGate,
  staticTsGates,
  srcProdGate,
  vitestRelatedOwnership,
  nodeIntegrationOwnership,
  skillgymOwnership,
  buildOwnership,
];

function fileFacts(file: string): FileFacts {
  const isTs = file.endsWith('.ts') && !file.endsWith('.d.ts');
  const underSrc = file.startsWith('src/');
  return {
    file,
    isTs,
    underSrc,
    underTest: file.startsWith('test/'),
    underSkills: file.startsWith('skills/'),
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
      docsOnlyPaths.push(file);
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
