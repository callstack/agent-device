import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  recordLegacyRouteViolations,
  recordRuntimeNarrowingViolations,
  recordRuntimeRouteViolations,
} from './record-runtime-cutover-policy.ts';

test('R16 catches a planted legacy recording backend, admission, and plugin facet', () => {
  assert.deepEqual(
    recordLegacyRouteViolations([
      {
        path: 'src/daemon/handlers/planted.ts',
        source: `
          await resolveRecordingBackendForDevice(device).start(input);
          requireCommandSupported('record', device);
          requireCommandSupported(PUBLIC_COMMANDS.record, device);
          const backend = RECORDING_BACKENDS_BY_TAG.android;
          type LegacyTag = RecordingBackendTag;
        `,
      },
      {
        path: 'src/core/command-descriptor/registry.ts',
        source: `const commands = [{ name: 'record', capability: { apple: {} } }];`,
      },
      {
        path: 'src/platforms/apple/plugin.ts',
        source: `const plugin = { recording: { resolveBackendTag() {} } } satisfies PlatformPlugin;`,
      },
    ]),
    [
      'src/daemon/handlers/planted.ts: legacy recording route resolveRecordingBackendForDevice',
      'src/daemon/handlers/planted.ts: legacy record capability admission requireCommandSupported',
      'src/daemon/handlers/planted.ts: legacy record capability admission requireCommandSupported',
      'src/daemon/handlers/planted.ts: legacy recording backend map RECORDING_BACKENDS_BY_TAG',
      'src/daemon/handlers/planted.ts: legacy recording backend tag RecordingBackendTag',
      'src/core/command-descriptor/registry.ts: record descriptor retains legacy capability admission',
      'src/platforms/apple/plugin.ts: legacy PlatformPlugin recording facet',
    ],
  );
});

test('R16 excludes trace-only mechanics from the record cutover scan', () => {
  assert.deepEqual(
    recordLegacyRouteViolations([
      {
        path: 'src/daemon/handlers/record-trace.ts',
        source: `
          const traceRecording = { startTrace() {}, stopTrace() {} };
          traceRecording.startTrace();
        `,
      },
    ]),
    [],
  );
});

test('R16 preserves the one record-trace gateway while requiring exact recording operation routes', () => {
  assert.deepEqual(
    recordRuntimeRouteViolations([
      {
        path: 'src/daemon/handlers/session.ts',
        source: `
          handleRecordTraceCommands(input);
          runtime.operations.screenRecordingStart(input);
          runtime.operations.screenRecordingReattach(input);
          runtime.operations.screenRecordingCleanup(input);
        `,
      },
    ]),
    [],
  );
  assert.deepEqual(recordRuntimeRouteViolations([]), [
    '(record runtime): expected one handleRecordTraceCommands route, found 0',
    '(record runtime): expected one narrowed screenRecordingStart call, found 0',
    '(record runtime): expected one narrowed screenRecordingReattach call, found 0',
    '(record runtime): expected one narrowed screenRecordingCleanup call, found 0',
  ]);
});

test('R16 rejects the retired recording-provider scope while allowing the focused transport', () => {
  const violations = recordLegacyRouteViolations([
    {
      path: 'src/daemon/request-platform-providers.ts',
      source: `
        import type { RecordingProvider } from './recording-provider.ts';
        const recordingProvider = resolveRecordingProvider();
        await withRecordingProvider(undefined, task);
      `,
    },
    {
      path: 'src/platform-runtime-screen-recording-apple-transport.ts',
      source: `
        // recordingProvider and withRecordingProvider are retired prose.
        const prose = 'src/daemon/recording-provider.ts';
        withAppleSimulatorScreenRecordingTransport(transport, task);
      `,
    },
    {
      path: 'src/daemon/recording-provider.ts',
      source: `export const retired = true;`,
    },
    {
      path: 'src/daemon/dynamic-provider.ts',
      source: `
        const providers = { ['recordingProvider']: resolver };
        await import('./recording-provider.ts');
      `,
    },
  ]);
  assert.equal(violations.length, 8);
  assert.match(violations.join('\n'), /retired recording provider module/);
  assert.match(violations.join('\n'), /RecordingProvider/);
  assert.match(violations.join('\n'), /recordingProvider/);
  assert.match(violations.join('\n'), /resolveRecordingProvider/);
  assert.match(violations.join('\n'), /withRecordingProvider/);
});

test('R16 rejects proof repair for a narrowed screen-recording operation', () => {
  const violations = recordRuntimeNarrowingViolations([
    {
      path: 'src/daemon/handlers/planted.ts',
      source: `
        const widened = runtime as BoundDeviceRuntime<typeof use>;
        widened.operations.screenRecordingStart!({});
        widened.operations['screenRecordingReattach']({});
      `,
    },
  ]);
  assert.equal(violations.length, 3);
  assert.match(violations.join('\n'), /type assertion/);
  assert.match(violations.join('\n'), /non-null/);
  assert.match(violations.join('\n'), /bracketed/);
});
