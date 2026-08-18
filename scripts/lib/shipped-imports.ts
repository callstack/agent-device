/**
 * The static half of the publishing gate (scripts/check-package.ts step 3): which packages the
 * files inside the packed tarball actually resolve at runtime, and whether `dependencies` matches.
 *
 * Extracted from the gate so this half can be exercised against fixture output. The gate itself
 * only runs against a real `npm pack` — minutes of Swift and Android builds — so nothing there can
 * prove that a malformed package *fails*; every test against it can only confirm the healthy path.
 *
 * Two properties of the shipped files decide what a reader here has to understand. Both were
 * measured against the built `dist/`, not assumed:
 *
 *  - **The shipped files are minified, and the minifier rewrites every string literal to a
 *    no-substitution template literal.** `` import(`./cli-help.js`) `` is the normal spelling in
 *    the bundle; `import('./cli-help.js')` never appears. A reader that accepts only quoted strings
 *    sees 0 of the 99 dynamic imports the bundle contains — so the lazy-import half of the closure
 *    audit reads as covered while checking nothing, on exactly the lazy `import()` path that
 *    published 0.20.4 broke on (#1577).
 *
 *  - **Bundled dependencies resolve through `createRequire`, under minified aliases.** The packed
 *    `png-worker-contract.js` carries `` var a = t(import.meta.url); a(`zlib`) `` from inlined
 *    `pngjs`. A `require` call produces no entry in an ESM module record — not a static import, not
 *    a dynamic import — so a reader built on the record alone cannot see a required package at all,
 *    and a lazy `createRequire('@agent-device/…')` would slip past this audit the same way.
 *
 * So specifiers come from the module record (static `import`/`export`) *and* from an AST walk over
 * every literal runtime-resolution form: `import()`, `require()`, `require.resolve()`, and calls
 * through a `createRequire` result. Both spellings of a string literal count everywhere.
 *
 * Deliberately **not** covered: a specifier computed at runtime — `a(name)`, `require('pkg/' + x)`.
 * Resolving those needs constant propagation this gate does not attempt, and rejecting them
 * outright is not available either: minifiers reuse short identifiers across scopes, so the packed
 * bundle contains unrelated calls like `a(h[t],f,g,l,e,m)` that no name-based match can tell from a
 * real `require`. Computed resolution is covered by the runtime half of the gate instead — step 4
 * imports every export and runs the CLI paths that load the lazy bundles. Keep both halves.
 */
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import {
  type CallExpression,
  type Expression,
  type Node,
  parseSync,
  type StringLiteral,
  type TemplateLiteral,
  Visitor,
} from 'oxc-parser';
import { walkFiles } from './walk-files.ts';

export type PackedManifest = {
  dependencies?: Record<string, string>;
  /**
   * A peer dependency (e.g. `ai` for `agent-device/ai-sdk`) is resolved from
   * the consumer's own install, not ours — but it is still a truthful answer
   * to "how does a shipped import of this package resolve," so it counts
   * toward the forward half of the audit below. Whether it is optional
   * doesn't change that: an *optional* peer only changes whether npm errors
   * when it's absent, not whether declaring it is the correct fix for an
   * import the shipped files actually make.
   */
  peerDependencies?: Record<string, string>;
};

/** Every file extension the package ships that Node can resolve a specifier from. */
const SHIPPED_SOURCE = /\.(?:m?js|cjs|d\.ts)$/;

/** The module both spellings of `createRequire` are imported from. */
const MODULE_BUILTIN = new Set(['module', 'node:module']);

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/**
 * `'pkg'` and `` `pkg` `` are the same specifier. The second is the only spelling the minified
 * shipped files use, so treating it as non-literal blinds this reader to the whole bundle.
 */
function literalSpecifier(node: Node | Expression | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal') {
    const { value } = node as StringLiteral;
    return typeof value === 'string' ? value : undefined;
  }
  if (node.type === 'TemplateLiteral') {
    const template = node as TemplateLiteral;
    if (template.expressions.length > 0 || template.quasis.length !== 1) return undefined;
    return template.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** The local names `createRequire` is reachable through in one file, under any import alias. */
type CreateRequireBindings = {
  /** `import { createRequire } from 'node:module'` — including `as` aliases the minifier invents. */
  locals: Set<string>;
  /** `import * as mod from 'node:module'`, reached as `mod.createRequire`. */
  namespaces: Set<string>;
};

function isCreateRequire(callee: Expression, bindings: CreateRequireBindings): boolean {
  if (callee.type === 'Identifier') return bindings.locals.has(callee.name);
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    bindings.namespaces.has(callee.object.name) &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'createRequire'
  );
}

/** A resolution call found in one pass, pending the alias set the same pass is still collecting. */
type PendingCall =
  | { form: 'callee'; name: string; specifier: string; single: boolean }
  | { form: 'resolve'; name: string; specifier: string }
  | { form: 'resolved'; specifier: string };

/** The first argument, when it is a literal specifier rather than a computed expression. */
function firstArgumentSpecifier(call: CallExpression): string | undefined {
  const [first] = call.arguments;
  if (!first || first.type === 'SpreadElement') return undefined;
  return literalSpecifier(first);
}

/** `<name>.resolve` — the object name, for the `require.resolve('pkg')` spelling. */
function resolveTarget(callee: Expression): string | undefined {
  if (callee.type !== 'MemberExpression' || callee.computed) return undefined;
  if (callee.object.type !== 'Identifier') return undefined;
  if (callee.property.type !== 'Identifier' || callee.property.name !== 'resolve') return undefined;
  return callee.object.name;
}

