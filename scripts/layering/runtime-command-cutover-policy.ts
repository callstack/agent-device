import { parseSync } from 'oxc-parser';
import type { LayeringViolation } from './model.ts';
import {
  cutoverRowDefects,
  cutoverTableDefects,
  type CutoverCheck,
  type DeviceRuntimeCutover,
  type MigratedCommandCutover,
  type UnruledViolation,
} from './runtime-command-cutover-model.ts';
import { MIGRATED_COMMAND_CUTOVERS } from './runtime-command-cutover-table.ts';
import { memberName, propertyName, visitAst, type ProductionSource } from './cutover-policy-ast.ts';

type AstNode = Record<string, unknown>;

// Types no daemon route may manufacture with an assertion: the bound runtime itself, and the
// admission proof a facts-first binder requires (`AdmittedRuntimePlan`, minted only by
// `admitRuntimePlan`). Together with the row's own runtime type names they are the
// manufactured-proof column — a cast to any of them is a route repairing missing proof.
const SHARED_RUNTIME_TYPE_NAMES = ['BoundDeviceRuntime', 'AdmittedRuntimePlan'] as const;

/**
 * The one parametrized runtime-command-cutover gate (ADR 0019 §8). Every migrated
 * command is a row in {@link MIGRATED_COMMAND_CUTOVERS}; the mechanism below is proven
 * once by a planted row rather than once per command.
 */
export function checkRuntimeCommandCutover(
  sources: ReadonlyMap<string, string>,
  table: readonly MigratedCommandCutover[] = MIGRATED_COMMAND_CUTOVERS,
): LayeringViolation[] {
  const files: ProductionSource[] = [...sources].map(([path, source]) => ({ path, source }));
  const programs = new Map<string, AstNode>(
    files.map(({ path, source }) => [path, parseSync(path, source).program as AstNode]),
  );
  const tableDefects = cutoverTableDefects(table);
  if (tableDefects.length > 0) {
    return tableDefects.map((defect) => ({
      rule: table[0]?.rule ?? 'cutover table',
      file: '(cutover table)',
      line: 1,
      message: `cutover table ${defect}`,
    }));
  }
  return table.flatMap((row) =>
    rowViolations(row, files, programs).map((violation) => ({ rule: row.rule, ...violation })),
  );
}

export function runtimeCommandCutoverSummary(
  table: readonly MigratedCommandCutover[] = MIGRATED_COMMAND_CUTOVERS,
): string {
  const commands = table.map(({ command }) => command).join(', ');
  return `each migrated command (${commands}) keeps exactly one platform-execution path`;
}

function rowViolations(
  row: MigratedCommandCutover,
  files: readonly ProductionSource[],
  programs: ReadonlyMap<string, AstNode>,
): UnruledViolation[] {
  // An under-declared row would enforce nothing and read green, so the row itself is
  // checked before the repo is.
  const defects = cutoverRowDefects(row);
  if (defects.length > 0) {
    return defects.map((defect) => ({
      file: `(${row.command} cutover row)`,
      line: 1,
      message: `cutover row ${defect}`,
    }));
  }

  const violations: UnruledViolation[] = [];
  for (const file of files) {
    const program = programs.get(file.path);
    if (!program) continue;
    violations.push(...retiredModuleViolations(row, file));
    violations.push(...legacyRouteViolations(row, file, program));
    violations.push(...admissionViolations(row, file, program));
    violations.push(...narrowingViolations(row, file, program));
  }
  violations.push(...exactCallViolations(row, files, programs));
  violations.push(...staticCommandSetViolations(row, files, programs));
  const sources = new Map(files.map(({ path, source }) => [path, source]));
  for (const check of rowChecks(row)) violations.push(...check(sources));
  return violations;
}

function rowChecks(row: MigratedCommandCutover): CutoverCheck[] {
  return [
    ...(row.execution === 'inventory' ? [row.singularExecution.gatewayProof] : []),
    ...(row.execution === 'device-runtime' && row.singularExecution.routeProof !== undefined
      ? [row.singularExecution.routeProof]
      : []),
    ...(row.lifecycleProof === undefined ? [] : [row.lifecycleProof]),
    ...(row.extensions ?? []),
  ];
}

// ---------------------------------------------------------------------------
// The legacy adapter is gone: no retired module, import, or executable name.
// ---------------------------------------------------------------------------

