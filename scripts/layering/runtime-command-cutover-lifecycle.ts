import { parseSync } from 'oxc-parser';
import { visitAst } from './cutover-policy-ast.ts';
import { retiredDispatchProjectionViolations } from './runtime-command-cutover-descriptor.ts';
import {
  callName,
  countNamedCalls,
  lineOf,
  namedFunction,
  type CutoverAstNode,
} from './runtime-command-cutover-ast.ts';
import type { UnruledViolation } from './runtime-command-cutover-model.ts';

const RUNTIME_ADMISSION_MODULE = 'src/daemon/runtime-admission.ts';
const APPLICATION_RESOURCES_FILE = 'src/platform-runtime-application-resources.ts';
const RUNTIME_ADMISSION_HELPERS = ['admitRuntimeUse', 'admitRuntimeOperations'];

type LifecycleAdmissionRule = Readonly<{ functionName: string; file?: string }>;

type LifecycleHandlerRule = Readonly<{
  command: 'open' | 'prepare' | 'close' | 'runtime';
  file: string;
  admissions: readonly LifecycleAdmissionRule[];
  forbiddenCalls: readonly string[];
}>;

const RAW_RUNTIME_GATEWAY_CALLS = ['inspectFacts', 'bindDevice'];

const LIFECYCLE_HANDLER_RULES = {
  open: {
    command: 'open',
    file: 'src/daemon/handlers/session-open.ts',
    admissions: [{ functionName: 'admitOpenRuntime' }],
    forbiddenCalls: [
      ...RAW_RUNTIME_GATEWAY_CALLS,
      'dispatchCommand',
      'resolveSoleForegroundIosApp',
      'runAndroidAdb',
      'runXcrun',
      'shutdownDeviceTarget',
    ],
  },
  prepare: {
    command: 'prepare',
    file: 'src/daemon/handlers/session-prepare.ts',
    admissions: [{ functionName: 'admitPrepareRuntime' }],
    forbiddenCalls: [
      ...RAW_RUNTIME_GATEWAY_CALLS,
      'dispatchCommand',
      'prepareIosRunner',
      'runXcrun',
      'shutdownDeviceTarget',
    ],
  },
  close: {
    command: 'close',
    file: 'src/daemon/handlers/session-close-runtime-admission.ts',
    admissions: [{ functionName: 'admitCloseRuntime' }],
    forbiddenCalls: [
      ...RAW_RUNTIME_GATEWAY_CALLS,
      'dispatchCommand',
      'shutdownDeviceTarget',
      'runAndroidAdb',
      'runXcrun',
    ],
  },
  runtime: {
    command: 'runtime',
    file: 'src/daemon/handlers/session-runtime-command.ts',
    admissions: [
      { functionName: 'admitClearRuntime' },
      {
        functionName: 'handlePortReverseCommand',
        file: 'src/daemon/handlers/session-runtime-port-reverse.ts',
      },
    ],
    forbiddenCalls: [
      ...RAW_RUNTIME_GATEWAY_CALLS,
      'dispatchCommand',
      'shutdownDeviceTarget',
      'runAndroidAdb',
      'runXcrun',
    ],
  },
} satisfies Record<'open' | 'prepare' | 'close' | 'runtime', LifecycleHandlerRule>;

export const openLifecycleRouteBindingViolations = (sources: ReadonlyMap<string, string>) =>
  lifecycleHandlerRouteBindingViolations(sources, LIFECYCLE_HANDLER_RULES.open);
export const prepareLifecycleRouteBindingViolations = (sources: ReadonlyMap<string, string>) =>
  lifecycleHandlerRouteBindingViolations(sources, LIFECYCLE_HANDLER_RULES.prepare);
export const closeLifecycleRouteBindingViolations = (sources: ReadonlyMap<string, string>) => [
  ...lifecycleHandlerRouteBindingViolations(sources, LIFECYCLE_HANDLER_RULES.close),
  ...retiredDispatchProjectionViolations(sources, 'close'),
];
export const runtimeLifecycleRouteBindingViolations = (sources: ReadonlyMap<string, string>) =>
  lifecycleHandlerRouteBindingViolations(sources, LIFECYCLE_HANDLER_RULES.runtime);

