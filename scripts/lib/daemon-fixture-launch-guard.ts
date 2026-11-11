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
  for (const { file, source } of files) {
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
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        dependencies.push(resolved.endsWith('.ts') ? resolved : `${resolved}.ts`);
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

/** Checks mocked monitored launches in a daemon-fixture family module. */
export function daemonFixtureLaunchViolations(source: string, file: string): string[] {
  const parsed = parseSync(file, source);
  if (parsed.errors.length)
    return [`${file}: cannot parse daemon-fixture module: ${parsed.errors[0]!.message}`];
  const launchers = new Set<string>();
  const planners = new Set<string>();
  const bindings = new Map<string, AstNode>();
  visitAst(parsed.program, (node) => {
    if (node.type === 'ImportSpecifier') {
      const imported = propertyName(node.imported);
      const name = propertyName(node.local);
      if (name && imported === 'runCmdDetachedMonitored') launchers.add(name);
      if (name && imported === 'planRegisteredDaemonLaunches') planners.add(name);
    }
    if (
      node.type === 'VariableDeclarator' &&
      asNode(node.id)?.type === 'Identifier' &&
      asNode(node.init)
    )
      bindings.set(String(asNode(node.id)!.name), asNode(node.init)!);
    if (node.type === 'Identifier' && asNode(node.typeAnnotation)) {
      const annotation = asNode(node.typeAnnotation)!;
      const text = source.slice(Number(annotation.start), Number(annotation.end));
      if (text.includes('Mock<') && [...launchers].some((name) => text.includes(`typeof ${name}`)))
        launchers.add(String(node.name));
    }
  });
  function resolves(node: unknown, names: Set<string>, seen = new Set<string>()): boolean {
    const value = asNode(node);
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
  function initializationViolation(node: AstNode): string | undefined {
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
    const argument = asNode(nodeList(node.arguments)[0]);
    if (
      method.startsWith('mockImplementation') &&
      argument?.type === 'CallExpression' &&
      resolves(argument.callee, planners)
    )
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
