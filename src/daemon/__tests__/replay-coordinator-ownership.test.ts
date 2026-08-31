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
 * the P4a `session-replay-transaction.ts` projection, or a live `SessionStore` binding of its
 * own. A type-only reference to `SessionStore` (an already-typed parameter whose value some
 * upstream caller supplies) is not authority and is allowed for files with an unrelated,
 * legitimate reason to type one — `session-replay-resume.ts` has none post-fix, so it is held to
 * a stricter "no `session-store.ts` import at all" bar than the other four.
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

/** Files in `DIVERGENCE_CHAIN_FILES` allowed a TYPE-ONLY `session-store.ts` reference. */
const SESSION_STORE_TYPE_ONLY_ALLOWED = new Set<string>([
  'src/daemon/replay/internal/session-replay-divergence.ts',
  'src/daemon/replay/internal/session-replay-target-verification.ts',
  'src/daemon/replay/internal/session-replay-runtime-failure.ts',
]);

type ImportSite = {
  file: string;
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

function collectImportSites(file: string): ImportSite[] {
  const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const parsed = parseSync(file, source);
  const sites: ImportSite[] = [];
  for (const node of parsed.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const target = resolveRelativeTarget(file, node.source.value);
    const bindings = node.specifiers
      .filter((specifier) => specifier.type === 'ImportSpecifier')
      .map((specifier) => ({
        name: specifier.imported.type === 'Identifier' ? specifier.imported.name : '',
        typeOnly: specifier.importKind === 'type',
      }));
    sites.push({
      file,
      target,
      bindings,
      declarationTypeOnly: node.importKind === 'type',
    });
  }
  return sites;
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
    const source = node.source as { value?: unknown };
    if (typeof source.value !== 'string') continue;
    if (resolveRelativeTarget(file, source.value) !== COORDINATOR_MODULE) continue;
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
  const sourceNode = node.source as { type?: unknown; value?: unknown } | undefined;
  if (
    sourceNode?.type !== 'Literal' ||
    typeof sourceNode.value !== 'string' ||
    resolveRelativeTarget(file, sourceNode.value) !== COORDINATOR_MODULE
  ) {
    return undefined;
  }
  return { file, kind: 'dynamic-import', start: Number(node.start) };
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

test('session-replay-resume.ts holds no SessionStore binding at all', () => {
  const file = 'src/daemon/replay/internal/session-replay-resume.ts';
  for (const site of collectImportSites(file)) {
    assert.equal(
      importsAnyBinding(site, SESSION_STORE_MODULE),
      false,
      `${file} imports session-store.ts — after the P4b resume-stamper fix it has no legitimate ` +
        `remaining reason to hold a SessionStore binding (value or type); it can only act through ` +
        `the ReplayResumeStamper it is handed.`,
    );
  }
});

test('the remaining divergence-report chain holds SessionStore only as a type', () => {
  for (const file of DIVERGENCE_CHAIN_FILES) {
    if (!SESSION_STORE_TYPE_ONLY_ALLOWED.has(file)) continue;
    for (const site of collectImportSites(file)) {
      if (site.target !== SESSION_STORE_MODULE) continue;
      const valueImported = site.bindings.some(
        (binding) =>
          binding.name === 'SessionStore' && !binding.typeOnly && !site.declarationTypeOnly,
      );
      assert.equal(
        valueImported,
        false,
        `${file} value-imports SessionStore from session-store.ts — it may only reference the ` +
          `type (import type { SessionStore }) to annotate a parameter handed to it; a value ` +
          `import is capability to construct or statically call the store, which this file must ` +
          `never hold.`,
      );
    }
  }
});
