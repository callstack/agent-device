import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';

/**
 * Every CLI invocation eagerly evaluates the static import closure of
 * `src/cli.ts`. Importing `node:http` (or `node:https`) for a VALUE inside that
 * closure initializes undici and, under `NODE_USE_SYSTEM_CA=1`, the platform
 * trust store as well -- ~79ms added to every warm command on macOS, including
 * ones that never speak HTTP (the default daemon transport is a `node:net`
 * socket). The HTTP daemon transport, remote-artifact upload and download all
 * load these modules on demand instead.
 *
 * Classification comes from oxc-parser's ES module record rather than a regex,
 * because the forms that matter are exactly the ones a regex tuned to
 * `import ... from` misses: a bare side-effect `import 'node:http'` binds
 * nothing yet still evaluates the module, so it reintroduces the whole cost
 * while looking like nothing at all. Type-only imports are erased at build and
 * stay allowed; dynamic `import()` is the fix and is deliberately not followed.
 */

const srcRoot = path.resolve(import.meta.dirname, '..');
const LAZY_HTTP_MODULES = new Set(['node:http', 'node:https']);

/**
 * Specifiers whose module this file causes to be EVALUATED at load time.
 * Excludes type-only imports/re-exports (erased) and dynamic imports (lazy).
 */
function evaluatedModuleRefs(fileName: string, source: string): string[] {
  const { module } = parseSync(fileName, source);
  const refs: string[] = [];
  for (const staticImport of module.staticImports) {
    // No entries at all is a side-effect import (`import 'x'`), which always
    // evaluates. Otherwise it evaluates unless every binding is type-only.
    const evaluates =
      staticImport.entries.length === 0 || staticImport.entries.some((entry) => !entry.isType);
    if (evaluates) refs.push(staticImport.moduleRequest.value);
  }
  for (const staticExport of module.staticExports) {
    for (const entry of staticExport.entries) {
      if (entry.moduleRequest && !entry.isType) refs.push(entry.moduleRequest.value);
    }
  }
  return refs;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const candidate = path.resolve(path.dirname(fromFile), specifier);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  for (const suffix of ['.ts', '.tsx', '/index.ts']) {
    if (fs.existsSync(`${candidate}${suffix}`)) return `${candidate}${suffix}`;
  }
  return null;
}

/** `@agent-device/<pkg>` -> that package's directory, keyed by its declared name. */
function readWorkspacePackageDirs(): Map<string, string> {
  const packagesRoot = path.resolve(srcRoot, '..', 'packages');
  const dirs = new Map<string, string>();
  for (const entry of fs.readdirSync(packagesRoot)) {
    const manifestPath = path.join(packagesRoot, entry, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: string };
    if (manifest.name) dirs.set(manifest.name, path.join(packagesRoot, entry));
  }
  return dirs;
}

/**
 * Workspace subpath imports are followed too: a package the CLI evaluates can
 * pull `node:http` in just as effectively as a file under src/, and stopping the
 * walk at the package boundary would be the same blind spot in a new place.
 */
function resolveWorkspace(specifier: string, packageDirs: Map<string, string>): string | null {
  const match = /^(@agent-device\/[^/]+)(\/.*)?$/.exec(specifier);
  const packageDir = match?.[1] ? packageDirs.get(match[1]) : undefined;
  if (!packageDir) return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, { default?: string; types?: string } | string>;
  };
  const target = manifest.exports?.[`.${match?.[2] ?? ''}` as string];
  const relativeTarget = typeof target === 'string' ? target : (target?.default ?? target?.types);
  if (!relativeTarget) return null;
  const resolved = path.resolve(packageDir, relativeTarget);
  return fs.existsSync(resolved) ? resolved : null;
}

/** Every repo file evaluated as a consequence of importing `src/cli.ts`. */
function eagerClosureOfCli(): string[] {
  const packageDirs = readWorkspacePackageDirs();
  const queue = [path.join(srcRoot, 'cli.ts')];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const specifier of evaluatedModuleRefs(current, fs.readFileSync(current, 'utf8'))) {
      const resolved = specifier.startsWith('.')
        ? resolveRelative(current, specifier)
        : resolveWorkspace(specifier, packageDirs);
      if (resolved) queue.push(resolved);
    }
  }
  return [...visited];
}

test.for([
  { form: 'side-effect import', code: `import 'node:http';`, evaluates: true },
  { form: 'default value import', code: `import http from 'node:http';`, evaluates: true },
  { form: 'namespace import', code: `import * as http from 'node:http';`, evaluates: true },
  { form: 'named value import', code: `import { request } from 'node:http';`, evaluates: true },
  { form: 'value re-export', code: `export { request } from 'node:http';`, evaluates: true },
  { form: 'star re-export', code: `export * from 'node:http';`, evaluates: true },
  {
    form: 'mixed value + type import',
    code: `import http, { type IncomingMessage } from 'node:http';`,
    evaluates: true,
  },
  {
    form: 'type-only default import',
    code: `import type http from 'node:http';`,
    evaluates: false,
  },
  {
    form: 'type-only named import',
    code: `import { type IncomingMessage } from 'node:http';`,
    evaluates: false,
  },
  {
    form: 'type-only re-export',
    code: `export type { IncomingMessage } from 'node:http';`,
    evaluates: false,
  },
  { form: 'dynamic import', code: `const m = await import('node:http');`, evaluates: false },
])('$form is classified as evaluates=$evaluates', ({ code, evaluates }) => {
  expect(evaluatedModuleRefs('fixture.ts', code)).toEqual(evaluates ? ['node:http'] : []);
});

test('the CLI startup import closure never evaluates node:http or node:https', () => {
  const offenders: string[] = [];
  for (const file of eagerClosureOfCli()) {
    for (const specifier of evaluatedModuleRefs(file, fs.readFileSync(file, 'utf8'))) {
      if (LAZY_HTTP_MODULES.has(specifier)) {
        offenders.push(`${path.relative(srcRoot, file)} -> ${specifier}`);
      }
    }
  }

  expect(
    offenders,
    'Load node:http / node:https on demand instead: evaluating either one here costs every warm ' +
      'CLI command ~79ms of undici + system-CA initialization.',
  ).toEqual([]);
});

test('the CLI startup import closure is reachable and crosses the package boundary', () => {
  // Guards the test above from silently passing because the walk found nothing:
  // a resolver that returns null for everything would leave both the src side
  // and the workspace side of the closure empty while the guard stayed green.
  const closure = eagerClosureOfCli();
  expect(closure.length).toBeGreaterThan(50);
  expect(
    closure.filter((file) => file.includes(`${path.sep}packages${path.sep}`)).length,
  ).toBeGreaterThan(0);
});
