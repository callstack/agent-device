// Catches: the Apple runner package (`@agent-device/apple-runner`) reaching back into platform-apple,
//   a sibling platform, or root and daemon code, or importing a workspace package that a platform
//   family may not; and production code outside platform-apple's composition and the named root
//   consumers importing the runner entry. The package holds the Apple-family runner engine, so it
//   is bound by the same substrate rules R13 holds the `platform-*` packages to, but its name falls
//   outside that family match and platform-apple composes it, never the reverse.
// Evidence: the runner moved out of platform-apple's `src/runner/` subtree into this package; the
//   family-name match in R13 and R65 stopped covering it, and a reverse edge into platform-apple
//   would close a project-reference cycle that only a source walk sees.
// Cost: one pass over each runner and entry-importing file's imports.
// Kill criterion: none enforced today; retire only by maintainer decision that the runner engine may
//   depend on platform-apple, or that platform-apple may expose it without a named importer list.
//
// Part of R13 platform-package-substrate. The host-kit value-import ban is R77's.

import path from 'node:path';
import type { LayeringViolation } from './model.ts';
import { isProductionSourceFile } from './tracked-sources.ts';

const RULE = 'R13 platform-package-substrate';

export const APPLE_RUNNER_PACKAGE = '@agent-device/apple-runner';
export const APPLE_RUNNER_DIR = 'packages/apple-runner/';
const APPLE_RUNNER_COMPOSITION_DIR = 'packages/platform-apple/';
const RAW_PROCESS_SPECIFIERS = new Set(['child_process', 'node:child_process']);

// The workspace code the runner may import: the same vocabulary and substrate packages a platform
// family may, plus the xml vocabulary. Anything else (a platform package, a provider, the daemon)
// would invert the composition direction.
const ALLOWED_WORKSPACE_PREFIXES = [
  '@agent-device/contracts/',
  '@agent-device/capture-kit',
  '@agent-device/host-kit/',
  '@agent-device/kernel/',
  '@agent-device/provision-kit/',
  '@agent-device/xml',
] as const;

// Production files outside platform-apple that may name the runner entry, and only as a type or
// behind a deferred import: they hold the runner provider type and the lazily loaded provider scope
// and bundle-id helpers. A deferred import evaluates the entry, so these files call only host-free
// symbols.
const ROOT_CONSUMERS: ReadonlySet<string> = new Set([
  'src/platform-runtime-screen-recording-apple-runner-host.ts',
  'src/platform-runtime/request-providers.ts',
  'src/provider-device-runtime.ts',
]);

export type ImportSite = Readonly<{
  spec: string;
  line: number;
  dynamic: boolean;
  typeOnly: boolean;
}>;

function violation(file: string, line: number, message: string): LayeringViolation {
  return { rule: RULE, file, line, message };
}

function isAllowedWorkspaceImport(file: string, spec: string): boolean {
  if (spec === '@agent-device/test-kit') return !isProductionSourceFile(file);
  return ALLOWED_WORKSPACE_PREFIXES.some(
    (prefix) => spec === prefix || spec.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
  );
}

/** The substrate rules for one import site of a file inside the Apple runner package. */
export function appleRunnerPackageSiteViolations(
  file: string,
  site: ImportSite,
): LayeringViolation[] {
  const { spec } = site;
  const violations: LayeringViolation[] = [];
  if (spec.startsWith('@agent-device/') && !isAllowedWorkspaceImport(file, spec)) {
    violations.push(
      violation(
        file,
        site.line,
        `apple-runner may import workspace code only from capture-kit, host-kit, provision-kit, contracts, kernel, or xml; found '${spec}'`,
      ),
    );
  }
  const resolvesOutside =
    spec.startsWith('.') &&
    !path.posix
      .normalize(path.posix.join(path.posix.dirname(file), spec))
      .startsWith(APPLE_RUNNER_DIR);
  if (resolvesOutside || /^agent-device(?:\/|$)/.test(spec)) {
    violations.push(
      violation(file, site.line, 'apple-runner may not reach platform-apple, root, or daemon code'),
    );
  }
  // Production value-imports only: package tests fake process primitives (they intercept, not
  // spawn), and the runner host port names ChildProcess as a type.
  if (RAW_PROCESS_SPECIFIERS.has(spec) && isProductionSourceFile(file) && !site.typeOnly) {
    violations.push(
      violation(
        file,
        site.line,
        `apple-runner may not import raw process primitives ('${spec}'); use the host-command port`,
      ),
    );
  }
  return violations;
}

/**
 * The importer rule for the runner entry: platform-apple's production composition may import it
 * freely, the named root consumers may import it as a type or behind a deferred import, and every
 * other production file may not. Test support is not production and may import it.
 */
export function appleRunnerEntryImporterViolations(
  file: string,
  site: ImportSite,
): LayeringViolation[] {
  if (site.spec !== APPLE_RUNNER_PACKAGE || !isProductionSourceFile(file)) return [];
  if (file.startsWith(APPLE_RUNNER_DIR) || file.startsWith(APPLE_RUNNER_COMPOSITION_DIR)) return [];
  if (!ROOT_CONSUMERS.has(file)) {
    return [
      violation(
        file,
        site.line,
        `only platform-apple's composition and the named root consumers may import '${site.spec}' in production`,
      ),
    ];
  }
  if (!site.typeOnly && !site.dynamic) {
    return [
      violation(
        file,
        site.line,
        `named root consumers import '${APPLE_RUNNER_PACKAGE}' as a type or behind a deferred import`,
      ),
    ];
  }
  return [];
}
