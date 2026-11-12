import { parseSync } from 'oxc-parser';
import path from 'node:path';
import {
  asNode,
  memberName,
  nodeList,
  propertyName,
  visitAst,
  type AstNode,
} from '../layering/layering-ast.ts';

type FixtureSource = Readonly<{ file: string; source: string }>;

/** Follows local fixture imports so a renamed helper or a new consumer cannot leave the guard. */
export function scanDaemonFixtureLaunches(files: readonly FixtureSource[]): string[] {
  const family = new Set<string>();
  const imports = new Map<string, string[]>();
  const paths = new Set(files.map(({ file }) => file));
  const candidates = familyCandidates(files, paths);
  for (const { file, source } of files) {
    if (!candidates.has(file)) continue;
    const parsed = parseSync(file, source);
    if (parsed.errors.length)
      throw new Error(`Cannot scan daemon fixtures in ${file}: ${parsed.errors[0]!.message}`);
    const dependencies: string[] = [];
    visitAst(parsed.program, (node) => {
      if (
        node.type === 'CallExpression' &&
        memberName(asNode(node.callee) ?? {}) === 'createRegisteredDaemonFixtures'
      )
        family.add(file);
      if (
        node.type !== 'ImportDeclaration' &&
        node.type !== 'ExportNamedDeclaration' &&
        node.type !== 'ExportAllDeclaration'
      )
        return;
      const specifier = asNode(node.source)?.value;
      if (typeof specifier !== 'string') return;
      if (
        nodeList(node.specifiers).some(
          (entry) => propertyName(asNode(entry)?.imported) === 'createRegisteredDaemonFixtures',
        )
      )
        family.add(file);
      if (specifier.startsWith('.')) {
        const dependency = resolveLocalImport(file, specifier, paths);
        if (dependency) dependencies.push(dependency);
      }
    });
    imports.set(file, dependencies);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, dependencies] of imports) {
      if (!family.has(file) && dependencies.some((dependency) => family.has(dependency))) {
        family.add(file);
        changed = true;
      }
    }
  }
  return files
    .filter(({ file }) => family.has(file))
    .flatMap(({ file, source }) => daemonFixtureLaunchViolations(source, file));
}

const FAMILY_SEED = 'createRegisteredDaemonFixtures';
const RELATIVE_SPECIFIER = /['"](\.{1,2}(?:\/[^'"\n]*)?)['"]/g;

/**
 * A superset of the family found from text alone: files that name the seed helper, plus every file
 * that reaches one through a quoted relative path. Only these need the AST pass, and the exact
 * family is always inside this set.
 */
function familyCandidates(
  files: readonly FixtureSource[],
  paths: ReadonlySet<string>,
): Set<string> {
  const seeds = files.filter(({ source }) => source.includes(FAMILY_SEED)).map(({ file }) => file);
  return reachedFrom(seeds, quotedRelativeImporters(files, paths));
}

/** Maps each file to the files whose quoted relative paths resolve to it. */
function quotedRelativeImporters(
  files: readonly FixtureSource[],
  paths: ReadonlySet<string>,
): Map<string, string[]> {
  const importers = new Map<string, string[]>();
  for (const { file, source } of files) {
    for (const match of source.matchAll(RELATIVE_SPECIFIER)) {
      const dependency = resolveLocalImport(file, match[1]!, paths);
      if (dependency) importers.set(dependency, [...(importers.get(dependency) ?? []), file]);
    }
  }
  return importers;
}

function reachedFrom(
  seeds: readonly string[],
  importers: ReadonlyMap<string, string[]>,
): Set<string> {
  const reached = new Set(seeds);
  const pending = [...seeds];
  while (pending.length > 0) {
    for (const importer of importers.get(pending.pop()!) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      pending.push(importer);
    }
  }
  return reached;
}

function resolveLocalImport(
  file: string,
  specifier: string,
  paths: ReadonlySet<string>,
): string | undefined {
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
  return [
    resolved,
    resolved.replace(/\.js$/, '.ts'),
    `${resolved}.ts`,
    `${resolved}/index.ts`,
  ].find((candidate) => paths.has(candidate));
}