function retiredModuleViolations(
  row: MigratedCommandCutover,
  file: ProductionSource,
): UnruledViolation[] {
  const retired =
    (row.legacyRetirement.modulePaths ?? []).includes(file.path) ||
    (row.legacyRetirement.modulePathPatterns ?? []).some((pattern) => pattern.test(file.path));
  return retired
    ? [{ file: file.path, line: 1, message: `retired ${row.subject} module remains` }]
    : [];
}

function legacyRouteViolations(
  row: MigratedCommandCutover,
  file: ProductionSource,
  program: AstNode,
): UnruledViolation[] {
  const violations: UnruledViolation[] = [];
  const seen = new Set<string>();
  const isDaemon = file.path.startsWith('src/daemon/');
  const scoped = new Set([
    ...(row.legacyRetirement.routeNames ?? []),
    ...(isDaemon ? (row.legacyRetirement.daemonOnlyRouteNames ?? []) : []),
  ]);
  visitAst(program, (node) => {
    const specifier = retiredImportSpecifier(row, node);
    if (specifier !== undefined) {
      push(
        violations,
        seen,
        file,
        node,
        `production source imports retired ${row.subject} module '${specifier}'`,
      );
    }
    const route = executableName(node, scoped);
    if (route !== undefined) {
      push(violations, seen, file, node, `legacy ${row.subject} route ${route}`);
    }
    if (
      isDaemon &&
      isProviderMethodCall(node, row.legacyRetirement.daemonOnlyProviderMethods ?? [])
    ) {
      push(
        violations,
        seen,
        file,
        node,
        `daemon invokes legacy provider method ${memberName(node['callee'] as AstNode) ?? ''}`,
      );
    }
    if (isPlatformPluginFacet(node, row.legacyRetirement.pluginFacetKeys ?? [])) {
      push(violations, seen, file, node, `legacy PlatformPlugin ${facetKeyList(row)} facet`);
    }
  });
  return violations;
}

function facetKeyList(row: MigratedCommandCutover): string {
  return (row.legacyRetirement.pluginFacetKeys ?? []).join('/');
}

/** Identifier, property key (computed or not), and computed member access all count. */
function executableName(node: AstNode, names: ReadonlySet<string>): string | undefined {
  if (names.size === 0) return undefined;
  if (node['type'] === 'Identifier' && names.has(String(node['name']))) return String(node['name']);
  if (node['type'] === 'Property' || node['type'] === 'TSPropertySignature') {
    const key = propertyName(node['key']);
    return key !== undefined && names.has(key) ? key : undefined;
  }
  if (node['type'] === 'MemberExpression' && node['computed'] === true) {
    const key = propertyName(node['property']);
    return key !== undefined && names.has(key) ? key : undefined;
  }
  return undefined;
}

function retiredImportSpecifier(row: MigratedCommandCutover, node: AstNode): string | undefined {
  const patterns = row.legacyRetirement.importPatterns ?? [];
  if (patterns.length === 0) return undefined;
  if (
    node['type'] !== 'ImportDeclaration' &&
    node['type'] !== 'ImportExpression' &&
    node['type'] !== 'ExportNamedDeclaration' &&
    node['type'] !== 'ExportAllDeclaration'
  ) {
    return undefined;
  }
  // `export const x = 1` is an ExportNamedDeclaration with a null source.
  const source = node['source'] as AstNode | null | undefined;
  const specifier = source === null || source === undefined ? undefined : source['value'];
  if (typeof specifier !== 'string') return undefined;
  return patterns.some((pattern) => pattern.test(specifier)) ? specifier : undefined;
}

function isProviderMethodCall(node: AstNode, methods: readonly string[]): boolean {
  if (methods.length === 0 || node['type'] !== 'CallExpression') return false;
  const callee = node['callee'] as AstNode | undefined;
  if (callee === undefined || callee['type'] !== 'MemberExpression') return false;
  const name = memberName(callee);
  return name !== undefined && methods.includes(name);
}

function isPlatformPluginFacet(node: AstNode, facetKeys: readonly string[]): boolean {
  if (facetKeys.length === 0) return false;
  if (node['type'] === 'TSTypeAliasDeclaration' || node['type'] === 'TSInterfaceDeclaration') {
    const id = node['id'] as AstNode | undefined;
    return (
      id?.['type'] === 'Identifier' &&
      id['name'] === 'PlatformPlugin' &&
      declaresFacetKey(node, facetKeys)
    );
  }
  if (node['type'] === 'TSSatisfiesExpression' || node['type'] === 'TSAsExpression') {
    return (
      isNamedType(node['typeAnnotation'], 'PlatformPlugin') &&
      declaresFacetKey(node['expression'], facetKeys)
    );
  }
  if (node['type'] !== 'VariableDeclarator') return false;
  const id = node['id'] as AstNode | undefined;
  return (
    isNamedType(id?.['typeAnnotation'], 'PlatformPlugin') &&
    declaresFacetKey(node['init'], facetKeys)
  );
}

