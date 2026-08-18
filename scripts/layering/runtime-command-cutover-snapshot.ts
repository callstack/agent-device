import { parseSync } from 'oxc-parser';
import { memberPath, propertyName, visitAst } from './cutover-policy-ast.ts';
import { countNamedCalls, lineOf, namedFunction } from './runtime-command-cutover-ast.ts';
import type { UnruledViolation } from './runtime-command-cutover-model.ts';

type AstNode = Record<string, unknown>;

const SNAPSHOT_ROUTE_FILE = 'src/daemon/snapshot-runtime.ts';
const SNAPSHOT_BINDING_FILE = 'src/daemon/snapshot-runtime-binding.ts';

/** R32 admits only through the shared facts-first seam selected by the normalized runtime plan. */
export function snapshotPlatformPolicyBranchViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const source = sources.get(SNAPSHOT_ROUTE_FILE);
  if (source === undefined) return [violation(1, 'snapshot runtime route is missing')];

  const program = parseSync(SNAPSHOT_ROUTE_FILE, source).program as AstNode;
  const route = namedFunction(program, 'dispatchSnapshotViaRuntime');
  if (route === undefined) return [violation(1, 'snapshot public runtime route is missing')];

  const violations: UnruledViolation[] = [];
  if (countNamedCalls(route, 'resolveSnapshotRuntimePlan') !== 1) {
    violations.push(
      violation(lineOf(source, route), 'snapshot route must select exactly one normalized plan'),
    );
  }

  const admissions = namedCalls(route, 'inspectRequiredRuntimeUse');
  if (admissions.length !== 1 || !hasExactAdmissionInput(admissions[0])) {
    violations.push(
      violation(
        lineOf(source, admissions[0] ?? route),
        'snapshot route must admit exactly once through inspectRequiredRuntimeUse(device, plan.use, inspectFacts)',
      ),
    );
  }

  const bindingSource = sources.get(SNAPSHOT_BINDING_FILE) ?? '';
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

function violation(line: number, message: string): UnruledViolation {
  return { file: SNAPSHOT_ROUTE_FILE, line, message };
}