function pendingCall(
  call: CallExpression,
  bindings: CreateRequireBindings,
): PendingCall | undefined {
  const specifier = firstArgumentSpecifier(call);
  if (specifier === undefined) return undefined;
  const { callee } = call;
  // `createRequire(import.meta.url)('pkg')` — the alias is inline, so nothing needs resolving.
  if (callee.type === 'CallExpression' && isCreateRequire(callee.callee, bindings)) {
    return { form: 'resolved', specifier };
  }
  if (callee.type === 'Identifier') {
    return { form: 'callee', name: callee.name, specifier, single: call.arguments.length === 1 };
  }
  // `require.resolve('pkg')`, which also takes an options bag as a second argument.
  const target = resolveTarget(callee);
  return target === undefined ? undefined : { form: 'resolve', name: target, specifier };
}

/**
 * Every literal specifier one shipped file resolves, from the module record and from the runtime
 * resolution forms the record cannot represent.
 */
function moduleSpecifiers(file: string, source: string): string[] {
  const parsed = parseSync(file, source);
  const record = parsed.module;

  const bindings: CreateRequireBindings = { locals: new Set(), namespaces: new Set() };
  for (const staticImport of record.staticImports) {
    if (!MODULE_BUILTIN.has(staticImport.moduleRequest.value)) continue;
    for (const entry of staticImport.entries) {
      if (entry.importName.kind === 'Name' && entry.importName.name === 'createRequire') {
        bindings.locals.add(entry.localName.value);
      }
      if (entry.importName.kind === 'NamespaceObject') {
        bindings.namespaces.add(entry.localName.value);
      }
    }
  }

  // A single pass: `require` aliases and the calls through them are collected together and matched
  // afterwards, so a call does not have to appear below the declaration that names it.
  const requireAliases = new Set(['require']);
  const pending: PendingCall[] = [];
  const dynamic: string[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== 'Identifier') return;
      if (node.init?.type !== 'CallExpression') return;
      if (isCreateRequire(node.init.callee, bindings)) requireAliases.add(node.id.name);
    },
    ImportExpression(node) {
      const specifier = literalSpecifier(node.source);
      if (specifier !== undefined) dynamic.push(specifier);
    },
    CallExpression(node) {
      const call = pendingCall(node, bindings);
      if (call) pending.push(call);
    },
  }).visit(parsed.program);

  const required = pending.flatMap((call) => {
    if (call.form === 'resolved') return [call.specifier];
    if (!requireAliases.has(call.name)) return [];
    // A bare `name('pkg')` only reads as a require call in the one-string-argument shape. Minified
    // scopes reuse short names, and the packed bundle really does contain a six-argument `a(…)`
    // whose `a` is not the file's `createRequire` result.
    if (call.form === 'callee' && !call.single) return [];
    return [call.specifier];
  });

  return [
    ...record.staticImports.map((entry) => entry.moduleRequest.value),
    ...record.staticExports.flatMap((entry) =>
      entry.entries.flatMap((exported) =>
        exported.moduleRequest?.value ? [exported.moduleRequest.value] : [],
      ),
    ),
    ...dynamic,
    ...required,
  ];
}

function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!;
}

function isExternalPackage(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !builtins.has(specifier);
}

/** Maps each package the shipped files import to the files importing it. */
function shippedImports(installedRoot: string): Map<string, string[]> {
  const importedBy = new Map<string, string[]>();
  for (const file of walkFiles(installedRoot, (file) => SHIPPED_SOURCE.test(file))) {
    const relative = path.relative(installedRoot, file);
    const specifiers = moduleSpecifiers(file, fs.readFileSync(file, 'utf8'));
    for (const specifier of specifiers.filter(isExternalPackage)) {
      const name = packageNameOf(specifier);
      importedBy.set(name, [...(importedBy.get(name) ?? []), `${specifier} in ${relative}`]);
    }
  }
  return importedBy;
}

function mismatch(heading: string, entries: readonly string[], fix: string): string[] {
  return entries.length === 0 ? [] : [heading, ...entries.map((entry) => `  - ${entry}`), fix];
}

/**
 * Both directions matter. An import the manifest does not declare breaks the install; a declared
 * dependency nothing imports is an install every user pays for and no code reaches — how `pngjs`
 * stayed in `dependencies` after `tsdown.config.ts` started inlining it.
 */
export function auditDependencyClosure(
  installedRoot: string,
  manifest: PackedManifest,
): Map<string, string[]> {
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const declared = new Set([...dependencies, ...Object.keys(manifest.peerDependencies ?? {})]);
  const importedBy = shippedImports(installedRoot);
  const problems = [
    ...mismatch(
      'Imported but not declared in "dependencies" or "peerDependencies" (a published install cannot resolve these):',
      [...importedBy].filter(([name]) => !declared.has(name)).flatMap(([, sites]) => sites),
      'Declare the package, or add it to `deps.alwaysBundle` in tsdown.config.ts.',
    ),
    ...mismatch(
      'Declared in "dependencies" but never imported (every user installs these for nothing):',
      [...dependencies].filter((name) => !importedBy.has(name)),
      'Remove the dependency, or stop bundling it in tsdown.config.ts.',
    ),
  ];

  if (problems.length > 0) {
    throw new Error(
      `The published dependency closure does not match what the package imports.\n${problems.join('\n')}`,
    );
  }
  return importedBy;
}
