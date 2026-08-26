import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appStateLegacySessionHandlerViolations,
  applicationLifecycleDurableResourceViolations,
  appLogSessionStateOwnershipViolations,
  closeLifecycleRouteBindingViolations,
  devicesGatewayBindingViolations,
  openLifecycleRouteBindingViolations,
  perfCaptureSessionStateOwnershipViolations,
  prepareLifecycleRouteBindingViolations,
  runtimeLifecycleRouteBindingViolations,
  sourceExecutedUsingDeclarationViolations,
} from './runtime-command-cutover-extensions.ts';

const HANDLER_FILE = 'src/daemon/handlers/session-inventory.ts';

function handlerSource(localName = 'listDeviceInventory'): string {
  return [
    `import { listDeviceInventory as ${localName} } from '../../core/dispatch-resolve.ts';`,
    `export async function handleDevices(request: Request) { return await ${localName}(request); }`,
  ].join('\n');
}

function sources(entries: readonly (readonly [string, string])[]): ReadonlyMap<string, string> {
  return new Map(entries);
}

function summaries(violations: readonly Readonly<{ file: string; message: string }>[]): string[] {
  return violations.map(({ file, message }) => `${file}: ${message}`);
}

test('devices keeps one gateway-owned handler route through an aliased import', () => {
  assert.deepEqual(
    devicesGatewayBindingViolations(sources([[HANDLER_FILE, handlerSource('discoverInventory')]])),
    [],
  );
});

test('devices rejects a missing handler module', () => {
  assert.match(
    summaries(devicesGatewayBindingViolations(sources([]))).join('\n'),
    /gateway-owned handler module is missing/,
  );
});

test('devices rejects a handler that imports but never calls the inventory gateway', () => {
  const handler = [
    "import { listDeviceInventory } from '../../core/dispatch-resolve.ts';",
    'export async function handleDevices() { return []; }',
  ].join('\n');

  assert.match(
    summaries(devicesGatewayBindingViolations(sources([[HANDLER_FILE, handler]]))).join('\n'),
    /must call its imported listDeviceInventory binding/,
  );
});

test('devices rejects a handler that never imports the inventory gateway', () => {
  assert.match(
    summaries(
      devicesGatewayBindingViolations(
        sources([[HANDLER_FILE, 'export const handleDevices = () => [];']]),
      ),
    ).join('\n'),
    /must import listDeviceInventory from the neutral inventory owner/,
  );
});

test('devices does not accept a call through a binding that shadows the imported alias', () => {
  const handler = [
    "import { listDeviceInventory as discoverInventory } from '../../core/dispatch-resolve.ts';",
    'export async function decoy(discoverInventory: (request: Request) => Promise<unknown>) {',
    '  return await discoverInventory({});',
    '}',
  ].join('\n');

  assert.match(
    summaries(devicesGatewayBindingViolations(sources([[HANDLER_FILE, handler]]))).join('\n'),
    /shadows its imported listDeviceInventory binding/,
  );
});

test('session state scan catches planted app-log record construction outside its owner', () => {
  assert.deepEqual(
    summaries(
      appLogSessionStateOwnershipViolations(
        sources([
          [
            'src/daemon/handlers/planted.ts',
            `sessionStore.set(name, { ...session, appLog: resource, appLogFailure: undefined });`,
          ],
          [
            'src/daemon/request-platform-providers.ts',
            `
          type Scope = { appLog: { provider?: AppLogProvider } };
          const scope = { appLog: { provider } };
        `,
          ],
          [
            'src/daemon/app-log-session-resource.ts',
            `sessionStore.set(name, { ...session, appLog: resource });`,
          ],
          [
            'src/daemon/session-teardown.ts',
            `teardownSessionResources({ appLog: 'run' }); teardownSessionResources({ appLog: 'already-settled' });`,
          ],
          [
            'src/daemon/handlers/invalid-teardown.ts',
            `teardownSessionResources({ appLog: 'skip' });`,
          ],
        ]),
      ),
    ),
    [
      'src/daemon/handlers/planted.ts: session appLog record constructed outside its owner',
      'src/daemon/handlers/planted.ts: session appLogFailure record constructed outside its owner',
      'src/daemon/request-platform-providers.ts: session appLog record constructed outside its owner',
      'src/daemon/handlers/invalid-teardown.ts: session appLog record constructed outside its owner',
    ],
  );
});

