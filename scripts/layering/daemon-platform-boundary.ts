import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { isProductionSourceFile } from './tracked-sources.ts';
import type { LayeringViolation } from './model.ts';

/**
 * R65 is the terminal daemon/platform boundary.
 *
 * R3's old platforms seam deliberately tolerated dynamic and type-only edges while the
 * request-bound runtime migration was in flight. That tolerance is not a terminal property:
 * either edge still makes the daemon depend on a concrete platform implementation. This policy
 * closes the boundary completely for tracked production daemon sources. It is kept independent
 * from `check.ts` until the remaining live edges are removed, so the migration can plant and
 * verify the red forms before making the repository-wide gate fail.
 *
 * The module record supplies static imports and re-exports; the AST supplies dynamic imports and
 * TypeScript import types. Reading syntax through oxc-parser, rather than searching source text,
 * means comments and string data cannot masquerade as dependencies.
 */

export const DAEMON_PLATFORM_BOUNDARY_RULE = 'R65 daemon-platform-boundary';

/** A tracked production source passed to the standalone policy. */
export type ProductionSource = Readonly<{ path: string; source: string }>;

export type DaemonPlatformDependencyKind =
  | 'static import'
  | 'type-only import'
  | 'dynamic import'
  | 'type import'
  | 'require'
  | 'import equals'
  | 're-export'
  | 'type-only re-export';

export type DaemonPlatformDependency = Readonly<{
  file: string;
  line: number;
  spec: string;
  kind: DaemonPlatformDependencyKind;
  target: string;
}>;

const PLATFORM_PACKAGE = /^@agent-device\/platform-[^/]+(?:\/|$)/;
const LEGACY_PLATFORM_ROOT = 'src/platforms';

function lineOf(source: string, offset: number | null | undefined): number {
  const start = typeof offset === 'number' && offset >= 0 ? offset : 0;
  return source.slice(0, start).split('\n').length;
}

function sourceLiteral(node: Record<string, unknown>, source: string): string | undefined {
  const start = node.start;
  const end = node.end;
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  const raw = source.slice(start, end);
  const quote = raw[0];
  if ((quote !== "'" && quote !== '"' && quote !== '`') || raw.at(-1) !== quote) return undefined;
  const body = raw.slice(1, -1);
  if (quote === '`' && body.includes('${')) return undefined;
  return body;
}

function constantSpecifier(node: unknown, source: string): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  if (record.type === 'ParenthesizedExpression') {
    return constantSpecifier(record.expression, source);
  }
  if (
    record.type === 'TSAsExpression' ||
    record.type === 'TSTypeAssertion' ||
    record.type === 'TSSatisfiesExpression' ||
    record.type === 'TSNonNullExpression'
  ) {
    return constantSpecifier(record.expression, source);
  }
  if (record.type === 'Literal' && typeof record.value === 'string') {
    // oxc-parser currently represents a template-literal TS import type as an empty Literal with
    // no raw value. Recover its exact no-substitution source span so `import(`platform`)` cannot
    // bypass the type-only boundary.
    return record.value || sourceLiteral(record, source);
  }
  if (record.type === 'BinaryExpression' && record.operator === '+') {
    const left = constantSpecifier(record.left, source);
    const right = constantSpecifier(record.right, source);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (record.type !== 'TemplateLiteral') return undefined;
  const expressions = record.expressions;
  const quasis = record.quasis;
  if (!Array.isArray(expressions) || !Array.isArray(quasis)) return undefined;
  const parts: string[] = [];
  for (let index = 0; index < quasis.length; index++) {
    const quasi = quasis[index];
    if (quasi === null || typeof quasi !== 'object') return undefined;
    const value = (quasi as Record<string, unknown>).value;
    if (value === null || typeof value !== 'object') return undefined;
    const cooked = (value as Record<string, unknown>).cooked;
    if (typeof cooked !== 'string') return undefined;
    parts.push(cooked);
    if (index < expressions.length) {
      const expression = constantSpecifier(expressions[index], source);
      if (expression === undefined) return undefined;
      parts.push(expression);
    }
  }
  return parts.join('');
}

