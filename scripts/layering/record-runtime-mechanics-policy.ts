import { parseSync } from 'oxc-parser';
import { memberName, type ProductionSource, visitAst } from './layering-ast.ts';

const DAEMON_RECORD_MECHANIC_CALLS = new Set([
  'runCmd',
  'runCmdBackground',
  'runCmdDetached',
  'runCmdStreaming',
  'runCmdSync',
  'setInterval',
  'setTimeout',
  'spawn',
  'spawnSync',
]);

/** The daemon record owner coordinates runtime operations; native mechanics stay behind owners. */
export function recordRuntimeDaemonMechanicsViolations(
  sources: readonly ProductionSource[],
): string[] {
  const violations: string[] = [];
  for (const file of sources.filter(({ path }) => isDaemonRecordOwner(path))) {
    const parsed = parseSync(file.path, file.source);
    const platformAliases = collectPlatformAliases(parsed.program);
    visitAst(parsed.program, (node) => {
      if (node.type === 'ImportDeclaration') {
        const source = node.source as Record<string, unknown> | undefined;
        const imported = source?.type === 'Literal' ? String(source.value) : '';
        if (isDaemonRecordMechanicImport(imported)) {
          violations.push(`${file.path}: daemon record owner imports native mechanic ${imported}`);
        }
      }
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as Record<string, unknown> | undefined;
      if (callee?.type === 'Identifier' && DAEMON_RECORD_MECHANIC_CALLS.has(String(callee.name))) {
        violations.push(
          `${file.path}: daemon record owner calls native mechanic ${String(callee.name)}`,
        );
      }
      if (callee?.type === 'MemberExpression' && memberName(callee) === 'kill') {
        violations.push(`${file.path}: daemon record owner calls child termination kill`);
      }
    });
    visitAst(parsed.program, (node) => {
      if (isPlatformComparison(node, platformAliases)) {
        violations.push(`${file.path}: daemon record owner contains platform comparison`);
      }
      if (
        node.type === 'SwitchStatement' &&
        isPlatformSelector(node.discriminant, platformAliases)
      ) {
        violations.push(`${file.path}: daemon record owner contains platform switch`);
      }
    });
  }
  return violations;
}

function isDaemonRecordOwner(filePath: string): boolean {
  return /^src\/daemon\/handlers\/record-runtime(?:-[^/]+)?\.ts$/.test(filePath);
}

function isDaemonRecordMechanicImport(imported: string): boolean {
  return (
    imported === 'node:child_process' ||
    imported === 'node:fs' ||
    imported.includes('/platforms/') ||
    imported.includes('/provider-') ||
    imported === '@agent-device/host-kit/command' ||
    imported.includes('/recording/overlay')
  );
}

function isPlatformComparison(
  node: Record<string, unknown>,
  platformAliases: ReadonlySet<string>,
): boolean {
  if (node.type !== 'BinaryExpression') return false;
  if (!['===', '!==', '==', '!='].includes(String(node.operator))) return false;
  return (
    isPlatformSelector(node.left, platformAliases) ||
    isPlatformSelector(node.right, platformAliases)
  );
}

function collectPlatformAliases(node: unknown): Set<string> {
  const aliases = new Set<string>();
  visitAst(node, (candidate) => {
    if (candidate.type !== 'VariableDeclarator' || !isPlatformAccess(candidate.init)) return;
    const id = candidate.id as Record<string, unknown> | undefined;
    if (id?.type === 'Identifier') aliases.add(String(id.name));
  });
  return aliases;
}

function isPlatformSelector(node: unknown, aliases: ReadonlySet<string>): boolean {
  if (isPlatformAccess(node)) return true;
  return (
    node !== null &&
    typeof node === 'object' &&
    (node as Record<string, unknown>).type === 'Identifier' &&
    aliases.has(String((node as Record<string, unknown>).name))
  );
}

function isPlatformAccess(node: unknown): boolean {
  return (
    node !== null &&
    typeof node === 'object' &&
    (node as Record<string, unknown>).type === 'MemberExpression' &&
    memberName(node as Record<string, unknown>) === 'platform'
  );
}
