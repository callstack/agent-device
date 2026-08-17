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

  const violations: UnruledViolation[] = [];
  const seenLines = new Set<number>();
  let readsRequiredOperations = false;
  let readsOperationFacts = false;
  let admitsAvailableFacts = false;
  visitAst(admission, (node) => {
    const path = memberPath(node);
    if (path === undefined) return;
    if (samePath(path, ['plan', 'use', 'required'])) readsRequiredOperations = true;
    if (samePath(path, ['facts', 'operations'])) readsOperationFacts = true;
    if (samePath(path, ['fact', 'available'])) admitsAvailableFacts = true;

    const readsDeviceLeaf =
      (path[0] === 'device' && path.length > 1) ||
      (path[0] === 'params' && path[1] === 'device' && path.length > 2);
    const readsOwnerIdentity = path[0] === 'facts' && path[1] === 'device' && path.length > 2;
    if (!readsDeviceLeaf && !readsOwnerIdentity) return;
    const line = lineOf(source, node);
    if (seenLines.has(line)) return;
    seenLines.add(line);
    violations.push({
      file: SNAPSHOT_RUNTIME_BINDING_FILE,
      line,
      message: 'snapshot admission reads device-owner identity instead of selected operation facts',
    });
  });

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

function memberPath(node: unknown): string[] | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as AstNode;
  if (record['type'] === 'Identifier') {
    const name = record['name'];
    return typeof name === 'string' ? [name] : undefined;
  }
  if (record['type'] === 'ChainExpression') return memberPath(record['expression']);
  if (record['type'] !== 'MemberExpression' || record['computed'] === true) return undefined;
  const object = memberPath(record['object']);
  const name = propertyName(record['property']);
  return object && name ? [...object, name] : undefined;
}

function samePath(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((part, index) => part === expected[index])
  );
}
