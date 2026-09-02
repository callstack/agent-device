// Catches: src/core/command-descriptor/registry.ts's record command descriptor missing the
//   runtime-descriptor join assertion — a wiring gap where record's registry entry silently
//   stops being checked against the request-bound runtime it must join, invisible to a type
//   check because the assertion's absence is not a type error, just a missing call.
// Evidence: 03c3984066 (#1969) granularized contracts entry surfaces the registry imports from,
//   which this join assertion depends on staying wired correctly.
// Cost: 137 LOC (106 rule + 31 test); shares rule id R16 with record-runtime-mechanics-policy.ts
//   (165 LOC).
// Kill criterion: none enforced today; retire only by maintainer decision that the record
//   descriptor's runtime-descriptor join assertion no longer matters. Nothing in the registry's
//   types requires the join call, so its absence is not a compile error.

import { parseSync } from 'oxc-parser';
import { memberName, type ProductionSource, visitAst } from './layering-ast.ts';

export function recordRuntimeRegistryJoinViolations(
  sources: readonly ProductionSource[],
): string[] {
  const file = sources.find(({ path }) => path === 'src/core/command-descriptor/registry.ts');
  if (!file) return [missingRecordRuntimeRegistryJoin()];
  const parsed = parseSync(file.path, file.source);
  const assertionName = importedRecordRuntimeAssertionName(parsed.program);
  if (!assertionName) return [missingRecordRuntimeRegistryJoin()];
  let joined = false;
  visitAst(parsed.program, (node) => {
    if (
      node.type === 'IfStatement' &&
      isRecordDescriptorGuard(node.test) &&
      containsRecordRuntimeAssertion(node.consequent, assertionName)
    ) {
      joined = true;
    }
  });
  return joined ? [] : [missingRecordRuntimeRegistryJoin()];
}

function missingRecordRuntimeRegistryJoin(): string {
  return 'src/core/command-descriptor/registry.ts: missing record runtime descriptor join assertion';
}

function importedRecordRuntimeAssertionName(node: unknown): string | undefined {
  let localName: string | undefined;
  visitAst(node, (candidate) => {
    if (candidate.type !== 'ImportDeclaration') return;
    const source = candidate.source as Record<string, unknown> | undefined;
    // Any contracts entry, not one named subpath: the assertion's provenance is what
    // this rule pins, and #1959 splits that vocabulary across per-module entries.
    if (
      source?.type !== 'Literal' ||
      !String(source.value).startsWith('@agent-device/contracts/')
    ) {
      return;
    }
    const specifiers = candidate.specifiers as readonly Record<string, unknown>[] | undefined;
    const assertion = specifiers?.find((specifier) => {
      const imported = specifier.imported as Record<string, unknown> | undefined;
      return imported?.type === 'Identifier' && imported.name === 'assertRecordRuntimeExecution';
    });
    const local = assertion?.local as Record<string, unknown> | undefined;
    if (local?.type === 'Identifier') localName = String(local.name);
  });
  return localName;
}

function isRecordDescriptorGuard(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const expression = node as Record<string, unknown>;
  if (
    expression.type !== 'BinaryExpression' ||
    !['===', '=='].includes(String(expression.operator))
  ) {
    return false;
  }
  return (
    (isDescriptorNameAccess(expression.left) && isRecordLiteral(expression.right)) ||
    (isDescriptorNameAccess(expression.right) && isRecordLiteral(expression.left))
  );
}

function isDescriptorNameAccess(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const member = node as Record<string, unknown>;
  const object = member.object as Record<string, unknown> | undefined;
  return (
    member.type === 'MemberExpression' &&
    memberName(member) === 'name' &&
    object?.type === 'Identifier' &&
    object.name === 'descriptor'
  );
}

function isRecordLiteral(node: unknown): boolean {
  return (
    node !== null &&
    typeof node === 'object' &&
    (node as Record<string, unknown>).type === 'Literal' &&
    (node as Record<string, unknown>).value === 'record'
  );
}

function containsRecordRuntimeAssertion(node: unknown, assertionName: string): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (candidate.type !== 'CallExpression') return;
    const callee = candidate.callee as Record<string, unknown> | undefined;
    const args = candidate.arguments as readonly Record<string, unknown>[] | undefined;
    if (
      callee?.type === 'Identifier' &&
      callee.name === assertionName &&
      args?.length === 1 &&
      args[0]?.type === 'Identifier' &&
      args[0].name === 'platformExecution'
    ) {
      found = true;
    }
  });
  return found;
}
