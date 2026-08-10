import { parseSync } from 'oxc-parser';
import type { LayeringViolation } from './model.ts';

export type LogsRuntimeProductionSource = Readonly<{ path: string; source: string }>;

const LOGS_RUNTIME_CUTOVER_RULE = 'R14 logs-runtime-cutover';

const LEGACY_LOG_ROUTE_NAMES = new Set([
  'startAppLog',
  'stopAppLog',
  'runAppLogDoctor',
  'resolveLogBackend',
  'withAppLogProvider',
  'appLogProvider',
  'AppLogProviderResolver',
  'AppLogProvider',
]);
const RUNTIME_TYPE_ASSERTION =
  /\bas\s+(?:BoundDeviceRuntime|AppLogRuntimeOperations|AppLogLiveHandle)\b/g;
const NON_NULL_RUNTIME_OPERATION = /\.operations(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])!/g;
const BRACKETED_RUNTIME_OPERATION = /\.operations\[['"]appLog[A-Za-z]+['"]\]/g;

/** Legacy provider/tag execution is forbidden once the logs descriptor is runtime-backed. */
export function logsLegacyRouteViolations(
  sources: readonly LogsRuntimeProductionSource[],
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of sources) {
    const parsed = parseSync(file.path, file.source);
    const seenRoutes = new Set<string>();
    visitAst(parsed.program, (node) => {
      const route = legacyRouteName(node);
      if (route) {
        const identity = `${String(node.start ?? '')}:${route}`;
        if (!seenRoutes.has(identity)) {
          seenRoutes.add(identity);
          violations.push(astViolation(file, node, `legacy logs route ${route}`));
        }
      }
      if (isLegacyLogsAdmission(node)) {
        violations.push(
          astViolation(file, node, 'legacy logs capability admission requireCommandSupported'),
        );
      }
      if (isLogsDescriptorWithCapability(node)) {
        violations.push(
          astViolation(file, node, 'logs descriptor retains legacy capability admission'),
        );
      }
      if (isAppleLogsCommandMember(node)) {
        violations.push(
          astViolation(file, node, 'Apple plugin retains legacy logs support or hint closure'),
        );
      }
      if (isHarmonyLogsCommandSetDeclaration(node)) {
        violations.push(
          astViolation(file, node, 'HarmonyOS static command set retains logs admission'),
        );
      }
      if (isPlatformPluginAppLogDeclaration(node)) {
        violations.push(astViolation(file, node, 'legacy PlatformPlugin appLog facet'));
      }
    });
  }
  return violations;
}

function legacyRouteName(node: Record<string, unknown>): string | undefined {
  if (node.type === 'Identifier' && LEGACY_LOG_ROUTE_NAMES.has(String(node.name))) {
    return String(node.name);
  }
  if (node.type === 'Property' || node.type === 'TSPropertySignature') {
    const key = propertyName(node.key);
    return key && LEGACY_LOG_ROUTE_NAMES.has(key) ? key : undefined;
  }
  if (node.type === 'MemberExpression' && node.computed === true) {
    const key = propertyName(node.property);
    return key && LEGACY_LOG_ROUTE_NAMES.has(key) ? key : undefined;
  }
  return undefined;
}

function isLegacyLogsAdmission(node: Record<string, unknown>): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as Record<string, unknown> | undefined;
  const args = node.arguments as readonly Record<string, unknown>[] | undefined;
  return (
    callee?.type === 'Identifier' &&
    callee.name === 'requireCommandSupported' &&
    isLogsCommandExpression(args?.[0])
  );
}

function isLogsCommandExpression(node: Record<string, unknown> | undefined): boolean {
  if (node?.type === 'Literal') return node.value === 'logs';
  if (node?.type !== 'MemberExpression') return false;
  const object = node.object as Record<string, unknown> | undefined;
  return (
    object?.type === 'Identifier' &&
    object.name === 'PUBLIC_COMMANDS' &&
    memberName(node) === 'logs'
  );
}

function isLogsDescriptorWithCapability(node: Record<string, unknown>): boolean {
  if (node.type !== 'ObjectExpression' || !Array.isArray(node.properties)) return false;
  let nameIsLogs = false;
  let hasCapability = false;
  for (const property of node.properties as Record<string, unknown>[]) {
    if (property.type !== 'Property' || property.computed === true) continue;
    const key = propertyName(property.key);
    const value = property.value as Record<string, unknown> | undefined;
    if (key === 'name' && value?.type === 'Literal' && value.value === 'logs') {
      nameIsLogs = true;
    }
    if (key === 'capability') hasCapability = true;
  }
  return nameIsLogs && hasCapability;
}

function isAppleLogsCommandMember(node: Record<string, unknown>): boolean {
  if (node.type !== 'Property' || node.computed !== true) return false;
  return isLogsCommandExpression(node.key as Record<string, unknown> | undefined);
}

function isHarmonyLogsCommandSetDeclaration(node: Record<string, unknown>): boolean {
  if (node.type !== 'VariableDeclarator') return false;
  const id = node.id as Record<string, unknown> | undefined;
  return (
    id?.type === 'Identifier' &&
    id.name === 'HARMONYOS_SUPPORTED_COMMANDS' &&
    astContainsString(node.init, 'logs')
  );
}

