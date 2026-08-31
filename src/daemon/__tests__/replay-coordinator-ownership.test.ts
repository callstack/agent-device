import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseSync } from 'oxc-parser';

/**
 * #1478 P4b hardening: `createReplayCoordinator` is the only way to construct a
 * `ReplayCoordinator`, and a `ReplayCoordinator`/`ReplayResumeStamper` manufactured from a bare
 * `SessionStore` + session name is repair authority conjured by naming a session, not proof of
 * holding the request's own coordinator. A behavior test cannot distinguish "the one coordinator
 * `runReplayCommand` created, threaded through" from "a second one built from the same
 * store/name" — both produce identical wire output — so this is a structural check over the
 * import graph, using the same `oxc-parser` AST approach as `scripts/layering/session-state.ts`.
 *
 * The divergence-report chain (`session-replay-resume.ts`, `session-replay-divergence.ts`,
 * `session-replay-target-verification.ts`, `session-replay-runtime-failure.ts`,
 * `session-replay-runtime-failure-response.ts`) reaches resume-stamping ONLY through a
 * `ReplayResumeStamper` value handed to it by its caller — never by importing the factory,
 * the P4a `session-replay-transaction.ts` projection, or a `SessionStore` binding of its own.
 * Every file in this chain therefore has the same structural bar: no import from
 * `session-store.ts` at all.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COORDINATOR_MODULE = 'src/daemon/session-replay-coordinator.ts';
const TRANSACTION_MODULE = 'src/daemon/session-replay-transaction.ts';
const SESSION_STORE_MODULE = 'src/daemon/session-store.ts';

const RUNTIME_FILE = 'src/daemon/replay/internal/native-command.ts';

/** The divergence-report chain: never a second `ReplayCoordinator`, never a bare `SessionStore`. */
const DIVERGENCE_CHAIN_FILES = [
  'src/daemon/replay/internal/session-replay-resume.ts',
  'src/daemon/replay/internal/session-replay-divergence.ts',
  'src/daemon/replay/internal/session-replay-target-verification.ts',
  'src/daemon/replay/internal/session-replay-runtime-failure.ts',
  'src/daemon/replay/internal/session-replay-runtime-failure-response.ts',
] as const;

type ImportSite = {
  file: string;
  kind: 'import' | 'dynamic-import' | 'named-reexport' | 'all-reexport';
  /** Repo-root-relative path the specifier resolves to, or `null` for an unresolved/external specifier. */
  target: string | null;
  /** A named import binding at this site: its exported name and whether IT is type-only. */
  bindings: { name: string; typeOnly: boolean }[];
  /** Whole-declaration `import type { ... }`. */
  declarationTypeOnly: boolean;
};