function declaresFacetKey(node: unknown, facetKeys: readonly string[]): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (
      (candidate['type'] === 'Property' || candidate['type'] === 'TSPropertySignature') &&
      candidate['computed'] !== true &&
      facetKeys.includes(propertyName(candidate['key']) ?? '')
    ) {
      found = true;
    }
  });
  return found;
}

function isNamedType(node: unknown, expected: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  const record = node as AstNode;
  if (record['type'] === 'TSTypeAnnotation') return isNamedType(record['typeAnnotation'], expected);
  if (record['type'] !== 'TSTypeReference') return false;
  const name = record['typeName'] as AstNode | undefined;
  return name?.['type'] === 'Identifier' && name['name'] === expected;
}

// ---------------------------------------------------------------------------
// Admission comes from facts: no capability bucket, no static command set.
// ---------------------------------------------------------------------------

function admissionViolations(
  row: MigratedCommandCutover,
  file: ProductionSource,
  program: AstNode,
): UnruledViolation[] {
  const violations: UnruledViolation[] = [];
  const member = row.admissionMember;
  const memberInScope = member !== undefined && (member.files?.includes(file.path) ?? true);
  visitAst(program, (node) => {
    if (isLegacyAdmissionCall(node, row.command)) {
      violations.push(
        at(file, node, `legacy ${row.command} capability admission requireCommandSupported`),
      );
    }
    if (isDescriptorWithCapability(node, row.command)) {
      violations.push(
        at(file, node, `${row.command} descriptor retains legacy capability admission`),
      );
    }
    if (isStaticCommandSet(node, row.command)) {
      violations.push(
        at(file, node, `static platform command set retains ${row.command} admission`),
      );
    }
    if (memberInScope && isAdmissionMember(node, row.command, member.forms)) {
      violations.push(at(file, node, member.message));
    }
  });
  return violations;
}

function isLegacyAdmissionCall(node: AstNode, command: string): boolean {
  if (node['type'] !== 'CallExpression') return false;
  const callee = node['callee'] as AstNode | undefined;
  const args = node['arguments'] as readonly AstNode[] | undefined;
  return (
    callee?.['type'] === 'Identifier' &&
    callee['name'] === 'requireCommandSupported' &&
    isCommandExpression(args?.[0], command)
  );
}

/** `'logs'` and `PUBLIC_COMMANDS.logs` name the same command. */
function isCommandExpression(node: AstNode | undefined, command: string): boolean {
  if (node?.['type'] === 'Literal') return node['value'] === command;
  if (node?.['type'] !== 'MemberExpression') return false;
  const object = node['object'] as AstNode | undefined;
  return (
    object?.['type'] === 'Identifier' &&
    object['name'] === 'PUBLIC_COMMANDS' &&
    memberName(node) === camelCommandKey(command)
  );
}