test('session state scan catches planted perf capture construction outside its owner', () => {
  assert.deepEqual(
    summaries(
      perfCaptureSessionStateOwnershipViolations(
        sources([
          [
            'src/daemon/handlers/planted.ts',
            `sessionStore.set(name, { ...session, perfCapture: resource });`,
          ],
          [
            'src/daemon/perf-capture-session-resource.ts',
            `sessionStore.set(name, { ...session, perfCapture: resource });`,
          ],
        ]),
      ),
    ),
    ['src/daemon/handlers/planted.ts: session perfCapture record constructed outside its owner'],
  );
});

test('source-executed syntax scan rejects using declarations but ignores prose', () => {
  assert.deepEqual(
    summaries(
      sourceExecutedUsingDeclarationViolations(
        sources([
          [
            'packages/platform-apple/src/logs/planted.ts',
            `
          // await using oldHandle = acquire();
          const migrationNote = 'using replacement = acquire()';
          async function run() { await using handle = acquire(); }
          function runSync() { using cleanup = acquireSync(); }
        `,
          ],
        ]),
      ),
    ),
    [
      'packages/platform-apple/src/logs/planted.ts: source-executed TypeScript uses unsupported await using declaration',
      'packages/platform-apple/src/logs/planted.ts: source-executed TypeScript uses unsupported using declaration',
    ],
  );
});

test('appstate handler rejects legacy platform imports and calls', () => {
  const handler = [
    "import { getAndroidAppState } from '../../platforms/android/app-lifecycle.ts';",
    "import { getHarmonyAppState } from '../../platforms/harmonyos/app-lifecycle.ts';",
    'export async function handleSessionStateCommands() {',
    '  await getAndroidAppState();',
    '  return await getHarmonyAppState();',
    '}',
  ].join('\n');

  assert.deepEqual(
    summaries(
      appStateLegacySessionHandlerViolations(
        sources([['src/daemon/handlers/session-state.ts', handler]]),
      ),
    ),
    [
      'src/daemon/handlers/session-state.ts: appstate handler imports a legacy platform app-state module',
      'src/daemon/handlers/session-state.ts: appstate handler imports a legacy platform app-state module',
      'src/daemon/handlers/session-state.ts: appstate handler calls a legacy platform app-state backend',
      'src/daemon/handlers/session-state.ts: appstate handler calls a legacy platform app-state backend',
    ],
  );
});

test('appstate handler is green after legacy dispatch is removed', () => {
  assert.deepEqual(
    appStateLegacySessionHandlerViolations(
      sources([
        ['src/daemon/handlers/session-state.ts', 'export const handler = () => undefined;'],
      ]),
    ),
    [],
  );
});

const OPEN_HANDLER_FILE = 'src/daemon/handlers/session-open.ts';
const PREPARE_HANDLER_FILE = 'src/daemon/handlers/session-prepare.ts';
const CLOSE_HANDLER_FILE = 'src/daemon/handlers/session-close-runtime-admission.ts';
const RUNTIME_HANDLER_FILE = 'src/daemon/handlers/session-runtime-command.ts';
const PORT_REVERSE_HANDLER_FILE = 'src/daemon/handlers/session-runtime-port-reverse.ts';
const COMMAND_DESCRIPTOR_FILE = 'src/core/command-descriptor/registry.ts';

const RUNTIME_ADMISSION_FILE = 'src/daemon/runtime-admission.ts';

