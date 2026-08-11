import { parseSync } from 'oxc-parser';
import {
  memberName,
  propertyName,
  type RecordRuntimeProductionSource,
  visitAst,
} from './record-runtime-policy-ast.ts';

const LEGACY_RECORD_ROUTE_NAMES = new Set([
  'resolveRecordingBackendForDevice',
  'stopActiveRecording',
  'RecordingBackend',
  'RecordingStartBackend',
]);
const RETIRED_RECORDING_PROVIDER_NAMES = new Set([
  'RecordingProvider',
  'RecordingProviderResolver',
  'recordingProvider',
  'resolveRecordingProvider',
  'withRecordingProvider',
  'createLocalRecordingProvider',
]);
const SCREEN_RECORDING_OPERATION_NAMES = new Set([
  'screenRecordingStart',
  'screenRecordingReattach',
  'screenRecordingCleanup',
]);

/** Record owns one runtime-backed route: legacy tag/backend selection may not survive it. */
export function recordLegacyRouteViolations(
  sources: readonly RecordRuntimeProductionSource[],
): string[] {
  const violations: string[] = [];
  for (const file of sources) {
    if (file.path === 'src/daemon/recording-provider.ts') {
      violations.push(`${file.path}: retired recording provider module`);
    }
    const parsed = parseSync(file.path, file.source);
    const seen = new Set<string>();
    visitAst(parsed.program, (node) => {
      if (isRetiredRecordingProviderImport(node)) {
        pushOnce(violations, seen, node, file, 'retired recording provider module');
      }
      if (node.type === 'Identifier' && RETIRED_RECORDING_PROVIDER_NAMES.has(String(node.name))) {
        pushOnce(
          violations,
          seen,
          node,
          file,
          `retired recording provider name ${String(node.name)}`,
        );
      }
      if (isRetiredRecordingProviderComputedProperty(node)) {
        pushOnce(
          violations,
          seen,
          node,
          file,
          `retired recording provider name ${String(propertyName(node.key))}`,
        );
      }
      if (isNamedIdentifier(node, 'RECORDING_BACKENDS_BY_TAG')) {
        pushOnce(
          violations,
          seen,
          node,
          file,
          'legacy recording backend map RECORDING_BACKENDS_BY_TAG',
        );
      }
      if (isNamedIdentifier(node, 'RecordingBackendTag')) {
        pushOnce(violations, seen, node, file, 'legacy recording backend tag RecordingBackendTag');
      }
      const route = legacyRecordRouteName(node);
      if (route) pushOnce(violations, seen, node, file, `legacy recording route ${route}`);
      if (isLegacyRecordAdmission(node)) {
        pushOnce(
          violations,
          seen,
          node,
          file,
          'legacy record capability admission requireCommandSupported',
        );
      }
      if (isRecordDescriptorWithCapability(node)) {
        pushOnce(
          violations,
          seen,
          node,
          file,
          'record descriptor retains legacy capability admission',
        );
      }
      if (isPlatformPluginRecordingDeclaration(node)) {
        pushOnce(violations, seen, node, file, 'legacy PlatformPlugin recording facet');
      }
    });
  }
  return violations;
}

function isNamedIdentifier(node: Record<string, unknown>, name: string): boolean {
  return node.type === 'Identifier' && node.name === name;
}

/** Daemon consumers must not manufacture proof for screen-recording runtime operations. */
export function recordRuntimeNarrowingViolations(
  sources: readonly RecordRuntimeProductionSource[],
): string[] {
  const violations: string[] = [];
  for (const file of sources.filter(({ path }) => path.startsWith('src/daemon/'))) {
    const parsed = parseSync(file.path, file.source);
    visitAst(parsed.program, (node) => {
      if (node.type === 'TSAsExpression' && containsRuntimeTypeRepair(node.typeAnnotation)) {
        violations.push(`${file.path}: widened screen-recording runtime type assertion`);
      }
      if (
        node.type === 'TSNonNullExpression' &&
        isScreenRecordingOperationAccess(node.expression)
      ) {
        violations.push(`${file.path}: non-null repair of screen-recording operation`);
      }
      if (isBracketedScreenRecordingOperationAccess(node)) {
        violations.push(`${file.path}: bracketed screen-recording operation access`);
      }
    });
  }
  return violations;
}