/** Checks mocked monitored launches in a daemon-fixture family module. */
export function daemonFixtureLaunchViolations(source: string, file: string): string[] {
  const parsed = parseSync(file, source);
  if (parsed.errors.length)
    return [`${file}: cannot parse daemon-fixture module: ${parsed.errors[0]!.message}`];
  const launchers = new Set<string>();
  const planners = new Set<string>();
  const bindings = new Map<string, AstNode>();
  const destructuredProperties = new Set<AstNode>();
  visitAst(parsed.program, (node) => {
    switch (node.type) {
      case 'ImportSpecifier': {
        const imported = propertyName(node.imported);
        const name = propertyName(node.local);
        if (name && imported === 'runCmdDetachedMonitored') launchers.add(name);
        if (name && imported === 'planRegisteredDaemonLaunches') planners.add(name);
        return;
      }
      case 'VariableDeclarator': {
        const name = propertyName(node.id);
        const value = asNode(node.init);
        if (name && value) bindings.set(name, value);
        return;
      }
      case 'ObjectPattern':
        recordDestructuredLaunchers(node);
        return;
      case 'Identifier': {
        const annotation = asNode(node.typeAnnotation);
        if (!annotation) return;
        const text = source.slice(Number(annotation.start), Number(annotation.end));
        if (
          /\bMock\w*\s*</.test(text) &&
          [...launchers].some((name) => text.includes(`typeof ${name}`))
        )
          launchers.add(String(node.name));
      }
    }
  });
  function recordDestructuredLaunchers(node: AstNode): void {
    for (const property of nodeList(node.properties)) {
      const entry = asNode(property);
      if (!entry) continue;
      destructuredProperties.add(entry);
      if (propertyName(entry.key) !== 'runCmdDetachedMonitored') continue;
      const name = propertyName(entry.value);
      if (name) launchers.add(name);
    }
  }
  function resolves(node: unknown, names: Set<string>, seen = new Set<string>()): boolean {
    const value = unwrap(node);
    if (!value) return false;
    if (value.type === 'Identifier') {
      const name = String(value.name);
      if (names.has(name)) return true;
      if (seen.has(name)) return false;
      seen.add(name);
      return resolves(bindings.get(name), names, seen);
    }
    if (value.type === 'CallExpression' && memberName(asNode(value.callee) ?? {}) === 'mocked')
      return resolves(nodeList(value.arguments)[0], names, seen);
    if (value.type === 'MemberExpression' && memberName(value) === 'runCmdDetachedMonitored')
      return names === launchers;
    if (value.type === 'CallExpression' && memberName(asNode(value.callee) ?? {}) === 'spyOn')
      return (
        names === launchers &&
        asNode(nodeList(value.arguments)[1])?.value === 'runCmdDetachedMonitored'
      );
    return false;
  }
  function isLaunchPlan(node: unknown, seen = new Set<string>()): boolean {
    const value = unwrap(node);
    if (!value) return false;
    if (value.type === 'Identifier') {
      const name = String(value.name);
      if (seen.has(name)) return false;
      seen.add(name);
      return isLaunchPlan(bindings.get(name), seen);
    }
    return value.type === 'CallExpression' && resolves(value.callee, planners);
  }
  function initializationViolation(node: AstNode): string | undefined {
    if (destructuredProperties.has(node)) return;
    if (node.type !== 'Property' || propertyName(node.key) !== 'runCmdDetachedMonitored') return;
    const value = asNode(node.value);
    if (
      value?.type === 'CallExpression' &&
      memberName(asNode(value.callee) ?? {}) === 'fn' &&
      nodeList(value.arguments).length === 0
    )
      return;
    return 'initialize daemon launcher mocks with vi.fn() and install a shared launch plan';
  }
  function detachedMethodViolation(node: AstNode): string | undefined {
    if (
      node.type === 'VariableDeclarator' &&
      asNode(node.id)?.type === 'ObjectPattern' &&
      resolves(node.init, launchers)
    ) {
      return 'do not detach daemon launcher mock methods from their guarded receiver';
    }
  }
  function launchCallViolation(node: AstNode): string | undefined {
    if (node.type !== 'CallExpression') return;
    const callee = asNode(node.callee);
    if (resolves(callee, launchers))
      return 'do not invoke a raw monitored launcher in the daemon fixture family';
    if (callee?.type !== 'MemberExpression' || !resolves(callee.object, launchers)) return;
    const method = memberName(callee);
    if (!method || (callee.computed === true && asNode(callee.property)?.type !== 'Literal')) {
      return 'dynamic daemon launcher mock methods are not supported';
    }
    if (
      !/^(mockImplementation|mockReturnValue|mockResolvedValue|mockRejectedValue)(Once)?$/.test(
        method,
      )
    )
      return;
    if (method.startsWith('mockImplementation') && isLaunchPlan(nodeList(node.arguments)[0]))
      return;
    return 'mocked daemon launch must use planRegisteredDaemonLaunches';
  }
  const violations: string[] = [];
  visitAst(parsed.program, (node) => {
    const message =
      initializationViolation(node) ?? detachedMethodViolation(node) ?? launchCallViolation(node);
    if (message)
      violations.push(
        `${file}:${source.slice(0, Number(node.start)).split('\n').length}: ${message}`,
      );
  });
  return violations;
}

function unwrap(node: unknown): AstNode | undefined {
  let value = asNode(node);
  while (
    value &&
    [
      'ParenthesizedExpression',
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TSTypeAssertion',
    ].includes(String(value.type))
  ) {
    value = asNode(value.expression);
  }
  return value;
}