const RUNTIME_ADMISSION_SOURCE = [
  'export async function admitRuntimeOperations(request: any) {',
  '  const facts = await requireFactsInspection(request.inspectFacts)(request.device);',
  '  if (!facts.ok) return { type: "response" };',
  '  return { type: "admitted", bind: requireDeviceBinding(request.bindDevice) };',
  '}',
].join('\n');

function lifecycleAdmissionSource(functionName: string, admissionHelper: string): string {
  return [
    `async function ${functionName}(params: any) {`,
    `  return await ${admissionHelper}({ ...params, command: 'x', use: params.use });`,
    '}',
  ].join('\n');
}

function lifecycleSources(entries: readonly (readonly [string, string])[]) {
  return sources([
    [
      COMMAND_DESCRIPTOR_FILE,
      "export const descriptors = [{ name: 'close', platformExecution: { kind: 'device-runtime' } }];",
    ],
    ...entries,
    [RUNTIME_ADMISSION_FILE, RUNTIME_ADMISSION_SOURCE],
  ]);
}

test('lifecycle route proofs accept one shared admission per descriptor operation', () => {
  assert.deepEqual(
    openLifecycleRouteBindingViolations(
      lifecycleSources([
        [OPEN_HANDLER_FILE, lifecycleAdmissionSource('admitOpenRuntime', 'admitRuntimeOperations')],
      ]),
    ),
    [],
  );
  assert.deepEqual(
    prepareLifecycleRouteBindingViolations(
      lifecycleSources([
        [PREPARE_HANDLER_FILE, lifecycleAdmissionSource('admitPrepareRuntime', 'admitRuntimeUse')],
      ]),
    ),
    [],
  );
  assert.deepEqual(
    closeLifecycleRouteBindingViolations(
      lifecycleSources([
        [CLOSE_HANDLER_FILE, lifecycleAdmissionSource('admitCloseRuntime', 'admitRuntimeUse')],
      ]),
    ),
    [],
  );
  assert.deepEqual(
    runtimeLifecycleRouteBindingViolations(
      lifecycleSources([
        [RUNTIME_HANDLER_FILE, lifecycleAdmissionSource('admitClearRuntime', 'admitRuntimeUse')],
        [
          PORT_REVERSE_HANDLER_FILE,
          lifecycleAdmissionSource('handlePortReverseCommand', 'admitRuntimeUse'),
        ],
      ]),
    ),
    [],
  );
});

test('planted red: lifecycle route proof rejects a duplicate admission and legacy local dispatch', () => {
  const violations = openLifecycleRouteBindingViolations(
    lifecycleSources([
      [
        OPEN_HANDLER_FILE,
        [
          'async function admitOpenRuntime(params: any) {',
          '  await admitRuntimeOperations(params);',
          '  return await admitRuntimeOperations(params);',
          '}',
          'async function accidentalLegacyRoute() { await dispatchCommand(); }',
        ].join('\n'),
      ],
    ]),
  );

  assert.match(
    summaries(violations).join('\n'),
    /admitOpenRuntime must make one shared runtime admission call \(found 2\)/,
  );
  assert.match(
    summaries(violations).join('\n'),
    /handler reaches legacy or local platform call dispatchCommand outside its bound runtime/,
  );
});

test('planted red: lifecycle route proof rejects a handler that calls the raw gateway ports', () => {
  const violations = closeLifecycleRouteBindingViolations(
    lifecycleSources([
      [
        CLOSE_HANDLER_FILE,
        [
          'async function admitCloseRuntime(params: any) {',
          '  return await admitRuntimeUse(params);',
          '}',
          'async function sneak(params: any) {',
          '  const facts = await inspectFacts(params.device);',
          '  return await bindDevice(params.device, facts);',
          '}',
        ].join('\n'),
      ],
    ]),
  );

  assert.match(summaries(violations).join('\n'), /platform call inspectFacts outside its bound/);
  assert.match(summaries(violations).join('\n'), /platform call bindDevice outside its bound/);
});

