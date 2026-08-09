import { parseSync } from 'oxc-parser';

export type LogsRuntimeProductionSource = Readonly<{ path: string; source: string }>;

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
): string[] {
  const violations: string[] = [];
  for (const file of sources) {
    const parsed = parseSync(file.path, file.source);
    const seenRoutes = new Set<string>();
    visitAst(parsed.program, (node) => {
      const route = legacyRouteName(node);
      if (route) {
        const identity = `${String(node.start ?? '')}:${route}`;
        if (!seenRoutes.has(identity)) {
          seenRoutes.add(identity);
          violations.push(`${file.path}: legacy logs route ${route}`);
        }
      }
      if (isLegacyLogsAdmission(node)) {
        violations.push(`${file.path}: legacy logs capability admission requireCommandSupported`);
      }
      if (
        file.path === 'src/core/command-descriptor/registry.ts' &&
        isLogsDescriptorWithCapability(node)
      ) {
        violations.push(`${file.path}: logs descriptor retains legacy capability admission`);
      }
      if (file.path === 'src/platforms/apple/plugin.ts' && isAppleLogsCommandMember(node)) {
        violations.push(`${file.path}: Apple plugin retains legacy logs support or hint closure`);
      }
      if (file.path === 'src/core/capabilities.ts' && isHarmonyLogsCommandSetDeclaration(node)) {
        violations.push(`${file.path}: HarmonyOS static command set retains logs admission`);
      }
      if (
        (file.path === 'packages/contracts/src/platform-plugin.ts' ||
          /^src\/platforms\/.+\/plugin\.ts$/.test(file.path)) &&
        isPlatformPluginAppLogFacet(node)
      ) {
        violations.push(`${file.path}: legacy PlatformPlugin appLog facet`);
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
    args?.[0]?.type === 'Literal' &&
    args[0].value === 'logs'
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
  if (node.type !== 'MemberExpression') return false;
  const object = node.object as Record<string, unknown> | undefined;
  return (
    object?.type === 'Identifier' &&
    object.name === 'PUBLIC_COMMANDS' &&
    memberName(node) === 'logs'
  );
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

function isPlatformPluginAppLogFacet(node: Record<string, unknown>): boolean {
  return (
    (node.type === 'Property' || node.type === 'TSPropertySignature') &&
    node.computed !== true &&
    propertyName(node.key) === 'appLog'
  );
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
): string[] {
  const violations: string[] = [];
  for (const file of sources.filter(({ path }) => path.startsWith('src/daemon/'))) {
    for (const pattern of [
      RUNTIME_TYPE_ASSERTION,
      NON_NULL_RUNTIME_OPERATION,
      BRACKETED_RUNTIME_OPERATION,
    ]) {
      for (const match of file.source.matchAll(pattern)) {
        violations.push(`${file.path}: widened logs runtime access ${match[0]}`);
      }
    }
  }
  return violations;
}

/** Session app-log state transitions have one whole-record replacement owner. */
export function logsSessionStateOwnershipViolations(
  sources: readonly LogsRuntimeProductionSource[],
): string[] {
  const violations: string[] = [];
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
        if (field === 'appLog' || field === 'appLogFailure') {
          violations.push(`${file.path}: session ${field} record constructed outside its owner`);
        }
      }
    });
  }
  return violations;
}

/**
 * Source-executed TypeScript must remain parseable by the supported Node 22
 * type-stripping runtime. OXC identifies both declaration forms without
 * mistaking comments or string data for executable syntax.
 */
export function sourceExecutedUsingDeclarationViolations(
  sources: readonly LogsRuntimeProductionSource[],
): string[] {
  const violations: string[] = [];
  for (const file of sources) {
    const parsed = parseSync(file.path, file.source);
    visitAst(parsed.program, (node) => {
      if (
        node.type === 'VariableDeclaration' &&
        (node.kind === 'using' || node.kind === 'await using')
      ) {
        violations.push(
          `${file.path}: source-executed TypeScript uses unsupported ${String(node.kind)} declaration`,
        );
      }
    });
  }
  return violations;
}

function propertyName(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  return record.type === 'Identifier' || record.type === 'Literal'
    ? ((record.name as string | undefined) ?? (record.value as string | undefined))
    : undefined;
}