function listProductionSourceFiles(): string[] {
  const roots = ['src'];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const relPath = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      out.push(relPath);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

function resolveRelativeTarget(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  return resolved.startsWith('src/') ? resolved : null;
}

function collectImportSites(
  file: string,
  source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'),
): ImportSite[] {
  const parsed = parseSync(file, source);
  const sites: ImportSite[] = [];
  visitAst(parsed.program, (node) => {
    if (node.type === 'ImportDeclaration') {
      const target = importSourceTarget(file, node.source);
      const specifiers = node.specifiers as readonly Record<string, unknown>[];
      const bindings = specifiers
        .filter((specifier) => specifier.type === 'ImportSpecifier')
        .map((specifier) => ({
          name: identifierName(specifier.imported) ?? '',
          typeOnly: specifier.importKind === 'type',
        }));
      sites.push({
        file,
        kind: 'import',
        target,
        bindings,
        declarationTypeOnly: node.importKind === 'type',
      });
      return;
    }
    if (node.type === 'ImportExpression') {
      sites.push({
        file,
        kind: 'dynamic-import',
        target: importSourceTarget(file, node.source),
        bindings: [],
        declarationTypeOnly: false,
      });
      return;
    }
    if (node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportAllDeclaration') return;
    if (!node.source) return;
    const bindings =
      node.type === 'ExportNamedDeclaration'
        ? (node.specifiers as readonly Record<string, unknown>[])
            .filter((specifier) => specifier.type === 'ExportSpecifier')
            .map((specifier) => ({
              name: identifierName(specifier.local) ?? '',
              typeOnly: node.exportKind === 'type' || specifier.exportKind === 'type',
            }))
        : [];
    sites.push({
      file,
      kind: node.type === 'ExportNamedDeclaration' ? 'named-reexport' : 'all-reexport',
      target: importSourceTarget(file, node.source),
      bindings,
      declarationTypeOnly: node.exportKind === 'type',
    });
  });
  return sites;
}

function importSourceTarget(file: string, source: unknown): string | null {
  const value = constantSpecifier(source);
  return value === undefined ? null : resolveRelativeTarget(file, value);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function templateSpecifier(node: Record<string, unknown>): string | undefined {
  const expressions = node.expressions;
  const quasis = node.quasis;
  if (!Array.isArray(expressions) || expressions.length !== 0 || !Array.isArray(quasis)) {
    return undefined;
  }
  const quasi = objectRecord(quasis[0]);
  const value = quasi ? objectRecord(quasi.value) : undefined;
  return value && typeof value.cooked === 'string' ? value.cooked : undefined;
}

function wrappedSpecifier(node: Record<string, unknown>): string | undefined {
  return constantSpecifier(node.expression);
}

function binarySpecifier(node: Record<string, unknown>): string | undefined {
  if (node.operator !== '+') return undefined;
  const left = constantSpecifier(node.left);
  const right = constantSpecifier(node.right);
  return left !== undefined && right !== undefined ? left + right : undefined;
}

function literalSpecifier(node: Record<string, unknown>): string | undefined {
  return typeof node.value === 'string' ? node.value : undefined;
}

const SPECIFIER_READERS: Record<string, (node: Record<string, unknown>) => string | undefined> = {
  Literal: literalSpecifier,
  TemplateLiteral: templateSpecifier,
  TSAsExpression: wrappedSpecifier,
  TSTypeAssertion: wrappedSpecifier,
  ChainExpression: wrappedSpecifier,
  ParenthesizedExpression: wrappedSpecifier,
  BinaryExpression: binarySpecifier,
};

function constantSpecifier(value: unknown): string | undefined {
  const node = objectRecord(value);
  if (!node) return undefined;
  return SPECIFIER_READERS[String(node.type)]?.(node);
}

function importsValueBinding(site: ImportSite, name: string): boolean {
  if (site.declarationTypeOnly) return false;
  return site.bindings.some((binding) => binding.name === name && !binding.typeOnly);
}

function importsAnyBinding(site: ImportSite, target: string): boolean {
  return site.target === target;
}

type CoordinatorConstructionSite = Readonly<{
  file: string;
  kind: 'call' | 'dynamic-import';
  start: number;
}>;

function visitAst(value: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) visitAst(child, visitor);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  visitor(node);
  for (const child of Object.values(node)) visitAst(child, visitor);
}

function identifierName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const node = value as { type?: unknown; name?: unknown };
  return node.type === 'Identifier' && typeof node.name === 'string' ? node.name : undefined;
}

function coordinatorConstructionSites(
  file: string,
  source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'),
): CoordinatorConstructionSite[] {
  const parsed = parseSync(file, source);
  const bindings = coordinatorImportBindings(
    file,
    parsed.program.body as unknown as readonly Record<string, unknown>[],
  );
  const sites: CoordinatorConstructionSite[] = [];
  visitAst(parsed.program, (node) => {
    const site = coordinatorConstructionSiteForNode(file, node, bindings);
    if (site) sites.push(site);
  });
  return sites;
}

type CoordinatorImportBindings = Readonly<{
  direct: ReadonlySet<string>;
  namespace: ReadonlySet<string>;
}>;

function coordinatorImportBindings(
  file: string,
  body: readonly Record<string, unknown>[],
): CoordinatorImportBindings {
  const direct = new Set<string>();
  const namespace = new Set<string>();
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue;
    if (importSourceTarget(file, node.source) !== COORDINATOR_MODULE) continue;
    if (node.importKind === 'type') continue;
    for (const specifier of node.specifiers as readonly Record<string, unknown>[]) {
      addCoordinatorImportBinding(specifier, direct, namespace);
    }
  }
  return { direct, namespace };
}

