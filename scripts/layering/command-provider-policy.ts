import { parseSync } from 'oxc-parser';
import { memberName, visitAst } from './layering-ast.ts';
import type { LayeringViolation } from './model.ts';

export const COMMAND_PROVIDER_POLICY_RULE = 'R71 command-provider-policy';

const COMMAND_ROOTS = ['src/commands/', 'src/cli/commands/'];
const PROVIDER_FIELDS = new Set(['leaseProvider', 'provider']);
const EQUALITY_OPERATORS = new Set(['==', '===', '!=', '!==']);

function isCommandFile(file: string): boolean {
  return COMMAND_ROOTS.some((root) => file.startsWith(root));
}

function isStringLiteral(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const value = node as Record<string, unknown>;
  return value.type === 'Literal' && typeof value.value === 'string';
}

function isProviderField(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const value = node as Record<string, unknown>;
  if (value.type === 'ChainExpression') return isProviderField(value.expression);
  return value.type === 'MemberExpression' && PROVIDER_FIELDS.has(memberName(value) ?? '');
}

function isProviderIdentityComparison(node: Record<string, unknown>): boolean {
  if (node.type !== 'BinaryExpression' || !EQUALITY_OPERATORS.has(String(node.operator))) {
    return false;
  }
  return (
    (isProviderField(node.left) && isStringLiteral(node.right)) ||
    (isStringLiteral(node.left) && isProviderField(node.right))
  );
}

function isProviderIdentitySwitch(node: Record<string, unknown>): boolean {
  if (node.type !== 'SwitchStatement' || !isProviderField(node.discriminant)) return false;
  const cases = Array.isArray(node.cases) ? node.cases : [];
  return cases.some((entry) => {
    if (entry === null || typeof entry !== 'object') return false;
    return isStringLiteral((entry as Record<string, unknown>).test);
  });
}

export function commandProviderPolicyViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const [file, source] of sources) {
    if (!isCommandFile(file)) continue;
    const program = parseSync(file, source).program as Record<string, unknown>;
    visitAst(program, (node) => {
      if (!isProviderIdentityComparison(node) && !isProviderIdentitySwitch(node)) return;
      const offset = typeof node.start === 'number' ? node.start : 0;
      violations.push({
        rule: COMMAND_PROVIDER_POLICY_RULE,
        file,
        line: source.slice(0, offset).split('\n').length,
        message:
          'command branches on provider identity; declare a semantic capability in src/cli/connection/provider-policy.ts',
      });
    });
  }
  return violations;
}