/** `PUBLIC_COMMANDS` keys are camelCase (`react-native` -> `reactNative`). */
function camelCommandKey(command: string): string {
  return command.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function isDescriptorWithCapability(node: AstNode, command: string): boolean {
  if (node['type'] !== 'ObjectExpression' || !Array.isArray(node['properties'])) return false;
  let named = false;
  let capability = false;
  for (const property of node['properties'] as AstNode[]) {
    if (property['type'] !== 'Property' || property['computed'] === true) continue;
    const key = propertyName(property['key']);
    const value = property['value'] as AstNode | undefined;
    if (key === 'name' && value?.['type'] === 'Literal' && value['value'] === command) named = true;
    if (key === 'capability') capability = true;
  }
  return named && capability;
}

function isStaticCommandSet(node: AstNode, command: string): boolean {
  if (node['type'] !== 'VariableDeclarator') return false;
  const id = node['id'] as AstNode | undefined;
  return (
    id?.['type'] === 'Identifier' &&
    /(?:WEB|HARMONY).*COMMANDS/.test(String(id['name'])) &&
    containsStringLiteral(node['init'], command)
  );
}

function isAdmissionMember(
  node: AstNode,
  command: string,
  forms: readonly ('computed-property' | 'public-commands-member')[],
): boolean {
  if (
    forms.includes('computed-property') &&
    node['type'] === 'Property' &&
    node['computed'] === true &&
    isCommandExpression(node['key'] as AstNode | undefined, command)
  ) {
    return true;
  }
  return (
    forms.includes('public-commands-member') &&
    node['type'] === 'MemberExpression' &&
    isCommandExpression(node, command)
  );
}

/**
 * A data-only admission retirement, proven from both sides.
 *
 * A command whose legacy admission was a capability bucket plus membership in a static platform
 * command set retires no module, route, or dispatch projection — there is no identifier to name
 * as gone. Naming an invented one satisfies the non-empty shape check while proving nothing, so
 * the row names the sets themselves: each must still be DECLARED in production source, and must
 * no longer carry this command.
 *
 * The existence half is what an identifier-shaped claim cannot express. The membership half
 * overlaps the automatic static-set column for `WEB`/`HARMONY`-named sets, deliberately: stating
 * it here keeps the declared claim self-sufficient rather than dependent on that regex.
 */
function staticCommandSetViolations(
  row: MigratedCommandCutover,
  files: readonly ProductionSource[],
  programs: ReadonlyMap<string, AstNode>,
): UnruledViolation[] {
  const declared = row.legacyRetirement.staticCommandSets ?? [];
  if (declared.length === 0) return [];
  const violations: UnruledViolation[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const program = programs.get(file.path);
    if (!program) continue;
    visitAst(program, (node) => {
      const name = staticCommandSetName(node, declared);
      if (name === undefined) return;
      seen.add(name);
      if (containsStringLiteral(node['init'], row.command)) {
        violations.push(at(file, node, `static command set ${name} still admits ${row.command}`));
      }
    });
  }
  for (const name of declared) {
    if (seen.has(name)) continue;
    violations.push({
      file: `(${row.command} cutover row)`,
      line: 1,
      message: `claims retired static command set '${name}', which no production source declares`,
    });
  }
  return violations;
}

function staticCommandSetName(node: AstNode, declared: readonly string[]): string | undefined {
  if (node['type'] !== 'VariableDeclarator') return undefined;
  const id = node['id'] as AstNode | undefined;
  if (id?.['type'] !== 'Identifier') return undefined;
  const name = String(id['name']);
  return declared.includes(name) ? name : undefined;
}

function containsStringLiteral(node: unknown, expected: string): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (candidate['type'] === 'Literal' && candidate['value'] === expected) found = true;
  });
  return found;
}

// ---------------------------------------------------------------------------
// The runtime route stays narrowed: no manufactured proof, no widened access.
// ---------------------------------------------------------------------------

function narrowingViolations(
  row: MigratedCommandCutover,
  file: ProductionSource,
  program: AstNode,
): UnruledViolation[] {
  // An inventory row binds no device runtime, so it has nothing to re-widen.
  if (!file.path.startsWith('src/daemon/') || row.execution !== 'device-runtime') return [];
  const violations: UnruledViolation[] = [];
  const runtimeTypes = new Set([...SHARED_RUNTIME_TYPE_NAMES, ...row.runtimeTypeNames]);
  visitAst(program, (node) => {
    if (
      (node['type'] === 'TSAsExpression' || node['type'] === 'TSTypeAssertion') &&
      containsTypeName(node['typeAnnotation'], runtimeTypes)
    ) {
      violations.push(at(file, node, `widened ${row.subject} runtime type assertion`));
    }
    if (node['type'] === 'TSNonNullExpression' && isNonNullRepair(row, node['expression'])) {
      violations.push(at(file, node, `non-null repair of a narrowed ${row.subject} operation`));
    }
    if (isBracketedOperationAccess(row, node)) {
      violations.push(at(file, node, `bracketed ${row.subject} operation access`));
    }
  });
  return violations;
}

function isNonNullRepair(row: DeviceRuntimeCutover, node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const member = node as AstNode;
  if (member['type'] !== 'MemberExpression') return false;
  if (row.nonNullRepairScope === 'any-operation') {
    const object = member['object'] as AstNode | undefined;
    return object?.['type'] === 'MemberExpression' && memberName(object) === 'operations';
  }
  return isRowOperation(row, memberName(member));
}

function isBracketedOperationAccess(row: DeviceRuntimeCutover, node: AstNode): boolean {
  if (node['type'] !== 'MemberExpression' || node['computed'] !== true) return false;
  const object = node['object'] as AstNode | undefined;
  return (
    isRowOperation(row, memberName(node)) &&
    object?.['type'] === 'MemberExpression' &&
    memberName(object) === 'operations'
  );
}

function isRowOperation(row: DeviceRuntimeCutover, name: string | undefined): boolean {
  if (name === undefined) return false;
  return (
    (row.operations.names ?? []).includes(name) || (row.operations.pattern?.test(name) ?? false)
  );
}