function visitAst(node: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visitAst(child, visitor);
    return;
  }
  const record = node as Record<string, unknown>;
  visitor(record);
  for (const child of Object.values(record)) visitAst(child, visitor);
}

function resolveRelative(file: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  return path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
}

function targetFor(file: string, spec: string): string | undefined {
  if (PLATFORM_PACKAGE.test(spec)) return spec;
  const resolved = resolveRelative(file, spec);
  if (!resolved) return undefined;
  return resolved === LEGACY_PLATFORM_ROOT || resolved.startsWith(`${LEGACY_PLATFORM_ROOT}/`)
    ? resolved
    : undefined;
}

function dependency(
  file: string,
  source: string,
  kind: DaemonPlatformDependencyKind,
  spec: string,
  offset: number | null | undefined,
): DaemonPlatformDependency | undefined {
  const target = targetFor(file, spec);
  if (!target) return undefined;
  return { file, line: lineOf(source, offset), spec, kind, target };
}

function staticDependencies(file: string, source: string): DaemonPlatformDependency[] {
  const parsed = parseSync(file, source);
  const dependencies: DaemonPlatformDependency[] = [];

  for (const entry of parsed.module.staticImports) {
    const kind: DaemonPlatformDependencyKind =
      entry.entries.length > 0 && entry.entries.every(({ isType }) => isType)
        ? 'type-only import'
        : 'static import';
    const found = dependency(file, source, kind, entry.moduleRequest.value, entry.start);
    if (found) dependencies.push(found);
  }

  for (const statement of parsed.module.staticExports) {
    const moduleRequest = statement.entries.find((entry) => entry.moduleRequest)?.moduleRequest;
    if (!moduleRequest) continue;
    const entries = statement.entries.filter((entry) => entry.moduleRequest);
    const kind: DaemonPlatformDependencyKind =
      entries.length > 0 && entries.every(({ isType }) => isType)
        ? 'type-only re-export'
        : 're-export';
    const found = dependency(file, source, kind, moduleRequest.value, statement.start);
    if (found) dependencies.push(found);
  }

  return dependencies;
}