function isPlatformPluginAppLogDeclaration(node: Record<string, unknown>): boolean {
  if (node.type === 'TSTypeAliasDeclaration' || node.type === 'TSInterfaceDeclaration') {
    const id = node.id as Record<string, unknown> | undefined;
    return id?.type === 'Identifier' && id.name === 'PlatformPlugin' && astContainsAppLog(node);
  }
  if (node.type === 'TSSatisfiesExpression' || node.type === 'TSAsExpression') {
    return isNamedType(node.typeAnnotation, 'PlatformPlugin') && astContainsAppLog(node.expression);
  }
  if (node.type !== 'VariableDeclarator') return false;
  const id = node.id as Record<string, unknown> | undefined;
  return isNamedType(id?.typeAnnotation, 'PlatformPlugin') && astContainsAppLog(node.init);
}

function isNamedType(node: unknown, expected: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  const record = node as Record<string, unknown>;
  if (record.type === 'TSTypeAnnotation') return isNamedType(record.typeAnnotation, expected);
  if (record.type !== 'TSTypeReference') return false;
  const name = record.typeName as Record<string, unknown> | undefined;
  return name?.type === 'Identifier' && name.name === expected;
}

function astContainsAppLog(node: unknown): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (
      (candidate.type === 'Property' || candidate.type === 'TSPropertySignature') &&
      candidate.computed !== true &&
      propertyName(candidate.key) === 'appLog'
    ) {
      found = true;
    }
  });
  return found;
}

function memberName(node: Record<string, unknown>): string | undefined {
  const property = node.property as Record<string, unknown> | undefined;
  if (!property) return undefined;
  if (node.computed === true) return propertyName(property);
  return property.type === 'Identifier' ? String(property.name) : undefined;
}

function astContainsString(node: unknown, expected: string): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (candidate.type === 'Literal' && candidate.value === expected) found = true;
  });
  return found;
}

function visitAst(node: unknown, visitor: (node: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visitAst(child, visitor);
    return;
  }
  const record = node as Record<string, unknown>;
  visitor(record);
  for (const child of Object.values(record)) visitAst(child, visitor);
}

/** Migrated daemon owners consume narrowed operations without manufacturing facet proof. */
export function logsRuntimeNarrowingViolations(
  sources: readonly LogsRuntimeProductionSource[],
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of sources.filter(({ path }) => path.startsWith('src/daemon/'))) {
    for (const pattern of [
      RUNTIME_TYPE_ASSERTION,
      NON_NULL_RUNTIME_OPERATION,
      BRACKETED_RUNTIME_OPERATION,
    ]) {
      for (const match of file.source.matchAll(pattern)) {
        violations.push(
          offsetViolation(file, match.index, `widened logs runtime access ${match[0]}`),
        );
      }
    }
  }
  return violations;
}

/** Session app-log state transitions have one whole-record replacement owner. */
export function logsSessionStateOwnershipViolations(
  sources: readonly LogsRuntimeProductionSource[],
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of sources) {
    if (
      !file.path.startsWith('src/daemon/') ||
      file.path === 'src/daemon/app-log-session-resource.ts' ||
      file.path === 'src/daemon/types.ts'
    ) {
      continue;
    }
    const parsed = parseSync(file.path, file.source);
    visitAst(parsed.program, (node) => {
      if (node.type === 'Property' && node.kind === 'init' && node.computed !== true) {
        const field = propertyName(node.key);
        if (
          (field === 'appLog' || field === 'appLogFailure') &&
          !isAppLogTeardownDiscriminant(field, node.value)
        ) {
          violations.push(
            astViolation(file, node, `session ${field} record constructed outside its owner`),
          );
        }
      }
    });
  }
  return violations;
}

function isAppLogTeardownDiscriminant(field: string, valueNode: unknown): boolean {
  if (field !== 'appLog' || !valueNode || typeof valueNode !== 'object') return false;
  const value = valueNode as Record<string, unknown>;
  return value.type === 'Literal' && (value.value === 'run' || value.value === 'already-settled');
}

/**
 * Source-executed TypeScript must remain parseable by the supported Node 22
 * type-stripping runtime. OXC identifies both declaration forms without
 * mistaking comments or string data for executable syntax.
 */
export function sourceExecutedUsingDeclarationViolations(
  sources: readonly LogsRuntimeProductionSource[],
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of sources) {
    const parsed = parseSync(file.path, file.source);
    visitAst(parsed.program, (node) => {
      if (
        node.type === 'VariableDeclaration' &&
        (node.kind === 'using' || node.kind === 'await using')
      ) {
        violations.push(
          astViolation(
            file,
            node,
            `source-executed TypeScript uses unsupported ${String(node.kind)} declaration`,
          ),
        );
      }
    });
  }
  return violations;
}

function astViolation(
  file: LogsRuntimeProductionSource,
  node: Record<string, unknown>,
  message: string,
): LayeringViolation {
  return offsetViolation(file, typeof node.start === 'number' ? node.start : 0, message);
}

function offsetViolation(
  file: LogsRuntimeProductionSource,
  offset: number,
  message: string,
): LayeringViolation {
  return {
    rule: LOGS_RUNTIME_CUTOVER_RULE,
    file: file.path,
    line: file.source.slice(0, offset).split('\n').length,
    message,
  };
}

function propertyName(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  return record.type === 'Identifier' || record.type === 'Literal'
    ? ((record.name as string | undefined) ?? (record.value as string | undefined))
    : undefined;
}
