import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRuntimeCommandCutover } from './runtime-command-cutover-policy.ts';
import { rowFor, sources, summariesFor } from './runtime-command-cutover-fixtures.ts';
import { cutoverTableDefects } from './runtime-command-cutover-model.ts';
import { MIGRATED_COMMAND_CUTOVERS } from './runtime-command-cutover-table.ts';
import { commandDescriptors } from '../../src/core/command-descriptor/registry.ts';

test('R20 boot rejects the superseded root readiness adapter', () => {
  assert.deepEqual(
    summariesFor('R20 boot-runtime-cutover', [
      ['src/platform-runtime-device-readiness-host.ts', 'export const adapter = {};'],
      [
        'src/daemon/handlers/session-state.ts',
        `
          function handleSessionStateCommands() {
            runtime.operations.bootTarget(input);
            runtime.operations.bootTargetHeadless(input);
          }
          handleSessionStateCommands(request);
        `,
      ],
    ]),
    ['src/platform-runtime-device-readiness-host.ts: retired device readiness module remains'],
  );
});

test('R20 boot operation singularity is scoped to the session-state handler', () => {
  assert.deepEqual(
    summariesFor('R20 boot-runtime-cutover', [
      [
        'src/daemon/handlers/session-state.ts',
        `
          function handleSessionStateCommands() {
            runtime.operations.bootTarget(input);
            runtime.operations.bootTargetHeadless(input);
          }
          function unrelatedShutdownHelper() { runtime.operations.bootTarget(input); }
          handleSessionStateCommands(request);
        `,
      ],
    ]),
    [],
  );
});

test('R32 snapshot rejects legacy admission and dispatcher projection', () => {
  assert.deepEqual(
    summariesFor('R32 snapshot-runtime-cutover', [
      [
        'src/core/command-descriptor/registry.ts',
        `
          const descriptors = [{
            name: 'snapshot',
            capability: { apple: {} },
            dispatch: {},
            platformExecution: { kind: 'device-runtime', use: snapshotCaptureUse },
          }];
        `,
      ],
      [
        'src/daemon/snapshot-runtime.ts',
        `
          function dispatchSnapshotViaRuntime(params) {
            requireCommandSupported('snapshot', device);
            return dispatchSnapshotRuntimeCommand({ ...params, command: 'snapshot' });
          }
          function handleSnapshotCommands() {
            dispatchSnapshotViaRuntime(request);
          }
          handleSnapshotCommands(request);
        `,
      ],
      [
        'src/daemon/snapshot-command-runtime.ts',
        `
          function dispatchSnapshotRuntimeCommand(params) {
            return resolveBoundSnapshotCaptureRuntime(params, params.command);
          }
        `,
      ],
      [
        'src/daemon/snapshot-runtime-binding.ts',
        `
          function selectActiveAppSnapshot() { runtime.operations.captureSnapshot(input); }
          function selectCustomActionsSnapshot() {
            runtime.operations.captureSnapshotWithCustomActions(input);
          }
          function selectSnapshotWithoutActiveApp() {
            runtime.operations.captureSnapshotWithoutActiveApp(input);
          }
          function resolveBoundSnapshotCaptureRuntime(params) {
            const plan = resolveSnapshotRuntimePlan(normalizedIntent);
            admitRuntimePlan({ device, plan, inspectFacts: params.inspectFacts });
            return bindSnapshotCaptureRuntime(params.bindDevice, device, plan);
          }
        `,
      ],
      ['src/core/dispatch.ts', 'function handleSnapshotCommand() { return legacy.snapshot(); }'],
      [
        'src/core/capabilities.ts',
        `
          const HARMONYOS_SUPPORTED_COMMANDS = new Set(['snapshot']);
          const WEB_SUPPORTED_COMMANDS = new Set(['snapshot']);
        `,
      ],
    ]),
    [
      'src/core/command-descriptor/registry.ts: snapshot descriptor retains legacy capability admission',
      'src/daemon/snapshot-runtime.ts: legacy snapshot capability admission requireCommandSupported',
      'src/core/dispatch.ts: legacy snapshot capture route handleSnapshotCommand',
      'src/core/capabilities.ts: static platform command set retains snapshot admission',
      'src/core/capabilities.ts: static platform command set retains snapshot admission',
      'src/core/command-descriptor/registry.ts: snapshot command still projects into the retired legacy dispatcher',
    ],
  );
});

