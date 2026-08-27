import { parseSync } from 'oxc-parser';
import { memberName, visitAst } from './cutover-policy-ast.ts';
import type { LayeringViolation } from './model.ts';

type AstNode = Record<string, unknown>;

export const APPLICATION_LIFECYCLE_OWNERSHIP_RULE = 'R69 application-lifecycle-ownership';

const GATEWAY_FILE = 'src/platform-runtime-gateway.ts';
const APPLICATION_RESOURCES_FILE = 'src/platform-runtime-application-resources.ts';
const IME_ACTIVATION_FILE = 'packages/platform-android/src/ime-activation.ts';

/** Permanent durable-resource ordering and ownership rules for application lifecycle. */
export function applicationLifecycleOwnershipViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  const gateway = sources.get(GATEWAY_FILE);
  if (
    gateway === undefined ||
    callOffsets(GATEWAY_FILE, gateway, 'runStartupRecoveryFence').length === 0 ||
    containsIdentifier(GATEWAY_FILE, gateway, 'androidApplications') ||
    containsIdentifier(GATEWAY_FILE, gateway, 'appleApplications')
  ) {
    violations.push(
      violation(
        GATEWAY_FILE,
        'the composed runtime gateway must register the startup fence and name no platform-specific durable owner',
      ),
    );
  }

  const resources = sources.get(APPLICATION_RESOURCES_FILE);
  if (
    resources === undefined ||
    !callsInOrder(
      APPLICATION_RESOURCES_FILE,
      resources,
      'hasTestImeRecoveryEvidence',
      'recoverTestImeStartup',
    )
  ) {
    violations.push(
      violation(
        APPLICATION_RESOURCES_FILE,
        'durable startup recovery must gate lazy Android test-IME recovery behind its marker evidence',
      ),
    );
  }

  const ime = sources.get(IME_ACTIVATION_FILE);
  if (
    ime === undefined ||
    !callsInOrder(
      IME_ACTIVATION_FILE,
      ime,
      'waitForStartupRecoveryFence',
      'resolveAndroidAdbExecutor',
    )
  ) {
    violations.push(
      violation(
        IME_ACTIVATION_FILE,
        'Android test-IME mutation must wait for startup recovery before loading ADB mechanics',
      ),
    );
  }

  if (
    sources.has('packages/capture-kit/src/platform-runtime-unavailable.ts') ||
    sources
      .get('packages/capture-kit/src/index.ts')
      ?.includes('createUnavailablePlatformRuntime') === true
  ) {
    violations.push(
      violation(
        'packages/capture-kit/src/index.ts',
        'capture-kit must not own a generic platform-runtime lifecycle role',
      ),
    );
  }
  return violations;
}

function callsInOrder(file: string, source: string, first: string, second: string): boolean {
  const firstCalls = callOffsets(file, source, first);
  const secondCalls = callOffsets(file, source, second);
  return firstCalls.length > 0 && secondCalls.length > 0 && firstCalls[0]! < secondCalls[0]!;
}

function callOffsets(file: string, source: string, expected: string): number[] {
  const found: number[] = [];
  const program = parseSync(file, source).program as AstNode;
  visitAst(program, (node) => {
    if (node['type'] !== 'CallExpression') return;
    const callee = node['callee'] as AstNode | undefined;
    const name =
      callee?.['type'] === 'Identifier'
        ? String(callee['name'])
        : callee?.['type'] === 'MemberExpression'
          ? memberName(callee)
          : undefined;
    if (name === expected && typeof node['start'] === 'number') found.push(node['start']);
  });
  return found.sort((left, right) => left - right);
}

function containsIdentifier(file: string, source: string, expected: string): boolean {
  let found = false;
  const program = parseSync(file, source).program as AstNode;
  visitAst(program, (node) => {
    if (node['type'] === 'Identifier' && node['name'] === expected) found = true;
  });
  return found;
}

function violation(file: string, message: string): LayeringViolation {
  return { rule: APPLICATION_LIFECYCLE_OWNERSHIP_RULE, file, line: 1, message };
}
