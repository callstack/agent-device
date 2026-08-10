import { parseSync } from 'oxc-parser';

export type NetworkRuntimeProductionSource = Readonly<{ path: string; source: string }>;

const RETIRED_DAEMON_MODULES = new Set([
  'src/daemon/network-log.ts',
  'src/daemon/app-log-network-recovery.ts',
  'src/daemon/network-log-android-recovery.ts',
  'src/daemon/network-log-ios-simulator-recovery.ts',
]);
const LEGACY_NETWORK_ROUTE_NAMES = new Set([
  'handleWebNetworkCommand',
  'readSessionNetworkCapture',
  'readRecentNetworkTraffic',
  'readRecentAndroidLogcatForPackage',
  'readRecentIosSimulatorLogShowForBundle',
]);

/** Network command admission and execution have one operation-fact-derived route. */
export function networkLegacyRouteViolations(
  sources: readonly NetworkRuntimeProductionSource[],
): string[] {
  const violations: string[] = [];
  for (const file of sources) {
    if (RETIRED_DAEMON_MODULES.has(file.path)) {
      violations.push(`${file.path}: retired daemon network implementation remains`);
    }
    const parsed = parseSync(file.path, file.source);
    const seen = new Set<string>();
    visitAst(parsed.program, (node) => {
      const route = legacyRouteName(node);
      if (route && file.path.startsWith('src/daemon/')) {
        const identity = `${String(node.start ?? '')}:${route}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          violations.push(`${file.path}: legacy network route ${route}`);
        }
      }
      if (isLegacyNetworkAdmission(node)) {
        violations.push(
          `${file.path}: legacy network capability admission requireCommandSupported`,
        );
      }
      if (
        file.path === 'src/core/command-descriptor/registry.ts' &&
        isNetworkDescriptorWithCapability(node)
      ) {
        violations.push(`${file.path}: network descriptor retains legacy capability admission`);
      }
      if (file.path === 'src/core/capabilities.ts' && isStaticNetworkAdmission(node)) {
        violations.push(`${file.path}: static platform command set retains network admission`);
      }
      if (file.path === 'src/platforms/apple/plugin.ts' && isAppleNetworkCommandMember(node)) {
        violations.push(
          `${file.path}: Apple plugin retains legacy network support or hint closure`,
        );
      }
      if (file.path.startsWith('src/daemon/') && isLegacyWebDumpCall(node)) {
        violations.push(`${file.path}: daemon invokes legacy WebProvider.dumpNetwork`);
      }
    });
  }
  return violations;
}

/** Daemon consumers must use the use-narrowed network operation without repairing proof. */
export function networkRuntimeNarrowingViolations(
  sources: readonly NetworkRuntimeProductionSource[],
): string[] {
  const violations: string[] = [];
  for (const file of sources.filter(({ path }) => path.startsWith('src/daemon/'))) {
    const parsed = parseSync(file.path, file.source);
    visitAst(parsed.program, (node) => {
      if (node.type === 'TSAsExpression' && containsRuntimeTypeRepair(node.typeAnnotation)) {
        violations.push(`${file.path}: widened network runtime type assertion`);
      }
      if (node.type === 'TSNonNullExpression' && isNetworkOperationAccess(node.expression)) {
        violations.push(`${file.path}: non-null repair of networkDump operation`);
      }
      if (isBracketedNetworkOperationAccess(node)) {
        violations.push(`${file.path}: bracketed networkDump operation access`);
      }
    });
  }
  return violations;
}

/** The command has one daemon orchestration route and one operation projection call. */
export function networkRuntimeRouteViolations(
  sources: readonly NetworkRuntimeProductionSource[],
): string[] {
  let handlerCalls = 0;
  let operationCalls = 0;
  for (const file of sources.filter(({ path }) => path.startsWith('src/daemon/'))) {
    const parsed = parseSync(file.path, file.source);
    visitAst(parsed.program, (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as Record<string, unknown> | undefined;
      if (callee?.type === 'Identifier' && callee.name === 'handleNetworkCommand') {
        handlerCalls += 1;
      }
      if (callee?.type === 'MemberExpression' && isRuntimeNetworkOperation(callee)) {
        operationCalls += 1;
      }
    });
  }
  const violations: string[] = [];
  if (handlerCalls !== 1) {
    violations.push(
      `(network runtime): expected one handleNetworkCommand route, found ${handlerCalls}`,
    );
  }
  if (operationCalls !== 1) {
    violations.push(
      `(network runtime): expected one narrowed networkDump call, found ${operationCalls}`,
    );
  }
  return violations;
}

function legacyRouteName(node: Record<string, unknown>): string | undefined {
  if (node.type === 'Identifier' && LEGACY_NETWORK_ROUTE_NAMES.has(String(node.name))) {
    return String(node.name);
  }
  if (node.type === 'Property' || node.type === 'TSPropertySignature') {
    const name = propertyName(node.key);
    return name && LEGACY_NETWORK_ROUTE_NAMES.has(name) ? name : undefined;
  }
  return undefined;
}

function isLegacyNetworkAdmission(node: Record<string, unknown>): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as Record<string, unknown> | undefined;
  const args = node.arguments as readonly Record<string, unknown>[] | undefined;
  return (
    callee?.type === 'Identifier' &&
    callee.name === 'requireCommandSupported' &&
    args?.[0]?.type === 'Literal' &&
    args[0].value === 'network'
  );
}

function isNetworkDescriptorWithCapability(node: Record<string, unknown>): boolean {
  if (node.type !== 'ObjectExpression' || !Array.isArray(node.properties)) return false;
  let network = false;
  let capability = false;
  for (const property of node.properties as Record<string, unknown>[]) {
    if (property.type !== 'Property' || property.computed === true) continue;
    const key = propertyName(property.key);
    const value = property.value as Record<string, unknown> | undefined;
    if (key === 'name' && value?.type === 'Literal' && value.value === 'network') network = true;
    if (key === 'capability') capability = true;
  }
  return network && capability;
}

function isStaticNetworkAdmission(node: Record<string, unknown>): boolean {
  if (node.type !== 'VariableDeclarator') return false;
  const id = node.id as Record<string, unknown> | undefined;
  return (
    id?.type === 'Identifier' &&
    /(?:WEB|HARMONY).*COMMANDS/.test(String(id.name)) &&
    astContainsString(node.init, 'network')
  );
}

function isAppleNetworkCommandMember(node: Record<string, unknown>): boolean {
  if (node.type !== 'MemberExpression') return false;
  const object = node.object as Record<string, unknown> | undefined;
  return (
    object?.type === 'Identifier' &&
    object.name === 'PUBLIC_COMMANDS' &&
    memberName(node) === 'network'
  );
}

function isLegacyWebDumpCall(node: Record<string, unknown>): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as Record<string, unknown> | undefined;
  return callee?.type === 'MemberExpression' && memberName(callee) === 'dumpNetwork';
}

function containsRuntimeTypeRepair(node: unknown): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (
      candidate.type === 'Identifier' &&
      (candidate.name === 'BoundDeviceRuntime' || candidate.name === 'NetworkRuntimeOperations')
    ) {
      found = true;
    }
  });
  return found;
}

function isNetworkOperationAccess(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const member = node as Record<string, unknown>;
  return member.type === 'MemberExpression' && memberName(member) === 'networkDump';
}

function isBracketedNetworkOperationAccess(node: Record<string, unknown>): boolean {
  if (node.type !== 'MemberExpression' || node.computed !== true) return false;
  const object = node.object as Record<string, unknown> | undefined;
  return (
    memberName(node) === 'networkDump' &&
    object?.type === 'MemberExpression' &&
    memberName(object) === 'operations'
  );
}

function isRuntimeNetworkOperation(node: Record<string, unknown>): boolean {
  const object = node.object as Record<string, unknown> | undefined;
  return (
    memberName(node) === 'networkDump' &&
    object?.type === 'MemberExpression' &&
    memberName(object) === 'operations'
  );
}

function memberName(node: Record<string, unknown>): string | undefined {
  const property = node.property as Record<string, unknown> | undefined;
  if (!property) return undefined;
  return node.computed === true
    ? propertyName(property)
    : property.type === 'Identifier'
      ? String(property.name)
      : undefined;
}

function astContainsString(node: unknown, expected: string): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (candidate.type === 'Literal' && candidate.value === expected) found = true;
  });
  return found;
}

function propertyName(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const value = node as Record<string, unknown>;
  return value.type === 'Identifier' || value.type === 'Literal'
    ? ((value.name as string | undefined) ?? (value.value as string | undefined))
    : undefined;
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