// Per-row acceptance for migrated commands. Every older-row case here was carried over
// from the per-command policy tests these rows replaced; the mechanism itself is proven
// in runtime-command-cutover-policy.test.ts.

const DEVICES_HANDLER = [
  "import { listDeviceInventory as discoverInventory } from '../../core/dispatch-resolve.ts';",
  'export async function handleDevices(request: Request) { return await discoverInventory(request); }',
].join('\n');

const DEVICES_HANDLER_FILE = 'src/daemon/handlers/session-inventory.ts';

// ---------------------------------------------------------------------------
// devices (R13)
// ---------------------------------------------------------------------------

test('devices rejects an exact legacy inventory module path', () => {
  assert.deepEqual(
    summariesFor('R17 device-inventory-cutover', [
      [DEVICES_HANDLER_FILE, DEVICES_HANDLER],
      ['src/platforms/apple/devices.ts', 'export const staleInventoryRoute = true;'],
    ]),
    ['src/platforms/apple/devices.ts: retired device inventory module remains'],
  );
});

test('devices rejects executable legacy imports and identifiers', () => {
  const legacy = [
    "import { listAppleDevices } from './platforms/apple/devices.ts';",
    'export async function discover() { return await listAppleDevices(); }',
  ].join('\n');
  const found = summariesFor('R17 device-inventory-cutover', [
    [DEVICES_HANDLER_FILE, DEVICES_HANDLER],
    ['src/legacy-inventory.ts', legacy],
  ]).join('\n');

  assert.match(found, /imports retired device inventory module/);
  assert.match(found, /legacy device inventory route listAppleDevices/);
});

test('devices rejects dynamic imports and re-exports of legacy inventory modules', () => {
  for (const route of [
    "export const legacy = import('./platforms/apple/devices.ts');",
    "export { staleInventory } from './core/platform-inventory.ts';",
  ]) {
    assert.match(
      summariesFor('R17 device-inventory-cutover', [
        [DEVICES_HANDLER_FILE, DEVICES_HANDLER],
        ['src/legacy-inventory.ts', route],
      ]).join('\n'),
      /imports retired device inventory module/,
    );
  }
});

test('devices ignores comments, strings, and similarly named non-route modules', () => {
  const prose = [
    "const note = 'listAppleDevices from core/platform-inventory';",
    '// discoverDevices used to live in platforms/apple/devices.ts',
    'export const cacheKey = note;',
  ].join('\n');

  assert.deepEqual(
    summariesFor('R17 device-inventory-cutover', [
      [DEVICES_HANDLER_FILE, DEVICES_HANDLER],
      ['src/platforms/apple/devices-cache.ts', prose],
    ]),
    [],
  );
});

// ---------------------------------------------------------------------------
// logs (R14)
// ---------------------------------------------------------------------------

test('legacy logs scan catches a planted provider route and plugin facet', () => {
  assert.deepEqual(
    summariesFor('R14 logs-runtime-cutover', [
      [
        'src/daemon/planted.ts',
        'await withAppLogProvider(provider, task); await startAppLog(request); handleLogsCommand(params);',
      ],
      [
        'src/platforms/planted/plugin.ts',
        'export const plugin = { appLog: { resolveBackend() {} } } satisfies PlatformPlugin;',
      ],
    ]),
    [
      'src/daemon/planted.ts: legacy logs route withAppLogProvider',
      'src/daemon/planted.ts: legacy logs route startAppLog',
      'src/platforms/planted/plugin.ts: legacy PlatformPlugin appLog facet',
    ],
  );
});