/** Record keeps the one existing record-trace gateway; trace mechanics are otherwise out of scope. */
export function recordRuntimeRouteViolations(
  sources: readonly RecordRuntimeProductionSource[],
): string[] {
  let recordTraceGatewayCalls = 0;
  let startCalls = 0;
  let reattachCalls = 0;
  let cleanupCalls = 0;
  for (const file of sources.filter(({ path }) => path.startsWith('src/daemon/'))) {
    const parsed = parseSync(file.path, file.source);
    visitAst(parsed.program, (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee as Record<string, unknown> | undefined;
      if (callee?.type === 'Identifier' && callee.name === 'handleRecordTraceCommands') {
        recordTraceGatewayCalls += 1;
      }
      if (callee?.type !== 'MemberExpression' || !isRuntimeScreenRecordingOperation(callee)) return;
      switch (memberName(callee)) {
        case 'screenRecordingStart':
          startCalls += 1;
          break;
        case 'screenRecordingReattach':
          reattachCalls += 1;
          break;
        case 'screenRecordingCleanup':
          cleanupCalls += 1;
          break;
      }
    });
  }
  return [
    exactRouteViolation('handleRecordTraceCommands', recordTraceGatewayCalls),
    exactOperationViolation('screenRecordingStart', startCalls),
    exactOperationViolation('screenRecordingReattach', reattachCalls),
    exactOperationViolation('screenRecordingCleanup', cleanupCalls),
  ].filter((violation): violation is string => violation !== null);
}

function isRetiredRecordingProviderImport(node: Record<string, unknown>): boolean {
  if (node.type !== 'ImportDeclaration' && node.type !== 'ImportExpression') return false;
  const source = node.source as Record<string, unknown> | undefined;
  return (
    source?.type === 'Literal' &&
    /(?:^|\/)recording-provider(?:\.[cm]?[jt]s)?$/.test(String(source.value))
  );
}

function isRetiredRecordingProviderComputedProperty(node: Record<string, unknown>): boolean {
  return (
    (node.type === 'Property' || node.type === 'TSPropertySignature') &&
    node.computed === true &&
    RETIRED_RECORDING_PROVIDER_NAMES.has(propertyName(node.key) ?? '')
  );
}

function legacyRecordRouteName(node: Record<string, unknown>): string | undefined {
  if (node.type === 'Identifier' && LEGACY_RECORD_ROUTE_NAMES.has(String(node.name))) {
    return String(node.name);
  }
  if (node.type === 'Property' || node.type === 'TSPropertySignature') {
    const name = propertyName(node.key);
    return name && LEGACY_RECORD_ROUTE_NAMES.has(name) ? name : undefined;
  }
  return undefined;
}

function isLegacyRecordAdmission(node: Record<string, unknown>): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee as Record<string, unknown> | undefined;
  const args = node.arguments as readonly Record<string, unknown>[] | undefined;
  return (
    callee?.type === 'Identifier' &&
    callee.name === 'requireCommandSupported' &&
    isRecordCommandExpression(args?.[0])
  );
}

function isRecordCommandExpression(node: Record<string, unknown> | undefined): boolean {
  if (node?.type === 'Literal') return node.value === 'record';
  if (node?.type !== 'MemberExpression') return false;
  const object = node.object as Record<string, unknown> | undefined;
  return (
    object?.type === 'Identifier' &&
    object.name === 'PUBLIC_COMMANDS' &&
    memberName(node) === 'record'
  );
}

