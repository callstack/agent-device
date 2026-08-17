import { parseSync } from 'oxc-parser';
import { propertyName, visitAst } from './cutover-policy-ast.ts';
import { countNamedCalls, lineOf, namedFunction } from './runtime-command-cutover-ast.ts';
import type { UnruledViolation } from './runtime-command-cutover-model.ts';

type AstNode = Record<string, unknown>;

const SNAPSHOT_RUNTIME_BINDING_FILE = 'src/daemon/snapshot-runtime-binding.ts';
const SNAPSHOT_ADMISSION_FUNCTION = 'inspectSnapshotCaptureAdmission';

/** Snapshot admission consumes the selected plan and operation facts, never device-owner identity. */
export function snapshotPlatformPolicyBranchViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const source = sources.get(SNAPSHOT_RUNTIME_BINDING_FILE);
  if (source === undefined) {
    return [
      {
        file: SNAPSHOT_RUNTIME_BINDING_FILE,
        line: 1,
        message: 'snapshot facts-first admission module is missing',
      },
    ];
  }
  const program = parseSync(SNAPSHOT_RUNTIME_BINDING_FILE, source).program as AstNode;
  const admission = namedFunction(program, SNAPSHOT_ADMISSION_FUNCTION);
  if (admission === undefined) {
    return [
      {
        file: SNAPSHOT_RUNTIME_BINDING_FILE,
        line: 1,
        message: `snapshot admission must be owned by ${SNAPSHOT_ADMISSION_FUNCTION}`,
      },
    ];
  }

  const aliases = snapshotAdmissionAliases(admission);
  const violations: UnruledViolation[] = [];
  const seenLines = new Set<number>();
  let readsRequiredOperations = false;
  let readsOperationFacts = false;
  let admitsAvailableFacts = false;
  visitAst(admission, (node) => {
    const binding = aliasBinding(node);
    if (binding !== undefined) {
      for (const path of boundPatternPaths(
        binding.pattern,
        initializerPath(binding.value, aliases),
      )) {
        if (readsDeviceOwnerIdentity(path)) addOwnerIdentityViolation(node);
      }
    }
    if (node.type !== 'MemberExpression' && node.type !== 'ChainExpression') return;
    const path = canonicalMemberPath(node, aliases);
    if (path === undefined) return;
    if (samePath(path, ['plan', 'use', 'required'])) readsRequiredOperations = true;
    if (samePath(path, ['facts', 'operations'])) readsOperationFacts = true;
    if (path[0] === 'facts' && path[1] === 'operations' && path[path.length - 1] === 'available') {
      admitsAvailableFacts = true;
    }

    if (readsDeviceOwnerIdentity(path)) addOwnerIdentityViolation(node);
  });

  function addOwnerIdentityViolation(node: AstNode): void {
    const line = lineOf(source, node);
    if (seenLines.has(line)) return;
    seenLines.add(line);
    violations.push({
      file: SNAPSHOT_RUNTIME_BINDING_FILE,
      line,
      message: 'snapshot admission reads device-owner identity instead of selected operation facts',
    });
  }

  if (countNamedCalls(admission, 'resolveSnapshotRuntimePlan') !== 1) {
    violations.push({
      file: SNAPSHOT_RUNTIME_BINDING_FILE,
      line: lineOf(source, admission),
      message: 'snapshot admission must select exactly one normalized runtime plan',
    });
  }
  if (!readsRequiredOperations || !readsOperationFacts || !admitsAvailableFacts) {
    violations.push({
      file: SNAPSHOT_RUNTIME_BINDING_FILE,
      line: lineOf(source, admission),
      message: 'snapshot admission must admit every selected operation through owner facts',
    });
  }
  return violations;
}