test('legacy logs scan ignores retired names in comments and string data', () => {
  assert.deepEqual(
    summariesFor('R14 logs-runtime-cutover', [
      [
        'src/daemon/planted.ts',
        `
          // AppLogProvider and startAppLog were removed.
          const migrationNote = 'withAppLogProvider and requireCommandSupported("logs")';
          const metadata = { note: 'appLogProvider' };
          handleLogsCommand(params);
        `,
      ],
      ['src/platforms/apple/plugin.ts', `const note = 'PUBLIC_COMMANDS.logs';`],
    ]),
    [],
  );
});

test('legacy logs scan retains type-import and computed executable route coverage', () => {
  assert.deepEqual(
    summariesFor('R14 logs-runtime-cutover', [
      [
        'src/daemon/planted.ts',
        `
          import type { AppLogProvider as LegacyProvider } from './old-app-log.ts';
          const route = handlers['startAppLog'];
          handleLogsCommand(params);
        `,
      ],
    ]),
    [
      'src/daemon/planted.ts: legacy logs route AppLogProvider',
      'src/daemon/planted.ts: legacy logs route startAppLog',
    ],
  );
});

test('legacy logs scan catches planted capability and dual-admission routes', () => {
  assert.deepEqual(
    summariesFor('R14 logs-runtime-cutover', [
      [
        'src/core/command-descriptor/registry.ts',
        `
        const registry = [
          { name: 'logs', capability: { apple: {} }, platformExecution: runtime },
          { name: 'events', capability: { apple: {} } },
        ];
      `,
      ],
      [
        'src/daemon/handlers/planted.ts',
        `
        const literal = requireCommandSupported('logs', device);
        const symbolic = requireCommandSupported(PUBLIC_COMMANDS.logs, device);
        handleLogsCommand(params);
      `,
      ],
      [
        'src/platforms/apple/plugin.ts',
        `const supports = { [PUBLIC_COMMANDS.logs]: supportsCoreDevice };`,
      ],
      [
        'src/core/capabilities.ts',
        `const HARMONYOS_SUPPORTED_COMMANDS = new Set(['open', 'logs']);`,
      ],
    ]),
    [
      'src/core/command-descriptor/registry.ts: logs descriptor retains legacy capability admission',
      'src/daemon/handlers/planted.ts: legacy logs capability admission requireCommandSupported',
      'src/daemon/handlers/planted.ts: legacy logs capability admission requireCommandSupported',
      'src/platforms/apple/plugin.ts: Apple plugin retains legacy logs support or hint closure',
      'src/core/capabilities.ts: static platform command set retains logs admission',
    ],
  );
});

test('legacy logs scan follows declaration roles after files move', () => {
  assert.deepEqual(
    summariesFor('R14 logs-runtime-cutover', [
      [
        'src/moved/command-declarations.ts',
        `const descriptor = { name: 'logs', capability: { apple: {} } };`,
      ],
      [
        'src/moved/platform-contract.ts',
        `export type PlatformPlugin = { readonly appLog?: { inspect(): void } };`,
      ],
      [
        'src/moved/apple-family.ts',
        `const plugin = { appLog: { inspect() {} } } as const satisfies PlatformPlugin;`,
      ],
      ['src/moved/typed-plugin.ts', `const plugin: PlatformPlugin = { appLog: { inspect() {} } };`],
      ['src/moved/capability-data.ts', `const HARMONYOS_SUPPORTED_COMMANDS = new Set(['logs']);`],
      ['src/daemon/logs-route.ts', 'handleLogsCommand(params);'],
    ]),
    [
      'src/moved/command-declarations.ts: logs descriptor retains legacy capability admission',
      'src/moved/platform-contract.ts: legacy PlatformPlugin appLog facet',
      'src/moved/apple-family.ts: legacy PlatformPlugin appLog facet',
      'src/moved/typed-plugin.ts: legacy PlatformPlugin appLog facet',
      'src/moved/capability-data.ts: static platform command set retains logs admission',
    ],
  );
});