function dynamicDependencies(file: string, source: string): DaemonPlatformDependency[] {
  const parsed = parseSync(file, source);
  const dependencies: DaemonPlatformDependency[] = [];
  const requireBindings = new Set(['require']);
  const createRequireBindings = new Set<string>();
  const moduleNamespaces = new Set<string>();
  const createdRequireBindings = new Set<string>();

  visitAst(parsed.program, (node) => {
    if (node.type === 'ImportDeclaration') {
      const spec = constantSpecifier(node.source, source);
      if (spec !== 'node:module' && spec !== 'module') return;
      for (const item of (node.specifiers as Array<Record<string, unknown>> | undefined) ?? []) {
        const local = item.local as Record<string, unknown> | undefined;
        if (typeof local?.name !== 'string') continue;
        if (item.type === 'ImportNamespaceSpecifier' || item.type === 'ImportDefaultSpecifier') {
          moduleNamespaces.add(local.name);
        }
        const imported = item.imported as Record<string, unknown> | undefined;
        if (imported?.name === 'createRequire') createRequireBindings.add(local.name);
      }
      return;
    }
    if (node.type !== 'VariableDeclarator') return;
    const id = node.id as Record<string, unknown> | undefined;
    const init = node.init as Record<string, unknown> | undefined;
    if (!id || !init) return;
    if (id.type === 'ObjectPattern' && isNodeModuleRequire(init, requireBindings, source)) {
      for (const property of (id.properties as Array<Record<string, unknown>> | undefined) ?? []) {
        const key = property.key as Record<string, unknown> | undefined;
        const value = property.value as Record<string, unknown> | undefined;
        if (key?.name === 'createRequire' && value?.type === 'Identifier') {
          createRequireBindings.add(String(value.name));
        }
      }
      return;
    }
    if (id.type !== 'Identifier' || typeof id.name !== 'string') return;
    if (init.type === 'Identifier' && requireBindings.has(String(init.name))) {
      requireBindings.add(id.name);
      return;
    }
    if (init.type === 'Identifier' && createdRequireBindings.has(String(init.name))) {
      createdRequireBindings.add(id.name);
      return;
    }
    if (isCreateRequireCall(init, createRequireBindings, moduleNamespaces)) {
      createdRequireBindings.add(id.name);
    }
  });
  visitAst(parsed.program, (node) => {
    const callee = node.callee as Record<string, unknown> | undefined;
    const isRequire =
      node.type === 'CallExpression' &&
      callee?.type === 'Identifier' &&
      (requireBindings.has(String(callee.name)) || createdRequireBindings.has(String(callee.name)));
    const isInlineCreateRequire =
      node.type === 'CallExpression' &&
      callee?.type === 'CallExpression' &&
      isCreateRequireCall(callee, createRequireBindings, moduleNamespaces);
    const isModuleRequire =
      node.type === 'CallExpression' &&
      callee?.type === 'MemberExpression' &&
      memberName(callee) === 'require';
    const kind: DaemonPlatformDependencyKind | undefined =
      node.type === 'ImportExpression'
        ? 'dynamic import'
        : node.type === 'TSImportType'
          ? 'type import'
          : node.type === 'TSImportEqualsDeclaration'
            ? 'import equals'
            : isRequire || isInlineCreateRequire || isModuleRequire
              ? 'require'
              : undefined;
    if (!kind) return;
    const specifierNode =
      node.type === 'TSImportEqualsDeclaration'
        ? (node.moduleReference as Record<string, unknown> | undefined)?.expression
        : isRequire || isInlineCreateRequire || isModuleRequire
          ? (node.arguments as unknown[] | undefined)?.[0]
          : node.source;
    const spec = constantSpecifier(specifierNode, source);
    if (!spec) return;
    const found = dependency(file, source, kind, spec, node.start as number | undefined);
    if (found) dependencies.push(found);
  });
  return dependencies;
}

function isNodeModuleRequire(
  node: Record<string, unknown>,
  requireBindings: ReadonlySet<string>,
  source: string,
): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as Record<string, unknown> | undefined;
  if (callee?.type !== 'Identifier' || !requireBindings.has(String(callee.name))) return false;
  const spec = constantSpecifier((node.arguments as unknown[] | undefined)?.[0], source);
  return spec === 'node:module' || spec === 'module';
}

function memberName(node: Record<string, unknown>): string | undefined {
  const property = node.property as Record<string, unknown> | undefined;
  if (property?.type === 'Identifier') return property.name as string | undefined;
  return typeof property?.value === 'string' ? property.value : undefined;
}

function isCreateRequireCall(
  node: Record<string, unknown>,
  bindings: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as Record<string, unknown> | undefined;
  if (callee?.type === 'Identifier') return bindings.has(String(callee.name));
  if (callee?.type !== 'MemberExpression' || memberName(callee) !== 'createRequire') return false;
  const object = callee.object as Record<string, unknown> | undefined;
  return object?.type === 'Identifier' && namespaces.has(String(object.name));
}

function tripleSlashDependencies(file: string, source: string): DaemonPlatformDependency[] {
  const dependencies: DaemonPlatformDependency[] = [];
  const comments = parseSync(file, source).comments as readonly {
    type: string;
    value: string;
    start: number;
    end: number;
  }[];
  const pattern = /^\s*\/\/\/\s*<reference\s+(?:types|path)\s*=\s*["']([^"']+)["'][^>]*\/?>/gm;
  for (const match of source.matchAll(pattern)) {
    const spec = match[1];
    const start = match.index;
    const end = start + match[0].length;
    const directiveComment = comments.some(
      (comment) =>
        comment.type === 'Line' &&
        comment.start >= start &&
        comment.end <= end &&
        comment.value.trimStart().startsWith('/'),
    );
    if (!spec || !directiveComment) continue;
    const found = dependency(file, source, 'type import', spec, match.index);
    if (found) dependencies.push(found);
  }
  return dependencies;
}

