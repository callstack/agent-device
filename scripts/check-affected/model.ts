// Derived, fail-open check selector for `pnpm check:affected --base <ref>`.
//
// The model turns a set of changed paths into a plan of local checks with
// stable, machine-readable reasoning. It is intentionally source-of-truth
// derived rather than a hand-maintained path-to-check registry (issue #1181):
//
//   - test ownership comes from the Vitest project include/exclude globs
//     (passed in from vitest.config.ts) — a changed test file selects the
//     project that owns it, and a changed production source file selects the
//     unit suite that mirrors it (AGENTS.md: test topology mirrors src 1:1);
//   - the lint/typecheck/layering/fallow gates are always-on for their input
//     categories, so they are never silently skipped (issue constraint);
//   - a small explicit build-ownership layer covers Swift, Android helpers,
//     the macOS helper, MCP metadata, and the public package surface — the
//     only paths whose owning build the sources of truth cannot derive.
//
// Anything the model cannot confidently classify (unknown, ambiguous,
// workflow/tooling, or the selector's own sources) fails open to the full
// check set. Existing GitHub CI remains authoritative; this only optimizes
// local/agent feedback.

export type CheckId =
  | 'format'
  | 'lint'
  | 'typecheck'
  | 'layering'
  | 'fallow'
  | 'mcp-metadata'
  | 'build'
  | 'unit'
  | 'output-economy'
  | 'provider-integration'
  | 'interaction-contract'
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
  'unit',
  'output-economy',
  'provider-integration',
  'interaction-contract',
  'integration-node',
  'integration-progress',
  'swift-runner',
  'android-helpers',
  'macos-helper',
  'web-smoke',
  'skillgym',
];

export type VitestProject = {
  name: string;
  include: readonly string[];
  exclude?: readonly string[];
};

export type SelectionReason = {
  check: CheckId;
  path: string;
  rule: string;
  detail: string;
};

export type FailOpenReason = {
  path: string;
  rule: 'workflow-tooling' | 'selector-owning' | 'unknown-path';
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
  vitestProjects: readonly VitestProject[];
  // Public package entry source files, derived from package.json `exports`.
  packageEntryFiles?: readonly string[];
};