test('R14 violations retain their exact source line', () => {
  const [violation] = checkRuntimeCommandCutover(
    sources([
      [
        'src/daemon/moved-handler.ts',
        `
        const note = 'reason: retained';
        const widened = runtime as BoundDeviceRuntime<typeof use>;
      `,
      ],
    ]),
    [rowFor('logs')],
  );

  assert.deepEqual(violation, {
    rule: 'R14 logs-runtime-cutover',
    file: 'src/daemon/moved-handler.ts',
    line: 3,
    message: 'widened logs runtime type assertion',
  });
});

test('logs narrowing scan catches planted assertions, non-null repair, and bracket access', () => {
  const found = summariesFor('R14 logs-runtime-cutover', [
    [
      'src/daemon/handlers/planted.ts',
      `
        const widened = runtime as BoundDeviceRuntime<typeof use>;
        widened.operations.appLogStart!({});
        widened.operations['appLogDoctor']({});
        handleLogsCommand(params);
      `,
    ],
  ]);

  assert.equal(found.length, 3);
  assert.match(found.join('\n'), /widened logs runtime type assertion/);
  assert.match(found.join('\n'), /non-null repair of a narrowed logs operation/);
  assert.match(found.join('\n'), /bracketed logs operation access/);
});

test('logs keeps the broader non-null scan over every daemon runtime operation', () => {
  assert.deepEqual(
    summariesFor('R14 logs-runtime-cutover', [
      [
        'src/daemon/handlers/planted.ts',
        'runtime.operations.somethingElse!({}); handleLogsCommand(params);',
      ],
    ]),
    ['src/daemon/handlers/planted.ts: non-null repair of a narrowed logs operation'],
  );
});

// ---------------------------------------------------------------------------
// network (R15)
// ---------------------------------------------------------------------------

test('network cutover scan catches planted legacy execution and dual admission', () => {
  assert.deepEqual(
    summariesFor('R15 network-runtime-cutover', [
      [
        'src/daemon/handlers/planted.ts',
        `
          await readSessionNetworkCapture(input);
          await provider.dumpNetwork({ include: 'all' });
          requireCommandSupported('network', device);
          function handleNetworkCommand() { runtime.operations.networkDump(input); }
          handleNetworkCommand(request);
        `,
      ],
      [
        'src/core/command-descriptor/registry.ts',
        `const commands = [{ name: 'network', capability: { apple: {} } }];`,
      ],
      ['src/core/capabilities.ts', `const WEB_QUERY_COMMANDS = ['find', 'network'];`],
      [
        'src/platforms/apple/plugin.ts',
        `const supports = { [PUBLIC_COMMANDS.network]: supportsDevice };`,
      ],
    ]),
    [
      'src/daemon/handlers/planted.ts: legacy network route readSessionNetworkCapture',
      'src/daemon/handlers/planted.ts: daemon invokes legacy provider method dumpNetwork',
      'src/daemon/handlers/planted.ts: legacy network capability admission requireCommandSupported',
      'src/core/command-descriptor/registry.ts: network descriptor retains legacy capability admission',
      'src/core/capabilities.ts: static platform command set retains network admission',
      'src/platforms/apple/plugin.ts: Apple plugin retains legacy network support or hint closure',
    ],
  );
});

test('network cutover scan rejects a retired implementation by committed path', () => {
  assert.deepEqual(
    summariesFor('R15 network-runtime-cutover', [
      ['src/daemon/network-log.ts', `export const parser = () => [];`],
      [
        'src/daemon/handlers/ok.ts',
        'function handleNetworkCommand() { runtime.operations.networkDump(i); } handleNetworkCommand(r);',
      ],
    ]),
    ['src/daemon/network-log.ts: retired network module remains'],
  );
});

test('network cutover scan ignores retired names in comments and string data', () => {
  assert.deepEqual(
    summariesFor('R15 network-runtime-cutover', [
      [
        'src/daemon/planted.ts',
        `
          // readSessionNetworkCapture and requireCommandSupported('network') were removed.
          const note = 'provider.dumpNetwork and PUBLIC_COMMANDS.network';
          function handleNetworkCommand() { runtime.operations.networkDump(input); }
          handleNetworkCommand(request);
        `,
      ],
    ]),
    [],
  );
});

