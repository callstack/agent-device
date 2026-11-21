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
  const paths = new Set(files.map(({ file }) => file));
  const parsed = new Map<string, ParsedFixtureSource>();
  const parse = ({ file, source }: FixtureSource): ParsedFixtureSource => {
    let entry = parsed.get(file);
    if (!entry) parsed.set(file, (entry = parseFixtureSource(file, source)));
    return entry;
  };
  const resolvedImports = new Map<string, ReadonlySet<string>>();
  const importsOf = (entry: FixtureSource): ReadonlySet<string> => {
    let imports = resolvedImports.get(entry.file);
    if (!imports) {
      imports = new Set(
        parse(entry).dependencies.flatMap(
          (specifier) => resolveLocalImport(entry.file, specifier, paths) ?? [],
        ),
      );
      resolvedImports.set(entry.file, imports);
    }
    return imports;
  };
  // Only a file that could name the seed needs its tree walked; everything else joins through imports.
  const family = new Set(
    files
      .filter((entry) => mayNameSeed(entry.source) && namesSeed(parse(entry).program()))
      .map(({ file }) => file),
  );
  // Parsing every file to build the whole import graph costs seconds, so only a possible importer
  // of a family member is parsed.
  const { escaped, possibleImporters } = indexPossibleImporters(files, paths);
  const pending = [...family];
  while (pending.length > 0) {
    const member = pending.pop()!;
    for (const candidate of [...escaped, ...(possibleImporters.get(member) ?? [])]) {
      if (family.has(candidate.file) || !importsOf(candidate).has(member)) continue;
      family.add(candidate.file);
      pending.push(candidate.file);
    }
  }
  return files
    .filter(({ file }) => family.has(file))
    .flatMap(({ file, source }) => daemonFixtureLaunchViolations(source, file));
}

/**
 * Indexes each unescaped file under every path its relative requests could resolve to. An escape
 * can spell any request, so a file with one is a possible importer of every member.
 */
function indexPossibleImporters(files: readonly FixtureSource[], paths: ReadonlySet<string>) {
  const escaped: FixtureSource[] = [];
  const possibleImporters = new Map<string, FixtureSource[]>();
  for (const entry of files) {
    if (entry.source.includes('\\')) {
      escaped.push(entry);
      continue;
    }
    const targets = quotedRelativeText(entry.source).flatMap(
      (text) => resolveLocalImport(entry.file, text, paths) ?? [],
    );
    for (const target of new Set(targets)) {
      const importers = possibleImporters.get(target);
      if (importers) importers.push(entry);
      else possibleImporters.set(target, [entry]);
    }
  }
  return { escaped, possibleImporters };
}

/**
 * The text of every quote pair that opens with `.` on one line, overlaps included. In a source
 * without escapes, a module request's text is its value, so this is a superset of its relative
 * requests.
 */
function quotedRelativeText(source: string): string[] {
  return [...source.matchAll(/(?=(['"])(\.(?:(?!\1)[^\n\r])*)\1)/g)].map((match) => match[2]!);
}

type ParsedFixtureSource = Readonly<{ program: () => AstNode; dependencies: readonly string[] }>;

/** Relative module requests come from the parser's module record, so escaped specifiers resolve too. */
function parseFixtureSource(file: string, source: string): ParsedFixtureSource {
  const parsed = parseSync(file, source);
  if (parsed.errors.length)
    throw new Error(`Cannot scan daemon fixtures in ${file}: ${parsed.errors[0]!.message}`);
  const requests = [
    ...parsed.module.staticImports.map((entry) => entry.moduleRequest.value),
    ...parsed.module.staticExports.flatMap((entry) =>
      entry.entries.flatMap((item) => (item.moduleRequest ? [item.moduleRequest.value] : [])),
    ),
  ];
  return {
    // The tree is built on first access, so only seed candidates pay for it.
    program: () => parsed.program as unknown as AstNode,
    dependencies: requests.filter((request) => request.startsWith('.')),
  };
}

const FAMILY_SEED = 'createRegisteredDaemonFixtures';

/** A cheap superset of seed files: the name in plain text, or any escape that could spell it. */
function mayNameSeed(source: string): boolean {
  return source.includes(FAMILY_SEED) || source.includes(String.raw`\u`);
}

function namesSeed(program: AstNode): boolean {
  let found = false;
  visitAst(program, (node) => {
    if (found) return;
    if (node.type === 'CallExpression' && memberName(asNode(node.callee) ?? {}) === FAMILY_SEED)
      found = true;
    if (node.type !== 'ImportDeclaration' && node.type !== 'ExportNamedDeclaration') return;
    if (
      nodeList(node.specifiers).some(
        (entry) => propertyName(asNode(entry)?.imported) === FAMILY_SEED,
      )
    )
      found = true;
  });
  return found;
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
