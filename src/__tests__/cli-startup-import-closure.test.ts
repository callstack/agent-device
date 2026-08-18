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
 * `@agent-device/maestro` is held to the same line for the same reason. The command registry
 * evaluates every command family's module on startup -- `--help` included -- so a replay-side
 * static import of the Maestro engine (and the YAML parser behind it) put a 131 kB chunk and
 * ~28ms on every warm command, for a format most invocations never touch (#1802). The replay
 * script-source builder loads it on demand, only once an entry actually resolves to a flow.
 *
 * "On demand" is a claim about SCOPE, not about syntax, which is why this reads
 * the AST rather than matching import forms. Two shapes evaluate the module
 * during module evaluation while looking lazy or looking like nothing at all:
 * a bare side-effect `import 'node:http'` (binds no names, still evaluates),
 * and a dynamic `import('node:http')` sitting at module top level rather than
 * inside a function -- including `.then(...)` and an immediately-invoked
 * top-level function. A dynamic import is lazy only when its nearest enclosing
 * function scope is not the module itself. Type-only imports and re-exports are
 * erased at build and stay allowed.
 *
 * Known limitation: a top-level function that is invoked indirectly at load
 * time (stored, then called by another top-level statement) reads as lazy here.
 * Direct top-level invocation -- `(() => { ... })()` -- is detected.
 */

const srcRoot = path.resolve(import.meta.dirname, '..');
const LAZY_HTTP_MODULES = new Set(['node:http', 'node:https']);
/** Engines heavy enough that evaluating them on startup is a measurable regression. */
const LAZY_ENGINE_MODULES = new Set(['@agent-device/maestro']);
const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);
const WORKSPACE_SPECIFIER = /^(@agent-device\/[^/]+)(\/.*)?$/;

type AstNode = { type?: string; [key: string]: unknown };

type ParsedModuleRecord = ReturnType<typeof parseSync>['module'];

/** Static specifiers this file causes to be EVALUATED (not type-only). */
function staticEvaluatedRefs(module: ParsedModuleRecord): string[] {
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

function unwrapParentheses(node: unknown): AstNode | null {
  let current = node as AstNode | null;
  while (current?.type === 'ParenthesizedExpression')
    current = current.expression as AstNode | null;
  return current;
}

/** The body of a function invoked right where it is defined, if this is that call. */
function immediatelyInvokedBody(node: AstNode): unknown {
  if (node.type !== 'CallExpression') return null;
  const callee = unwrapParentheses(node.callee);
  return callee && FUNCTION_NODES.has(String(callee.type)) ? callee.body : null;
}

function dynamicImportSpecifier(node: AstNode): string | null {
  if (node.type !== 'ImportExpression') return null;
  const source = node.source as { type?: string; value?: unknown } | undefined;
  return source?.type === 'Literal' && typeof source.value === 'string' ? source.value : null;
}

function recordDynamicImport(record: AstNode, eager: boolean, found: string[]): void {
  if (!eager) return;
  const specifier = dynamicImportSpecifier(record);
  if (specifier !== null) found.push(specifier);
}

/** Descends into a node's children, dropping `eager` on the way into a function body. */
function visitChildren(record: AstNode, eager: boolean, found: string[]): void {
  const childEager = eager && !FUNCTION_NODES.has(String(record.type));
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'type') collectEagerDynamicImports(value, childEager, found);
  }
}