function lifecycleHandlerRouteBindingViolations(
  sources: ReadonlyMap<string, string>,
  rule: LifecycleHandlerRule,
): UnruledViolation[] {
  const source = sources.get(rule.file);
  if (source === undefined) {
    return [
      {
        file: rule.file,
        line: 1,
        message: `${rule.command} lifecycle handler module is missing`,
      },
    ];
  }
  const violations: UnruledViolation[] = [];
  for (const admission of rule.admissions) {
    const admissionFile = admission.file ?? rule.file;
    const admissionSource = sources.get(admissionFile);
    if (admissionSource === undefined) {
      violations.push({
        file: admissionFile,
        line: 1,
        message: `${rule.command} lifecycle handler module is missing`,
      });
      continue;
    }
    const program = parseSync(admissionFile, admissionSource).program as CutoverAstNode;
    const functionNode = namedFunction(program, admission.functionName);
    if (functionNode === undefined) {
      violations.push({
        file: admissionFile,
        line: 1,
        message: `${rule.command} must retain its ${admission.functionName} admission seam`,
      });
      continue;
    }
    const admissionCalls = RUNTIME_ADMISSION_HELPERS.reduce(
      (total, helper) => total + countNamedCalls(functionNode, helper),
      0,
    );
    if (admissionCalls !== 1) {
      violations.push({
        file: admissionFile,
        line: lineOf(admissionSource, functionNode),
        message: `${rule.command} ${admission.functionName} must make one shared runtime admission call (found ${admissionCalls})`,
      });
    }
  }
  const routeFiles = new Set([rule.file, ...rule.admissions.flatMap(({ file }) => file ?? [])]);
  for (const routeFile of routeFiles) {
    const routeSource = sources.get(routeFile);
    if (routeSource === undefined) continue;
    const program = parseSync(routeFile, routeSource).program as CutoverAstNode;
    visitAst(program, (node) => {
      const call = callName(node);
      if (call === undefined || !rule.forbiddenCalls.includes(call)) return;
      violations.push({
        file: routeFile,
        line: lineOf(routeSource, node),
        message: `${rule.command} handler reaches legacy or local platform call ${call} outside its bound runtime`,
      });
    });
  }
  violations.push(...sharedRuntimeAdmissionViolations(sources));
  return violations;
}

function sharedRuntimeAdmissionViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const source = sources.get(RUNTIME_ADMISSION_MODULE);
  if (source === undefined) {
    return [
      {
        file: RUNTIME_ADMISSION_MODULE,
        line: 1,
        message: 'shared runtime admission module is missing',
      },
    ];
  }
  const program = parseSync(RUNTIME_ADMISSION_MODULE, source).program as CutoverAstNode;
  const admit = namedFunction(program, 'admitRuntimeOperations');
  if (admit === undefined) {
    return [
      {
        file: RUNTIME_ADMISSION_MODULE,
        line: 1,
        message: 'shared runtime admission must expose admitRuntimeOperations',
      },
    ];
  }
  const violations: UnruledViolation[] = [];
  for (const [helper, role] of [
    ['requireFactsInspection', 'facts inspection'],
    ['requireDeviceBinding', 'binding'],
  ] as const) {
    const calls = countNamedCalls(admit, helper);
    if (calls !== 1) {
      violations.push({
        file: RUNTIME_ADMISSION_MODULE,
        line: lineOf(source, admit),
        message: `shared runtime admission must make one ${role} call (found ${calls})`,
      });
    }
  }
  return violations;
}

/** Durable lifecycle evidence shared by the four descriptor rows. */
export function applicationLifecycleDurableResourceViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const violations: UnruledViolation[] = [];
  const gateway = sources.get('src/platform-runtime-gateway.ts');
  if (
    gateway === undefined ||
    !gateway.includes('runStartupRecoveryFence') ||
    gateway.includes('androidApplications') ||
    gateway.includes('appleApplications')
  ) {
    violations.push({
      file: 'src/platform-runtime-gateway.ts',
      line: 1,
      message:
        'the composed runtime gateway must register the startup fence and name no platform-specific durable owner',
    });
  }
  const resources = sources.get(APPLICATION_RESOURCES_FILE);
  if (
    resources === undefined ||
    resources.indexOf('hasTestImeRecoveryEvidence') < 0 ||
    resources.indexOf('hasTestImeRecoveryEvidence') > resources.indexOf('recoverTestImeStartup')
  ) {
    violations.push({
      file: APPLICATION_RESOURCES_FILE,
      line: 1,
      message:
        'durable startup recovery must gate lazy Android test-IME recovery behind its marker evidence',
    });
  }
  const ime = sources.get('packages/platform-android/src/ime-activation.ts');
  if (
    ime === undefined ||
    ime.indexOf('await waitForStartupRecoveryFence') < 0 ||
    ime.indexOf('await waitForStartupRecoveryFence') >
      ime.indexOf('const adb = resolveAndroidAdbExecutor')
  ) {
    violations.push({
      file: 'packages/platform-android/src/ime-activation.ts',
      line: 1,
      message:
        'Android test-IME mutation must wait for startup recovery before loading ADB mechanics',
    });
  }
  const captureKitUnavailable = sources.get(
    'packages/capture-kit/src/platform-runtime-unavailable.ts',
  );
  const captureKitIndex = sources.get('packages/capture-kit/src/index.ts');
  if (
    captureKitUnavailable !== undefined ||
    captureKitIndex?.includes('createUnavailablePlatformRuntime') === true
  ) {
    violations.push({
      file: 'packages/capture-kit/src/index.ts',
      line: 1,
      message: 'capture-kit must not own a generic platform-runtime lifecycle role',
    });
  }
  return violations;
}