test('network narrowing scan catches planted casts, non-null repair, and bracket access', () => {
  const found = summariesFor('R15 network-runtime-cutover', [
    [
      'src/daemon/handlers/planted.ts',
      `
        const widened = runtime as BoundDeviceRuntime<typeof use>;
        widened.operations.networkDump!({});
        widened.operations['networkDump']({});
      `,
    ],
  ]);
  const messages = found.join('\n');
  assert.match(messages, /widened network runtime type assertion/);
  assert.match(messages, /non-null repair of a narrowed network operation/);
  assert.match(messages, /bracketed network operation access/);
});

test('network route scan rejects planted neither and duplicate routes', () => {
  assert.deepEqual(summariesFor('R15 network-runtime-cutover', []), [
    '(network runtime): expected one handleNetworkCommand route, found 0',
    '(network runtime): expected one narrowed networkDump call, found 0',
  ]);
  assert.deepEqual(
    summariesFor('R15 network-runtime-cutover', [
      [
        'src/daemon/planted.ts',
        `
          function handleNetworkCommand() {
            runtime.operations.networkDump(input);
            fallback.operations.networkDump(input);
          }
          handleNetworkCommand(first);
          handleNetworkCommand(second);
        `,
      ],
    ]),
    [
      '(network runtime): expected one handleNetworkCommand route, found 2',
      '(network runtime): expected one narrowed networkDump call, found 2',
    ],
  );
});

// ---------------------------------------------------------------------------
// record (R16)
// ---------------------------------------------------------------------------

test('R16 catches a planted legacy recording backend, admission, and plugin facet', () => {
  assert.deepEqual(
    summariesFor('R16 record-runtime-cutover', [
      [
        'src/daemon/handlers/planted.ts',
        `
          await resolveRecordingBackendForDevice(device).start(input);
          requireCommandSupported('record', device);
          requireCommandSupported(PUBLIC_COMMANDS.record, device);
          const backend = RECORDING_BACKENDS_BY_TAG.android;
          type LegacyTag = RecordingBackendTag;
          function startRecording() { runtime.operations.screenRecordingStart(input); }
          function createScreenRecordingRecoveryControl() {
            runtime.operations.screenRecordingReattach(input);
            runtime.operations.screenRecordingCleanup(input);
          }
          handleRecordTraceCommands(input);
        `,
      ],
      [
        'src/core/command-descriptor/registry.ts',
        `const commands = [{ name: 'record', capability: { apple: {} } }];`,
      ],
      [
        'src/platforms/apple/plugin.ts',
        `const plugin = { recording: { resolveBackendTag() {} } } satisfies PlatformPlugin;`,
      ],
    ]),
    [
      'src/daemon/handlers/planted.ts: legacy recording route resolveRecordingBackendForDevice',
      'src/daemon/handlers/planted.ts: legacy recording route RECORDING_BACKENDS_BY_TAG',
      'src/daemon/handlers/planted.ts: legacy recording route RecordingBackendTag',
      'src/daemon/handlers/planted.ts: legacy record capability admission requireCommandSupported',
      'src/daemon/handlers/planted.ts: legacy record capability admission requireCommandSupported',
      'src/core/command-descriptor/registry.ts: record descriptor retains legacy capability admission',
      'src/platforms/apple/plugin.ts: legacy PlatformPlugin recording facet',
    ],
  );
});

test('R16 excludes trace-only mechanics from the record cutover scan', () => {
  assert.deepEqual(
    summariesFor('R16 record-runtime-cutover', [
      [
        'src/daemon/handlers/record-trace.ts',
        `
          const traceRecording = { startTrace() {}, stopTrace() {} };
          traceRecording.startTrace();
          function startRecording() { runtime.operations.screenRecordingStart(input); }
          function createScreenRecordingRecoveryControl() {
            runtime.operations.screenRecordingReattach(input);
            runtime.operations.screenRecordingCleanup(input);
          }
          handleRecordTraceCommands(input);
        `,
      ],
    ]),
    [],
  );
});

