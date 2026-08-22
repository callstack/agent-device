import fs from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';

/**
 * Eager-import-closure machinery shared by the startup/teardown lazy-seam pins.
 *
 * "On demand" is a claim about SCOPE, not about syntax, which is why this reads
 * the AST rather than matching import forms. Two shapes evaluate the module
 * during module evaluation while looking lazy or looking like nothing at all:
 * a bare side-effect `import 'x'` (binds no names, still evaluates),
 * and a dynamic `import('x')` sitting at module top level rather than
 * inside a function -- including `.then(...)` and an immediately-invoked
 * top-level function. A dynamic import is lazy only when its nearest enclosing
 * function scope is not the module itself. Type-only imports and re-exports are
 * erased at build and stay allowed.
 *
 * Known limitation: a top-level function that is invoked indirectly at load
 * time (stored, then called by another top-level statement) reads as lazy here.
 * Direct top-level invocation -- `(() => { ... })()` -- is detected.
 */

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
export function eagerlyEvaluatedModules(fileName: string, source: string): string[] {
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
  const packagesRoot = path.resolve(import.meta.dirname, '../../packages');
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
 * Workspace subpath imports are followed too: a package the entry evaluates can
 * pull a heavy module in just as effectively as a file under src/, and stopping the
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

/**
 * The repo files `file` evaluates directly, already resolved to absolute paths.
 *
 * Memoized: the budget table in `eager-closure-budgets.ts` walks ~100 entries whose
 * subtrees overlap heavily (every contracts entry bottoms out in the same kernel
 * modules), so without this each shared file is re-read and re-parsed once per entry
 * that reaches it. Source files do not change during a run, so the cache is safe for
 * the lifetime of the worker.
 */
const directEdgeCache = new Map<string, string[]>();

function directEagerEdges(file: string, packageDirs: Map<string, string>): string[] {
  const cached = directEdgeCache.get(file);
  if (cached) return cached;
  const resolvedEdges: string[] = [];
  for (const specifier of eagerlyEvaluatedModules(file, fs.readFileSync(file, 'utf8'))) {
    const resolved = specifier.startsWith('.')
      ? resolveRelative(file, specifier)
      : resolveWorkspace(specifier, packageDirs);
    if (resolved) resolvedEdges.push(resolved);
  }
  directEdgeCache.set(file, resolvedEdges);
  return resolvedEdges;
}

/**
 * Every repo file evaluated as a consequence of importing `entryFile`, mapped to the
 * file that first pulled it in (`null` for the entry itself).
 *
 * `eagerClosureOf` answers "how much evaluates"; this answers "and through what",
 * which is what a violation message needs to be actionable (#1960): a flat set names
 * the offender but leaves the reader to rediscover which import chain reaches it.
 * Breadth-first, so following the links back yields the SHORTEST chain to each file
 * rather than whatever route a depth-first walk happened to take.
 */
export function eagerClosureGraphOf(entryFile: string): Map<string, string | null> {
  const packageDirs = readWorkspacePackageDirs();
  const cameFrom = new Map<string, string | null>([[entryFile, null]]);
  const queue = [entryFile];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === undefined) continue;
    for (const resolved of directEagerEdges(current, packageDirs)) {
      if (cameFrom.has(resolved)) continue;
      cameFrom.set(resolved, current);
      queue.push(resolved);
    }
  }
  return cameFrom;
}

/**
 * Every repo file evaluated as a consequence of importing `entryFile`.
 *
 * The returned SET is what callers pin; iteration order is unspecified and carries no
 * meaning (it changed from depth- to breadth-first when `eagerClosureGraphOf` landed).
 */
export function eagerClosureOf(entryFile: string): string[] {
  return [...eagerClosureGraphOf(entryFile).keys()];
}