/** Walks the AST, collecting only `import()` calls reached without entering a function. */
function collectEagerDynamicImports(node: unknown, eager: boolean, found: string[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectEagerDynamicImports(child, eager, found);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as AstNode;
  recordDynamicImport(record, eager, found);
  // An immediately-invoked function runs now, so its body inherits `eager`.
  const invokedBody = immediatelyInvokedBody(record);
  if (invokedBody) collectEagerDynamicImports(invokedBody, eager, found);
  visitChildren(record, eager, found);
}

/** Every specifier this file evaluates at load time, static or dynamic. */
function eagerlyEvaluatedModules(fileName: string, source: string): string[] {
  const parsed = parseSync(fileName, source);
  const dynamic: string[] = [];
  collectEagerDynamicImports(parsed.program, true, dynamic);
  return [...new Set([...staticEvaluatedRefs(parsed.module), ...dynamic])];
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

type ExportTarget = { default?: string; types?: string } | string;

function readExportTarget(packageDir: string, subpath: string): string | undefined {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as {
    exports?: Record<string, ExportTarget>;
  };
  const target = manifest.exports?.[subpath];
  if (typeof target === 'string') return target;
  return target?.default ?? target?.types;
}

/**
 * Workspace subpath imports are followed too: a package the CLI evaluates can
 * pull `node:http` in just as effectively as a file under src/, and stopping the
 * walk at the package boundary would be the same blind spot in a new place.
 */
function resolveWorkspace(specifier: string, packageDirs: Map<string, string>): string | null {
  const match = WORKSPACE_SPECIFIER.exec(specifier);
  const packageName = match?.[1];
  const packageDir = packageName ? packageDirs.get(packageName) : undefined;
  if (!packageDir) return null;
  const target = readExportTarget(packageDir, `.${match?.[2] ?? ''}`);
  if (!target) return null;
  const resolved = path.resolve(packageDir, target);
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
    for (const specifier of eagerlyEvaluatedModules(current, fs.readFileSync(current, 'utf8'))) {
      const resolved = specifier.startsWith('.')
        ? resolveRelative(current, specifier)
        : resolveWorkspace(specifier, packageDirs);
      if (resolved) queue.push(resolved);
    }
  }
  return [...visited];
}

test.for([
  // --- static forms ---
  { form: 'side-effect import', code: `import 'node:http';`, eager: true },
  { form: 'default value import', code: `import http from 'node:http';`, eager: true },
  { form: 'namespace import', code: `import * as http from 'node:http';`, eager: true },
  { form: 'named value import', code: `import { request } from 'node:http';`, eager: true },
  { form: 'value re-export', code: `export { request } from 'node:http';`, eager: true },
  { form: 'star re-export', code: `export * from 'node:http';`, eager: true },
  {
    form: 'mixed value + type import',
    code: `import http, { type IncomingMessage } from 'node:http';`,
    eager: true,
  },
  { form: 'type-only default import', code: `import type http from 'node:http';`, eager: false },
  {
    form: 'type-only named import',
    code: `import { type IncomingMessage } from 'node:http';`,
    eager: false,
  },
  {
    form: 'type-only re-export',
    code: `export type { IncomingMessage } from 'node:http';`,
    eager: false,
  },
  // --- dynamic import: scope decides, not syntax ---
  { form: 'top-level await import', code: `const m = await import('node:http');`, eager: true },
  { form: 'top-level import().then', code: `import('node:http').then((m) => m);`, eager: true },
  {
    form: 'top-level immediately-invoked arrow',
    code: `(async () => { await import('node:http'); })();`,
    eager: true,
  },
  {
    form: 'function-declaration-local import',
    code: `async function load() { return await import('node:http'); }`,
    eager: false,
  },
  {
    form: 'arrow-local import',
    code: `const load = async () => await import('node:http');`,
    eager: false,
  },
  {
    form: 'method-local import',
    code: `class K { async load() { await import('node:http'); } }`,
    eager: false,
  },
  {
    form: 'ternary inside a function (the shipped lazy-load shape)',
    code: `async function load(s: boolean) {
      return s ? (await import('node:https')).default : (await import('node:http')).default;
    }`,
    eager: false,
  },
])('$form is eager=$eager', ({ code, eager }) => {
  const refs = eagerlyEvaluatedModules('fixture.ts', code);
  expect(refs.includes('node:http') || refs.includes('node:https')).toBe(eager);
});

test('the CLI startup import closure never evaluates node:http or node:https', () => {
  const offenders: string[] = [];
  for (const file of eagerClosureOfCli()) {
    for (const specifier of eagerlyEvaluatedModules(file, fs.readFileSync(file, 'utf8'))) {
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

test('the CLI startup import closure never evaluates the Maestro engine', () => {
  const offenders: string[] = [];
  for (const file of eagerClosureOfCli()) {
    for (const specifier of eagerlyEvaluatedModules(file, fs.readFileSync(file, 'utf8'))) {
      if (LAZY_ENGINE_MODULES.has(specifier)) {
        offenders.push(`${path.relative(srcRoot, file)} -> ${specifier}`);
      }
    }
  }

  expect(
    offenders,
    'Load @agent-device/maestro on demand instead: the command registry evaluates every command ' +
      'family on startup, so importing the engine here costs every warm CLI command ~28ms of ' +
      'YAML-parser evaluation and a 131 kB startup chunk, for a format most runs never use.',
  ).toEqual([]);
});

test('the CLI startup import closure is reachable and crosses the package boundary', () => {
  // Guards the test above from silently passing because the walk found nothing:
  // a resolver that returned null for everything would leave both the src side
  // and the workspace side of the closure empty while the guard stayed green.
  const closure = eagerClosureOfCli();
  expect(closure.length).toBeGreaterThan(50);
  expect(
    closure.filter((file) => file.includes(`${path.sep}packages${path.sep}`)).length,
  ).toBeGreaterThan(0);
});