test('planted red: close cutover rejects a legacy dispatch projection', () => {
  const violations = closeLifecycleRouteBindingViolations(
    lifecycleSources([
      [CLOSE_HANDLER_FILE, lifecycleAdmissionSource('admitCloseRuntime', 'admitRuntimeUse')],
      [
        COMMAND_DESCRIPTOR_FILE,
        "export const descriptors = [{ name: 'close', dispatch: {}, platformExecution: { kind: 'device-runtime' } }];",
      ],
    ]),
  );

  assert.match(
    summaries(violations).join('\n'),
    /still projects into the retired legacy dispatcher/,
  );
});

test('planted red: lifecycle route proof rejects a shared admission with two facts inspections', () => {
  const violations = openLifecycleRouteBindingViolations(
    sources([
      [OPEN_HANDLER_FILE, lifecycleAdmissionSource('admitOpenRuntime', 'admitRuntimeOperations')],
      [
        RUNTIME_ADMISSION_FILE,
        [
          'export async function admitRuntimeOperations(request: any) {',
          '  await requireFactsInspection(request.inspectFacts)(request.device);',
          '  await requireFactsInspection(request.inspectFacts)(request.device);',
          '  return { type: "admitted", bind: requireDeviceBinding(request.bindDevice) };',
          '}',
        ].join('\n'),
      ],
    ]),
  );

  assert.match(
    summaries(violations).join('\n'),
    /shared runtime admission must make one facts inspection call \(found 2\)/,
  );
});

const APPLICATION_RESOURCES_FILE = 'src/platform-runtime-application-resources.ts';

test('lifecycle durable proof rejects a generic capture-kit lifecycle role and an unfenced IME mutation', () => {
  const violations = applicationLifecycleDurableResourceViolations(
    sources([
      ['src/platform-runtime-gateway.ts', 'runStartupRecoveryFence();'],
      [
        APPLICATION_RESOURCES_FILE,
        'hasTestImeRecoveryEvidence(input.stateDir); recoverTestImeStartup(input);',
      ],
      [
        'packages/platform-android/src/ime-activation.ts',
        'const adb = resolveAndroidAdbExecutor(device);',
      ],
      [
        'packages/capture-kit/src/platform-runtime-unavailable.ts',
        'const lifecycle = Object.freeze({ ...network });',
      ],
    ]),
  );

  assert.match(summaries(violations).join('\n'), /must wait for startup recovery/);
  assert.match(
    summaries(violations).join('\n'),
    /must not own a generic platform-runtime lifecycle role/,
  );
});

test('planted red: lifecycle durable proof rejects a gateway that names a platform durable owner', () => {
  const violations = applicationLifecycleDurableResourceViolations(
    sources([
      [
        'src/platform-runtime-gateway.ts',
        'runStartupRecoveryFence(); host.androidApplications.recoverTestImeStartup(input);',
      ],
      [
        APPLICATION_RESOURCES_FILE,
        'hasTestImeRecoveryEvidence(input.stateDir); recoverTestImeStartup(input);',
      ],
      [
        'packages/platform-android/src/ime-activation.ts',
        'await waitForStartupRecoveryFence(options.stateDir); const adb = resolveAndroidAdbExecutor(device);',
      ],
    ]),
  );

  assert.match(summaries(violations).join('\n'), /name no platform-specific durable owner/);
});

test('planted red: lifecycle durable proof rejects unevidenced Android startup recovery', () => {
  const violations = applicationLifecycleDurableResourceViolations(
    sources([
      ['src/platform-runtime-gateway.ts', 'runStartupRecoveryFence();'],
      [APPLICATION_RESOURCES_FILE, 'recoverTestImeStartup(input);'],
      [
        'packages/platform-android/src/ime-activation.ts',
        'await waitForStartupRecoveryFence(options.stateDir); const adb = resolveAndroidAdbExecutor(device);',
      ],
    ]),
  );

  assert.match(summaries(violations).join('\n'), /gate lazy Android test-IME recovery/);
});
