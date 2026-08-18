import { parseSync } from 'oxc-parser';
import { memberPath, propertyName, visitAst } from './cutover-policy-ast.ts';
import { countNamedCalls, lineOf, namedFunction } from './runtime-command-cutover-ast.ts';
import type { UnruledViolation } from './runtime-command-cutover-model.ts';

type AstNode = Record<string, unknown>;

const SNAPSHOT_ROUTE_FILE = 'src/daemon/snapshot-runtime.ts';
const SNAPSHOT_COMMAND_FILE = 'src/daemon/snapshot-command-runtime.ts';
const SNAPSHOT_BINDING_FILE = 'src/daemon/snapshot-runtime-binding.ts';

/** R32 admits only through the shared facts-first seam selected by the normalized runtime plan. */
export function snapshotPlatformPolicyBranchViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const routeSource = sources.get(SNAPSHOT_ROUTE_FILE);
  if (routeSource === undefined) {
    return [violation(SNAPSHOT_ROUTE_FILE, 1, 'snapshot runtime route is missing')];
  }
  const commandSource = sources.get(SNAPSHOT_COMMAND_FILE);
  if (commandSource === undefined) {
    return [violation(SNAPSHOT_COMMAND_FILE, 1, 'snapshot runtime command owner is missing')];
  }
  const bindingSource = sources.get(SNAPSHOT_BINDING_FILE);
  if (bindingSource === undefined) {
    return [violation(SNAPSHOT_BINDING_FILE, 1, 'snapshot runtime binding is missing')];
  }

  const routeProgram = parseSync(SNAPSHOT_ROUTE_FILE, routeSource).program as AstNode;
  const route = namedFunction(routeProgram, 'dispatchSnapshotViaRuntime');
  if (route === undefined) {
    return [violation(SNAPSHOT_ROUTE_FILE, 1, 'snapshot public runtime route is missing')];
  }
  const commandProgram = parseSync(SNAPSHOT_COMMAND_FILE, commandSource).program as AstNode;
  const commandOwner = namedFunction(commandProgram, 'dispatchSnapshotRuntimeCommand');
  if (commandOwner === undefined) {
    return [violation(SNAPSHOT_COMMAND_FILE, 1, 'snapshot runtime command owner is missing')];
  }
  const bindingProgram = parseSync(SNAPSHOT_BINDING_FILE, bindingSource).program as AstNode;
  const owner = namedFunction(bindingProgram, 'resolveBoundSnapshotCaptureRuntime');
  if (owner === undefined) {
    return [
      violation(SNAPSHOT_BINDING_FILE, 1, 'snapshot bound capture owning interface is missing'),
    ];
  }

  const violations: UnruledViolation[] = [];
  if (countNamedCalls(route, 'dispatchSnapshotRuntimeCommand') !== 1) {
    violations.push(
      violation(
        SNAPSHOT_ROUTE_FILE,
        lineOf(routeSource, route),
        'snapshot route must delegate exactly once to the shared runtime command owner',
      ),
    );
  }
  if (countNamedCalls(commandOwner, 'resolveBoundSnapshotCaptureRuntime') !== 1) {
    violations.push(
      violation(
        SNAPSHOT_COMMAND_FILE,
        lineOf(commandSource, commandOwner),
        'snapshot runtime command owner must resolve one bound capture',
      ),
    );
  }
  if (countNamedCalls(owner, 'resolveSnapshotRuntimePlan') !== 1) {
    violations.push(
      violation(
        SNAPSHOT_BINDING_FILE,
        lineOf(bindingSource, owner),
        'snapshot owning interface must select exactly one normalized plan',
      ),
    );
  }

  const admissions = namedCalls(owner, 'inspectRequiredRuntimeUse');
  if (admissions.length !== 1 || !hasExactAdmissionInput(admissions[0])) {
    violations.push(
      violation(
        SNAPSHOT_BINDING_FILE,
        lineOf(bindingSource, admissions[0] ?? owner),
        'snapshot owning interface must admit exactly once through inspectRequiredRuntimeUse(device, plan.use, inspectFacts)',
      ),
    );
  }

  if (bindingSource.includes('inspectSnapshotCaptureAdmission')) {
    violations.push({
      file: SNAPSHOT_BINDING_FILE,
      line: 1,
      message: 'snapshot admission must not be reimplemented beside the shared facts seam',
    });
  }
  return violations;
}

function namedCalls(node: AstNode, name: string): AstNode[] {
  const calls: AstNode[] = [];
  visitAst(node, (candidate) => {
    if (candidate.type !== 'CallExpression') return;
    const callee = candidate.callee as AstNode | undefined;
    if (callee?.type === 'Identifier' && callee.name === name) calls.push(candidate);
  });
  return calls;
}

function hasExactAdmissionInput(call: AstNode | undefined): boolean {
  const argument = Array.isArray(call?.arguments) ? call.arguments[0] : undefined;
  if (!isNode(argument, 'ObjectExpression') || !Array.isArray(argument.properties)) return false;
  const properties = new Map<string, unknown>();
  for (const candidate of argument.properties) {
    if (!isNode(candidate, 'Property')) continue;
    const name = propertyName(candidate.key);
    if (name !== undefined) properties.set(name, candidate.value);
  }
  return (
    hasPath(properties.get('device'), ['device']) &&
    hasPath(properties.get('use'), ['plan', 'use']) &&
    hasPath(properties.get('inspectFacts'), ['params', 'inspectFacts'])
  );
}

function hasPath(node: unknown, expected: readonly string[]): boolean {
  const path = memberPath(node);
  return path?.length === expected.length && path.every((part, index) => part === expected[index]);
}

function isNode(node: unknown, type: string): node is AstNode {
  return node !== null && typeof node === 'object' && (node as AstNode).type === type;
}

function violation(file: string, line: number, message: string): UnruledViolation {
  return { file, line, message };
}