function isRecordDescriptorWithCapability(node: Record<string, unknown>): boolean {
  if (node.type !== 'ObjectExpression' || !Array.isArray(node.properties)) return false;
  let record = false;
  let capability = false;
  for (const property of node.properties as Record<string, unknown>[]) {
    if (property.type !== 'Property' || property.computed === true) continue;
    const key = propertyName(property.key);
    const value = property.value as Record<string, unknown> | undefined;
    if (key === 'name' && value?.type === 'Literal' && value.value === 'record') record = true;
    if (key === 'capability') capability = true;
  }
  return record && capability;
}

function isPlatformPluginRecordingDeclaration(node: Record<string, unknown>): boolean {
  if (node.type === 'TSTypeAliasDeclaration' || node.type === 'TSInterfaceDeclaration') {
    const id = node.id as Record<string, unknown> | undefined;
    return id?.type === 'Identifier' && id.name === 'PlatformPlugin' && astContainsRecording(node);
  }
  if (node.type === 'TSSatisfiesExpression' || node.type === 'TSAsExpression') {
    return (
      isNamedType(node.typeAnnotation, 'PlatformPlugin') && astContainsRecording(node.expression)
    );
  }
  if (node.type !== 'VariableDeclarator') return false;
  const id = node.id as Record<string, unknown> | undefined;
  return isNamedType(id?.typeAnnotation, 'PlatformPlugin') && astContainsRecording(node.init);
}

function astContainsRecording(node: unknown): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (
      (candidate.type === 'Property' || candidate.type === 'TSPropertySignature') &&
      candidate.computed !== true &&
      propertyName(candidate.key) === 'recording'
    ) {
      found = true;
    }
  });
  return found;
}

function containsRuntimeTypeRepair(node: unknown): boolean {
  let found = false;
  visitAst(node, (candidate) => {
    if (
      candidate.type === 'Identifier' &&
      (candidate.name === 'BoundDeviceRuntime' ||
        candidate.name === 'ScreenRecordingRuntimeOperations' ||
        candidate.name === 'ScreenRecordingLiveHandle')
    ) {
      found = true;
    }
  });
  return found;
}

function isScreenRecordingOperationAccess(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return false;
  const member = node as Record<string, unknown>;
  return (
    member.type === 'MemberExpression' &&
    SCREEN_RECORDING_OPERATION_NAMES.has(memberName(member) ?? '')
  );
}

function isBracketedScreenRecordingOperationAccess(node: Record<string, unknown>): boolean {
  if (node.type !== 'MemberExpression' || node.computed !== true) return false;
  const object = node.object as Record<string, unknown> | undefined;
  return (
    SCREEN_RECORDING_OPERATION_NAMES.has(memberName(node) ?? '') &&
    object?.type === 'MemberExpression' &&
    memberName(object) === 'operations'
  );
}

function isRuntimeScreenRecordingOperation(node: Record<string, unknown>): boolean {
  const object = node.object as Record<string, unknown> | undefined;
  return (
    SCREEN_RECORDING_OPERATION_NAMES.has(memberName(node) ?? '') &&
    object?.type === 'MemberExpression' &&
    memberName(object) === 'operations'
  );
}

function exactRouteViolation(name: string, calls: number): string | null {
  return calls === 1 ? null : `(record runtime): expected one ${name} route, found ${calls}`;
}

function exactOperationViolation(name: string, calls: number): string | null {
  return calls === 1
    ? null
    : `(record runtime): expected one narrowed ${name} call, found ${calls}`;
}

function pushOnce(
  violations: string[],
  seen: Set<string>,
  node: Record<string, unknown>,
  file: RecordRuntimeProductionSource,
  message: string,
): void {
  const identity = `${String(node.start ?? '')}:${message}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  violations.push(`${file.path}: ${message}`);
}

function isNamedType(node: unknown, expected: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  const record = node as Record<string, unknown>;
  if (record.type === 'TSTypeAnnotation') return isNamedType(record.typeAnnotation, expected);
  if (record.type !== 'TSTypeReference') return false;
  const name = record.typeName as Record<string, unknown> | undefined;
  return name?.type === 'Identifier' && name.name === expected;
}
