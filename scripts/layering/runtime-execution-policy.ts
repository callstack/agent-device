import { parseSync } from 'oxc-parser';
import { memberName, propertyName, visitAst } from './layering-ast.ts';
import type { LayeringViolation } from './model.ts';

type AstNode = Record<string, unknown>;

export const RUNTIME_EXECUTION_INTEGRITY_RULE = 'R66 runtime-execution-integrity';

const COMMAND_DESCRIPTOR_MODULE = 'src/core/command-descriptor/registry.ts';
const RUNTIME_ADMISSION_MODULE = 'src/daemon/runtime-admission.ts';
const RUNTIME_PROOF_TYPES = new Set(['AdmittedRuntimePlan', 'BoundDeviceRuntime']);

/** Facts are the only admission authority, and daemon code must consume narrowed runtime proofs. */
export function runtimeExecutionIntegrityViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const [file, source] of sources) {
    const program = parseSync(file, source).program as AstNode;
    visitAst(program, (node) => {
      if (file === COMMAND_DESCRIPTOR_MODULE && isCapabilityDeclaration(node)) {
        violations.push(
          at(file, source, node, 'command descriptors may not restore capability-bucket admission'),
        );
      }
      if (isLegacyAdmissionCall(node)) {
        violations.push(
          at(file, source, node, 'runtime facts are the only device-command admission authority'),
        );
      }
      if (!file.startsWith('src/daemon/')) return;
      if (isManufacturedRuntimeProof(node)) {
        violations.push(
          at(file, source, node, 'daemon code may not manufacture a narrowed runtime proof'),
        );
      }
      if (isNonNullOperationRepair(node)) {
        violations.push(
          at(file, source, node, 'daemon code may not repair a missing runtime operation with !'),
        );
      }
      if (isLiteralBracketedOperationAccess(node)) {
        violations.push(
          at(
            file,
            source,
            node,
            'daemon code must consume narrowed runtime operations through named properties',
          ),
        );
      }
    });
  }
  violations.push(...sharedAdmissionViolations(sources));
  return violations;
}

function isCapabilityDeclaration(node: AstNode): boolean {
  return (
    node['type'] === 'Property' &&
    node['computed'] !== true &&
    propertyName(node['key']) === 'capability'
  );
}

function isLegacyAdmissionCall(node: AstNode): boolean {
  if (node['type'] !== 'CallExpression') return false;
  const callee = node['callee'] as AstNode | undefined;
  return callee?.['type'] === 'Identifier' && callee['name'] === 'requireCommandSupported';
}

function isManufacturedRuntimeProof(node: AstNode): boolean {
  if (node['type'] !== 'TSAsExpression' && node['type'] !== 'TSTypeAssertion') return false;
  let found = false;
  visitAst(node['typeAnnotation'], (candidate) => {
    if (candidate['type'] !== 'Identifier') return;
    const name = String(candidate['name']);
    if (RUNTIME_PROOF_TYPES.has(name) || name.endsWith('RuntimeOperations')) found = true;
  });
  return found;
}

function isNonNullOperationRepair(node: AstNode): boolean {
  if (node['type'] !== 'TSNonNullExpression') return false;
  const expression = node['expression'] as AstNode | undefined;
  if (expression?.['type'] !== 'MemberExpression') return false;
  const object = expression['object'] as AstNode | undefined;
  return isOperationsMember(object);
}

function isLiteralBracketedOperationAccess(node: AstNode): boolean {
  if (node['type'] !== 'MemberExpression' || node['computed'] !== true) return false;
  const object = node['object'] as AstNode | undefined;
  return isOperationsMember(object) && staticString(node['property']) !== undefined;
}

function isOperationsMember(node: AstNode | undefined): boolean {
  return node?.['type'] === 'MemberExpression' && staticMemberName(node) === 'operations';
}

function staticMemberName(node: AstNode): string | undefined {
  return node['computed'] === true ? staticString(node['property']) : memberName(node);
}

function staticString(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const value = node as AstNode;
  if (value['type'] === 'Literal' && typeof value['value'] === 'string') {
    return value['value'];
  }
  if (value['type'] === 'BinaryExpression' && value['operator'] === '+') {
    const left = staticString(value['left']);
    const right = staticString(value['right']);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (value['type'] === 'TemplateLiteral') {
    const expressions = value['expressions'];
    const quasis = value['quasis'];
    if (!Array.isArray(expressions) || expressions.length !== 0 || !Array.isArray(quasis)) {
      return undefined;
    }
    return quasis
      .map((quasi) => {
        const cooked = (quasi as AstNode)['value'];
        return cooked && typeof cooked === 'object'
          ? String((cooked as AstNode)['cooked'] ?? '')
          : '';
      })
      .join('');
  }
  return undefined;
}

function sharedAdmissionViolations(sources: ReadonlyMap<string, string>): LayeringViolation[] {
  const source = sources.get(RUNTIME_ADMISSION_MODULE);
  if (source === undefined) {
    return [violation(RUNTIME_ADMISSION_MODULE, 1, 'shared runtime admission module is missing')];
  }
  const program = parseSync(RUNTIME_ADMISSION_MODULE, source).program as AstNode;
  const admit = namedFunction(program, 'admitRuntimeOperations');
  if (admit === undefined) {
    return [
      violation(
        RUNTIME_ADMISSION_MODULE,
        1,
        'shared runtime admission must expose admitRuntimeOperations',
      ),
    ];
  }
  const violations: LayeringViolation[] = [];
  for (const [helper, role] of [
    ['requireFactsInspection', 'facts inspection'],
    ['requireDeviceBinding', 'binding'],
  ] as const) {
    const calls = countNamedCalls(admit, helper);
    if (calls !== 1) {
      violations.push(
        at(
          RUNTIME_ADMISSION_MODULE,
          source,
          admit,
          `shared runtime admission must make one ${role} call (found ${calls})`,
        ),
      );
    }
    const references = countNamedIdentifiers(admit, helper);
    if (references !== calls) {
      violations.push(
        at(
          RUNTIME_ADMISSION_MODULE,
          source,
          admit,
          `shared runtime admission must call ${helper} directly without aliasing it`,
        ),
      );
    }
  }
  return violations;
}

function namedFunction(program: AstNode, expected: string): AstNode | undefined {
  let found: AstNode | undefined;
  visitAst(program, (node) => {
    if (node['type'] !== 'FunctionDeclaration') return;
    const id = node['id'] as AstNode | null | undefined;
    if (id?.['type'] === 'Identifier' && id['name'] === expected) found = node;
  });
  return found;
}

function countNamedCalls(functionNode: AstNode, expected: string): number {
  let count = 0;
  visitAst(functionNode, (node) => {
    if (node['type'] !== 'CallExpression') return;
    const callee = node['callee'] as AstNode | undefined;
    if (callee?.['type'] === 'Identifier' && callee['name'] === expected) count += 1;
  });
  return count;
}

function countNamedIdentifiers(functionNode: AstNode, expected: string): number {
  let count = 0;
  visitAst(functionNode, (node) => {
    if (node['type'] === 'Identifier' && node['name'] === expected) count += 1;
  });
  return count;
}

function at(file: string, source: string, node: AstNode, message: string): LayeringViolation {
  const offset = typeof node['start'] === 'number' ? node['start'] : 0;
  return violation(file, source.slice(0, offset).split('\n').length, message);
}

function violation(file: string, line: number, message: string): LayeringViolation {
  return { rule: RUNTIME_EXECUTION_INTEGRITY_RULE, file, line, message };
}