function containsTypeName(node: unknown, names: ReadonlySet<string>): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (candidate['type'] === 'Identifier' && names.has(String(candidate['name']))) found = true;
  });
  return found;
}

// ---------------------------------------------------------------------------
// The route is singular: one daemon orchestration call, one operation call.
// ---------------------------------------------------------------------------

function exactCallViolations(
  row: MigratedCommandCutover,
  files: readonly ProductionSource[],
  programs: ReadonlyMap<string, AstNode>,
): UnruledViolation[] {
  if (row.execution !== 'device-runtime') return [];
  // A row that proves its single route with a dedicated check names no route here.
  const routes: readonly string[] = row.singularExecution.routes ?? [];
  const operations: readonly string[] = row.singularExecution.operations ?? [];
  const routeCounts = new Map<string, number>(routes.map((name) => [name, 0]));
  const ownerNodes = new Map<string, AstNode[]>();
  for (const file of files.filter(({ path }) => path.startsWith('src/daemon/'))) {
    const program = programs.get(file.path);
    if (!program) continue;
    visitAst(program, (node) => {
      const owner = lexicalFunctionOwnerName(node);
      if (owner !== undefined) {
        const nodes = ownerNodes.get(owner) ?? [];
        nodes.push(node);
        ownerNodes.set(owner, nodes);
      }
      if (node['type'] !== 'CallExpression') return;
      const callee = node['callee'] as AstNode | undefined;
      if (callee?.['type'] === 'Identifier' && routeCounts.has(String(callee['name']))) {
        bump(routeCounts, String(callee['name']));
      }
    });
  }
  const operationCounts = new Map(
    operations.map((operation) => [
      operation,
      countOwnedOperationCalls(
        operation,
        row.singularExecution.operationOwners?.[operation] ?? [],
        ownerNodes,
      ),
    ]),
  );
  const pseudoFile = `(${row.command} runtime)`;
  return [
    ...routes.map((name) => ({ found: routeCounts.get(name) ?? 0, what: `${name} route` })),
    ...operations.map((name) => ({
      found: operationCounts.get(name) ?? 0,
      what: `narrowed ${name} call`,
    })),
  ]
    .filter(({ found }) => found !== 1)
    .map(({ what, found }) => ({
      file: pseudoFile,
      line: 1,
      message: `expected one ${what}, found ${found}`,
    }));
}

function lexicalFunctionOwnerName(node: AstNode): string | undefined {
  if (node['type'] === 'FunctionDeclaration') {
    const id = node['id'] as AstNode | null | undefined;
    return id?.['type'] === 'Identifier' ? String(id['name']) : undefined;
  }
  if (node['type'] !== 'VariableDeclarator') return undefined;
  const id = node['id'] as AstNode | undefined;
  const init = node['init'] as AstNode | null | undefined;
  if (id?.['type'] !== 'Identifier') return undefined;
  if (init?.['type'] !== 'ArrowFunctionExpression' && init?.['type'] !== 'FunctionExpression') {
    return undefined;
  }
  return String(id['name']);
}

function countOwnedOperationCalls(
  operation: string,
  owners: readonly string[],
  ownerNodes: ReadonlyMap<string, readonly AstNode[]>,
): number {
  let count = 0;
  for (const owner of owners) {
    for (const node of ownerNodes.get(owner) ?? []) {
      visitAst(node, (candidate) => {
        if (candidate['type'] !== 'CallExpression') return;
        const callee = candidate['callee'] as AstNode | undefined;
        if (
          callee?.['type'] === 'MemberExpression' &&
          isRuntimeOperationCall(callee) &&
          memberName(callee) === operation
        ) {
          count += 1;
        }
      });
    }
  }
  return count;
}

function isRuntimeOperationCall(callee: AstNode): boolean {
  const object = callee['object'] as AstNode | undefined;
  return object?.['type'] === 'MemberExpression' && memberName(object) === 'operations';
}

function bump(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

// ---------------------------------------------------------------------------

function push(
  violations: UnruledViolation[],
  seen: Set<string>,
  file: ProductionSource,
  node: AstNode,
  message: string,
): void {
  const identity = `${String(node['start'] ?? '')}:${message}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  violations.push(at(file, node, message));
}

function at(file: ProductionSource, node: AstNode, message: string): UnruledViolation {
  const offset = typeof node['start'] === 'number' ? node['start'] : 0;
  return { file: file.path, line: file.source.slice(0, offset).split('\n').length, message };
}