// --- Minimal glob matcher (supports the subset Vitest configs use) ----------
// Handles `**`, `*`, `?`, and non-nested `{a,b,c}` brace groups.
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '{') {
      const end = glob.indexOf('}', i);
      const body = glob.slice(i + 1, end);
      out += `(?:${body.split(',').map(escapeRegExp).join('|')})`;
      i = end;
    } else {
      out += escapeRegExp(char);
    }
  }
  return new RegExp(`${out}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

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
  return file.startsWith('scripts/check-affected/') && !file.endsWith('.md');
}

function isWorkflowTooling(file: string): boolean {
  return file.startsWith('.github/') || file.startsWith('scripts/') || ROOT_TOOLING.has(file);
}

function isDocs(file: string): boolean {
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

function vitestCheckId(project: string): CheckId | null {
  switch (project) {
    case 'unit-core':
    case 'android-adb':
      return 'unit';
    case 'provider-integration':
      return 'provider-integration';
    case 'interaction-contract':
      return 'interaction-contract';
    case 'output-economy':
      return 'output-economy';
    default:
      return null;
  }
}

// --- Selection --------------------------------------------------------------
export function selectChecks(input: SelectInput): CheckPlan {
  const packageEntryFiles = new Set(input.packageEntryFiles ?? []);
  const reasons: SelectionReason[] = [];
  const failOpenReasons: FailOpenReason[] = [];
  const docsOnlyPaths: string[] = [];
  const selected = new Set<CheckId>();

  const add = (check: CheckId, path: string, rule: string, detail: string): void => {
    selected.add(check);
    reasons.push({ check, path, rule, detail });
  };

  for (const file of input.changedFiles) {
    if (isSelectorOwning(file)) {
      failOpenReasons.push({
        path: file,
        rule: 'selector-owning',
        detail: 'change to the affected-check selector cannot be trusted to select itself',
      });
      continue;
    }
    if (isWorkflowTooling(file)) {
      failOpenReasons.push({
        path: file,
        rule: 'workflow-tooling',
        detail: 'workflow/tooling change can alter any gate',
      });
      continue;
    }
    if (isDocs(file)) {
      docsOnlyPaths.push(file);
      continue;
    }

    let classified = false;
    const isTs = file.endsWith('.ts') && !file.endsWith('.d.ts');
    const underSrc = file.startsWith('src/');
    const underTest = file.startsWith('test/');
    const underSkills = file.startsWith('skills/');
    const isTest = isTestPath(file);
    const isSrcProd = underSrc && isTs && !isTest;

    // Always-on gates (never silently skipped when their inputs may change).
    if (underSrc || underTest || underSkills) {
      add('format', file, 'gate:format', 'oxfmt covers src/, test/, and skills/');
      classified = true;
    }
    if (isTs && (underSrc || underTest)) {
      add('lint', file, 'gate:lint', 'oxlint covers the source tree');
      add('typecheck', file, 'gate:typecheck', 'tsc includes src/ and test/');
      add('fallow', file, 'gate:fallow', 'fallow audits changed TypeScript for dead code/complexity');
      classified = true;
    }
    if (isSrcProd) {
      add('layering', file, 'gate:layering', 'layering guard reads production src/ modules');
      add('build', file, 'src-prod', 'production source is compiled by the build');
      add('unit', file, 'src-prod', 'unit suite mirrors production source 1:1');
      if (file.startsWith('src/platforms/')) {
        add(
          'provider-integration',
          file,
          'platform-src',
          'platform source shapes device/provider wire behavior',
        );
      }
      classified = true;
    }

    // Vitest-derived test ownership: a changed test file selects its project.
    for (const project of input.vitestProjects) {
      const excluded = project.exclude ? matchesAny(file, project.exclude) : false;
      if (!excluded && matchesAny(file, project.include)) {
        const check = vitestCheckId(project.name);
        if (check) {
          add(check, file, `vitest:${project.name}`, `owned by the ${project.name} Vitest project`);
          classified = true;
        }
      }
    }
    if (underTest && isTs && isTest && !selected.has('provider-integration')) {
      // Node-runner integration tests live outside the Vitest projects.
      if (matchesAny(file, ['test/integration/*.test.ts'])) {
        add('integration-node', file, 'node-integration', 'node --test integration smoke owns this file');
        classified = true;
      }
    }

    // Small explicit build-ownership layer.
    if (file.startsWith('apple-runner/') || file.endsWith('.swift')) {
      add('swift-runner', file, 'own:swift', 'Swift runner sources require the XCUITest build');
      classified = true;
    }
    if (
      file.startsWith('android-snapshot-helper/') ||
      file.startsWith('android-multitouch-helper/')
    ) {
      add('android-helpers', file, 'own:android-helpers', 'Android helper packages have their own build');
      classified = true;
    }
    if (file.startsWith('macos-helper/')) {
      add('macos-helper', file, 'own:macos-helper', 'macOS helper is a separate Swift package build');
      classified = true;
    }
    if (file === 'server.json' || file === 'smithery.yaml') {
      add('mcp-metadata', file, 'own:mcp', 'MCP registry metadata must stay in sync');
      classified = true;
    }
    if (packageEntryFiles.has(file)) {
      add('build', file, 'own:public-surface', 'public package entry point affects declaration output');
      classified = true;
    }

    if (!classified) {
      failOpenReasons.push({
        path: file,
        rule: 'unknown-path',
        detail: 'path has no derivable owner; run the full set to stay safe',
      });
    }
  }

  if (failOpenReasons.length > 0) {
    return {
      failOpen: true,
      checks: [...ALL_CHECKS],
      reasons,
      failOpenReasons,
      docsOnlyPaths,
    };
  }

  return {
    failOpen: false,
    checks: ALL_CHECKS.filter((check) => selected.has(check)),
    reasons,
    failOpenReasons,
    docsOnlyPaths,
  };
}