test('R16 rejects the retired recording-provider scope while allowing the focused transport', () => {
  const found = summariesFor('R16 record-runtime-cutover', [
    [
      'src/daemon/request-platform-providers.ts',
      `
        import type { RecordingProvider } from './recording-provider.ts';
        const recordingProvider = resolveRecordingProvider();
        await withRecordingProvider(undefined, task);
      `,
    ],
    [
      'src/platform-runtime-screen-recording-apple-transport.ts',
      `
        // recordingProvider and withRecordingProvider are retired prose.
        const prose = 'src/daemon/recording-provider.ts';
        withAppleSimulatorScreenRecordingTransport(transport, task);
      `,
    ],
    ['src/daemon/recording-provider.ts', `export const retired = true;`],
    [
      'src/daemon/dynamic-provider.ts',
      `
        const providers = { ['recordingProvider']: resolver };
        await import('./recording-provider.ts');
      `,
    ],
  ]);
  const messages = found.join('\n');
  assert.match(messages, /retired recording module remains/);
  assert.match(messages, /imports retired recording module/);
  assert.match(messages, /legacy recording route RecordingProvider/);
  assert.match(messages, /legacy recording route recordingProvider/);
  assert.match(messages, /legacy recording route resolveRecordingProvider/);
  assert.match(messages, /legacy recording route withRecordingProvider/);
  assert.doesNotMatch(
    messages,
    /src\/platform-runtime-screen-recording-apple-transport\.ts/,
    'prose in the focused transport must stay allowed',
  );
});

test('R16 rejects proof repair for a narrowed screen-recording operation', () => {
  const found = summariesFor('R16 record-runtime-cutover', [
    [
      'src/daemon/handlers/planted.ts',
      `
        const widened = runtime as BoundDeviceRuntime<typeof use>;
        widened.operations.screenRecordingStart!({});
        widened.operations['screenRecordingReattach']({});
      `,
    ],
  ]);
  const messages = found.join('\n');
  assert.match(messages, /widened recording runtime type assertion/);
  assert.match(messages, /non-null repair of a narrowed recording operation/);
  assert.match(messages, /bracketed recording operation access/);
});

// The four lifecycle descriptors are independent migration units: each carries its own durable
// row rather than inheriting a sibling's proof.
test('the four application-lifecycle descriptors each carry an independent durable cutover row', () => {
  const rows = ['open', 'prepare', 'close', 'runtime'].map(rowFor);
  assert.deepEqual(
    rows.map(({ tier, execution }) => ({ tier, execution })),
    [
      { tier: 'durable-resource', execution: 'device-runtime' },
      { tier: 'durable-resource', execution: 'device-runtime' },
      { tier: 'durable-resource', execution: 'device-runtime' },
      { tier: 'durable-resource', execution: 'device-runtime' },
    ],
  );
  assert.deepEqual(
    rows.flatMap((row) => (row.lifecycleProof === undefined ? [row.command] : [])),
    [],
  );
});

// A row id names a heading in the layering report, so a sibling stack claiming the same id would
// silently merge two commands' violations.
test('the cutover table rejects a duplicate rule id', () => {
  const [first] = MIGRATED_COMMAND_CUTOVERS;
  assert.ok(first);
  assert.deepEqual(cutoverTableDefects(MIGRATED_COMMAND_CUTOVERS), []);
  assert.match(
    cutoverTableDefects([first, { ...first, command: 'planted' }]).join('\n'),
    /rule id .* is claimed by/,
  );
});

test('every daemon-routed migrated descriptor has exactly one cutover row', () => {
  const migratedDescriptors = commandDescriptors
    .filter(
      (descriptor) =>
        descriptor.daemon !== undefined &&
        (descriptor.platformExecution.kind === 'inventory' ||
          descriptor.platformExecution.kind === 'host' ||
          descriptor.platformExecution.kind === 'device-runtime'),
    )
    .map(({ name }) => name)
    .sort();
  const tableCommands = MIGRATED_COMMAND_CUTOVERS.map(({ command }) => command).sort();

  assert.deepEqual(tableCommands, migratedDescriptors);
});