function addCoordinatorImportBinding(
  specifier: Record<string, unknown>,
  direct: Set<string>,
  namespace: Set<string>,
): void {
  if (specifier.type === 'ImportSpecifier') {
    if (specifier.importKind === 'type') return;
    if (identifierName(specifier.imported) !== 'createReplayCoordinator') return;
    const localName = identifierName(specifier.local);
    if (localName) direct.add(localName);
    return;
  }
  if (specifier.type !== 'ImportNamespaceSpecifier') return;
  const localName = identifierName(specifier.local);
  if (localName) namespace.add(localName);
}

function coordinatorConstructionSiteForNode(
  file: string,
  node: Record<string, unknown>,
  bindings: CoordinatorImportBindings,
): CoordinatorConstructionSite | undefined {
  if (node.type === 'ImportExpression') return dynamicCoordinatorImportSite(file, node);
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee as Record<string, unknown> | undefined;
  return (
    directCoordinatorCallSite(file, node, callee, bindings) ??
    namespaceCoordinatorCallSite(file, node, callee, bindings)
  );
}

function directCoordinatorCallSite(
  file: string,
  node: Record<string, unknown>,
  callee: Record<string, unknown> | undefined,
  bindings: CoordinatorImportBindings,
): CoordinatorConstructionSite | undefined {
  const directCallee = identifierName(callee);
  if (!directCallee || !bindings.direct.has(directCallee)) return undefined;
  return { file, kind: 'call', start: Number(node.start) };
}

function namespaceCoordinatorCallSite(
  file: string,
  node: Record<string, unknown>,
  callee: Record<string, unknown> | undefined,
  bindings: CoordinatorImportBindings,
): CoordinatorConstructionSite | undefined {
  if (callee?.type !== 'MemberExpression' || callee.computed === true) return undefined;
  const namespace = identifierName(callee.object);
  const property = identifierName(callee.property);
  if (!namespace || property !== 'createReplayCoordinator' || !bindings.namespace.has(namespace)) {
    return undefined;
  }
  return { file, kind: 'call', start: Number(node.start) };
}

function dynamicCoordinatorImportSite(
  file: string,
  node: Record<string, unknown>,
): CoordinatorConstructionSite | undefined {
  if (importSourceTarget(file, node.source) !== COORDINATOR_MODULE) {
    return undefined;
  }
  return { file, kind: 'dynamic-import', start: Number(node.start) };
}

function coordinatorReexportSites(
  files: readonly string[],
  sourceOverrides: ReadonlyMap<string, string> = new Map(),
): ImportSite[] {
  return files.flatMap((file) =>
    collectImportSites(file, sourceOverrides.get(file)).filter(
      (site) =>
        (site.kind === 'named-reexport' || site.kind === 'all-reexport') &&
        site.target === COORDINATOR_MODULE,
    ),
  );
}

function unresolvedDynamicImportSites(
  files: readonly string[],
  sourceOverrides: ReadonlyMap<string, string> = new Map(),
): ImportSite[] {
  return files.flatMap((file) =>
    collectImportSites(file, sourceOverrides.get(file)).filter(
      (site) => site.kind === 'dynamic-import' && site.target === null,
    ),
  );
}

const PRODUCTION_FILES = listProductionSourceFiles();

test('createReplayCoordinator has exactly one production call site', () => {
  const sites = PRODUCTION_FILES.flatMap((file) => coordinatorConstructionSites(file));
  assert.deepEqual(
    sites.map(({ file }) => file).sort(),
    [RUNTIME_FILE],
    `createReplayCoordinator must have exactly one production construction call in ${RUNTIME_FILE} — ` +
      `a second caller can manufacture repair authority from a bare SessionStore + session name ` +
      `instead of using the request's own coordinator. Found: ${
        sites.map(({ file, kind }) => `${file} (${kind})`).join(', ') || '(none)'
      }`,
  );
  assert.deepEqual(
    coordinatorReexportSites(PRODUCTION_FILES),
    [],
    'createReplayCoordinator must not be re-exported from a production module',
  );
});