function snapshotAdmissionAliases(admission: AstNode): ReadonlyMap<string, readonly string[]> {
  const aliases = new Map<string, readonly string[]>();
  const params = admission.params;
  if (Array.isArray(params)) {
    const canonicalParams = [['params'], ['device'], ['session']] as const;
    for (const [index, parameter] of params.entries()) {
      if (index >= canonicalParams.length || !isIdentifier(parameter)) continue;
      aliases.set(parameter.name, canonicalParams[index]);
    }
  }

  const bindings: AstNode[] = [];
  visitAst(admission, (node) => {
    if (aliasBinding(node) !== undefined) bindings.push(node);
  });
  // Every acyclic alias chain stabilizes within this bound; malformed cycles cannot hang the gate.
  for (let pass = 0; pass <= bindings.length; pass += 1) {
    let changed = false;
    for (const node of bindings) {
      const binding = aliasBinding(node)!;
      const path = initializerPath(binding.value, aliases);
      for (const [name, aliasPath] of boundPatternAliases(binding.pattern, path)) {
        if (samePath(aliases.get(name) ?? [], aliasPath)) continue;
        aliases.set(name, aliasPath);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return aliases;
}

function aliasBinding(node: AstNode): Readonly<{ pattern: unknown; value: unknown }> | undefined {
  if (node.type === 'VariableDeclarator') return { pattern: node.id, value: node.init };
  if (node.type === 'AssignmentExpression' && node.operator === '=') {
    return { pattern: node.left, value: node.right };
  }
  return undefined;
}

function initializerPath(
  node: unknown,
  aliases: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined {
  const value = unwrapExpression(node);
  if (value === undefined) return undefined;
  if (value.type === 'CallExpression') {
    if (containsNamedCall(value, 'requireRuntimeFacts')) return ['facts'];
    if (containsNamedCall(value, 'resolveSnapshotRuntimePlan')) return ['plan'];
  }
  return canonicalMemberPath(value, aliases);
}

function canonicalMemberPath(
  node: unknown,
  aliases: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined {
  const value = unwrapExpression(node);
  if (value === undefined) return undefined;
  if (value.type === 'Identifier') {
    const name = typeof value.name === 'string' ? value.name : undefined;
    return name === undefined ? undefined : (aliases.get(name) ?? [name]);
  }
  if (value.type !== 'MemberExpression') return undefined;
  const object = canonicalMemberPath(value.object, aliases);
  const name = propertyName(value.property);
  return object === undefined || name === undefined
    ? undefined
    : canonicalizePath([...object, name]);
}

function canonicalizePath(path: readonly string[]): readonly string[] {
  if (path[0] === 'params' && path[1] === 'device') return ['device', ...path.slice(2)];
  if (path[0] === 'params' && path[1] === 'session') return ['session', ...path.slice(2)];
  if (path[0] === 'session' && path[1] === 'device') return ['device', ...path.slice(2)];
  return path;
}

function boundPatternAliases(
  pattern: unknown,
  path: readonly string[] | undefined,
): ReadonlyArray<readonly [string, readonly string[]]> {
  if (path === undefined || pattern === null || typeof pattern !== 'object') return [];
  const value = pattern as AstNode;
  if (value.type === 'Identifier' && typeof value.name === 'string') {
    return [[value.name, canonicalizePath(path)]];
  }
  if (value.type === 'AssignmentPattern') return boundPatternAliases(value.left, path);
  if (value.type !== 'ObjectPattern' || !Array.isArray(value.properties)) return [];
  const aliases: Array<readonly [string, readonly string[]]> = [];
  for (const property of value.properties) {
    if (property === null || typeof property !== 'object') continue;
    const entry = property as AstNode;
    if (entry.type !== 'Property') continue;
    const name = propertyName(entry.key);
    if (name === undefined) continue;
    aliases.push(...boundPatternAliases(entry.value, canonicalizePath([...path, name])));
  }
  return aliases;
}

function boundPatternPaths(
  pattern: unknown,
  path: readonly string[] | undefined,
): readonly (readonly string[])[] {
  return boundPatternAliases(pattern, path).map(([, aliasPath]) => aliasPath);
}

function readsDeviceOwnerIdentity(path: readonly string[]): boolean {
  return (
    (path[0] === 'device' && path.length > 1) ||
    (path[0] === 'facts' && path[1] === 'device' && path.length > 2)
  );
}

function containsNamedCall(node: unknown, name: string): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (candidate.type !== 'CallExpression') return;
    const callee = unwrapExpression(candidate.callee);
    if (callee?.type === 'Identifier' && callee.name === name) found = true;
  });
  return found;
}

function unwrapExpression(node: unknown): AstNode | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const value = node as AstNode;
  if (
    value.type === 'AwaitExpression' ||
    value.type === 'ChainExpression' ||
    value.type === 'TSAsExpression' ||
    value.type === 'TSNonNullExpression'
  ) {
    return unwrapExpression(value.expression);
  }
  return value;
}

function isIdentifier(node: unknown): node is AstNode & { name: string } {
  return (
    node !== null &&
    typeof node === 'object' &&
    (node as AstNode).type === 'Identifier' &&
    typeof (node as AstNode).name === 'string'
  );
}

function samePath(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((part, index) => part === expected[index])
  );
}