function dependencyMessage(dependency: DaemonPlatformDependency): string {
  return (
    `${dependency.kind} '${dependency.spec}' resolves to concrete platform code ` +
    `(${dependency.target}); production src/daemon/ must use the request-bound runtime contract`
  );
}

/**
 * Find every concrete platform dependency in tracked production `src/daemon/**` sources.
 *
 * The input is intentionally source records rather than a filesystem walk. Callers use the
 * canonical tracked-production enumerator, while synthetic tests can plant one edge at a time
 * without touching the live tree. Non-daemon, test, and untracked-shaped records are ignored.
 */
export function findDaemonPlatformDependencies(
  sources: readonly ProductionSource[],
): DaemonPlatformDependency[] {
  return sources
    .filter(({ path: file }) => file.startsWith('src/daemon/') && isProductionSourceFile(file))
    .flatMap(({ path: file, source }) => [
      ...staticDependencies(file, source),
      ...dynamicDependencies(file, source),
      ...tripleSlashDependencies(file, source),
    ])
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.kind.localeCompare(right.kind),
    );
}

/** The gate-facing projection of `findDaemonPlatformDependencies`. */
export function daemonPlatformBoundaryViolations(
  sources: readonly ProductionSource[],
): LayeringViolation[] {
  const importViolations = findDaemonPlatformDependencies(sources).map((found) => ({
    rule: DAEMON_PLATFORM_BOUNDARY_RULE,
    file: found.file,
    line: found.line,
    message: dependencyMessage(found),
  }));
  return [...importViolations, ...cleanupDispatchViolations(sources)];
}

const CLEANUP_ORCHESTRATORS = new Set([
  'src/daemon/session-teardown.ts',
  'src/daemon/handlers/session-close-lifecycle-teardown.ts',
  'src/daemon/handlers/snapshot-session.ts',
]);

function cleanupDispatchViolations(sources: readonly ProductionSource[]): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const { path: file, source } of sources) {
    if (!CLEANUP_ORCHESTRATORS.has(file)) continue;
    visitAst(parseSync(file, source).program, (node) => {
      const platformMember = node.type === 'MemberExpression' && memberName(node) === 'platform';
      const destructuresPlatform =
        node.type === 'VariableDeclarator' &&
        (node.id as Record<string, unknown> | undefined)?.type === 'ObjectPattern' &&
        (
          ((node.id as Record<string, unknown>).properties as Array<Record<string, unknown>>) ?? []
        ).some(
          (property) =>
            memberName(property) === 'platform' ||
            (property.key as Record<string, unknown> | undefined)?.name === 'platform',
        );
      const callee = node.callee as Record<string, unknown> | undefined;
      const platformPredicate =
        node.type === 'CallExpression' &&
        callee?.type === 'Identifier' &&
        /^(?:is|has).*(?:Android|Apple|Ios|Web|Harmony|Vega|Linux)/.test(String(callee.name));
      if (!platformMember && !destructuresPlatform && !platformPredicate) return;
      violations.push({
        rule: DAEMON_PLATFORM_BOUNDARY_RULE,
        file,
        line: lineOf(source, node.start as number | undefined),
        message:
          'daemon cleanup orchestration may not select a concrete platform; invoke the typed root-composed cleanup capability',
      });
    });
  }
  return violations;
}

/** Alias kept explicit for callers that name all layering checks `check*`. */
export const checkDaemonPlatformBoundary = daemonPlatformBoundaryViolations;