test('coordinator ownership scanning catches re-exports and unresolved dynamic imports', () => {
  const probe = 'src/daemon/replay/internal/probe.ts';
  const source = `
    export { createReplayCoordinator } from '../../session-replay-coordinator.ts';
    export * from '../../session-replay-coordinator.ts';
    const target = '../../session-replay-coordinator.ts';
    void import(target);
    void import(
      \`../../session-replay-coordinator.ts\`
    );
  `;
  const overrides = new Map([[probe, source]]);
  assert.equal(coordinatorReexportSites([probe], overrides).length, 2);
  assert.equal(unresolvedDynamicImportSites([probe], overrides).length, 1);
  assert.deepEqual(
    coordinatorConstructionSites(probe, source).map(({ kind }) => kind),
    ['dynamic-import'],
  );
});

test('coordinator ownership scanning catches aliases, namespaces, and dynamic imports', () => {
  const source = `
    import { createReplayCoordinator as makeCoordinator } from '../../session-replay-coordinator.ts';
    import * as coordinatorModule from '../../session-replay-coordinator.ts';
    makeCoordinator({});
    coordinatorModule.createReplayCoordinator({});
    void import('../../session-replay-coordinator.ts');
  `;
  assert.deepEqual(
    coordinatorConstructionSites('src/daemon/replay/internal/probe.ts', source).map(
      ({ kind }) => kind,
    ),
    ['call', 'call', 'dynamic-import'],
  );
});

test('daemon replay production files never import the P4a ReplaySessionTransaction projection', () => {
  const offenders = PRODUCTION_FILES.filter(
    (file) =>
      file.startsWith('src/daemon/replay/') &&
      collectImportSites(file).some((site) => importsAnyBinding(site, TRANSACTION_MODULE)),
  );
  assert.deepEqual(
    offenders,
    [],
    `daemon replay must reach repair-transaction writes through ReplayCoordinator; found: ${offenders.join(', ')}`,
  );
});

test('the divergence-report chain never imports the coordinator factory', () => {
  for (const file of DIVERGENCE_CHAIN_FILES) {
    for (const site of collectImportSites(file)) {
      const constructsCoordinator =
        site.target === COORDINATOR_MODULE && importsValueBinding(site, 'createReplayCoordinator');
      assert.equal(
        constructsCoordinator,
        false,
        `${file} imports createReplayCoordinator — it must receive a ReplayResumeStamper from ` +
          `its caller instead of constructing a second coordinator from a session name.`,
      );
    }
  }
});

test('the divergence-report chain never imports the P4a ReplaySessionTransaction projection', () => {
  for (const file of DIVERGENCE_CHAIN_FILES) {
    for (const site of collectImportSites(file)) {
      assert.equal(
        importsAnyBinding(site, TRANSACTION_MODULE),
        false,
        `${file} imports session-replay-transaction.ts directly — repair-transaction writes must ` +
          `route through the request's ReplayCoordinator/ReplayResumeStamper, never this P4a ` +
          `projection reached from a lower handler.`,
      );
    }
  }
});

test('the divergence-report chain never imports SessionStore', () => {
  for (const file of DIVERGENCE_CHAIN_FILES) {
    for (const site of collectImportSites(file)) {
      assert.equal(
        importsAnyBinding(site, SESSION_STORE_MODULE),
        false,
        `${file} imports session-store.ts — the divergence-report chain must receive the ` +
          `request's ReplayResumeStamper and never hold a SessionStore binding of its own.`,
      );
    }
  }
});

test('the divergence-report chain rejects unresolved dynamic imports', () => {
  assert.deepEqual(
    unresolvedDynamicImportSites(DIVERGENCE_CHAIN_FILES),
    [],
    'protected replay imports must resolve their dynamic specifier or fail closed',
  );
});

test('SessionStore ownership scanning catches dynamic imports and re-exports', () => {
  const sites = collectImportSites(
    'src/daemon/replay/internal/probe.ts',
    [
      "void import('../../session-store.ts');",
      "export { SessionStore } from '../../session-store.ts';",
      "export * from '../../session-store.ts';",
    ].join('\n'),
  );
  assert.equal(sites.filter((site) => importsAnyBinding(site, SESSION_STORE_MODULE)).length, 3);
});
