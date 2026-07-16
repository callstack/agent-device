import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { ANDROID_EMULATOR } from '../../../__tests__/test-utils/index.ts';
import { buildGesturePlan } from '../../../contracts/gesture-plan.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import {
  withAndroidAdbProvider,
  type AndroidAdbExecutor,
  type AndroidAdbProcess,
  type AndroidAdbProvider,
} from '../adb-executor.ts';
import {
  captureAndroidSnapshotWithHelperSession,
  getAndroidSnapshotHelperSessionDeviceKey,
  resetAndroidSnapshotHelperSessions,
} from '../snapshot-helper-session.ts';
import type { AndroidTouchPlan } from '../touch-plan.ts';
import {
  ANDROID_TOUCH_PLAN_PROTOCOL,
  executeAndroidTouchHelperPlan,
  normalizeAndroidTouchHelperGestureRequest,
  readAndroidTouchHelperFinalRecord,
  readAndroidTouchHelperViewport,
} from '../touch-helper.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../__tests__/test-utils/android-snapshot-helper.ts';
import {
  ANDROID_TOUCH_HELPER_MANIFEST as manifest,
  androidTouchHelperResultRecord as resultRecord,
} from './touch-helper.fixtures.ts';

vi.mock('../helper-package-install.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../helper-package-install.ts')>();
  return {
    ...actual,
    resolveAndroidHelperArtifact: vi.fn(async () => ({
      apkPath: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.apkPath,
      manifest: {
        ...manifest,
        sha256: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest.sha256,
      },
    })),
  };
});

const viewport = { x: 0, y: 0, width: 400, height: 800 };
let deviceSequence = 0;

beforeEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

function makeIsolatedDevice(): DeviceInfo {
  deviceSequence += 1;
  return { ...ANDROID_EMULATOR, id: `emulator-touch-helper-${deviceSequence}` };
}

function longPressPlan(durationMs = 120_000): AndroidTouchPlan {
  const point = { x: 20, y: 30 };
  return {
    topology: 'single',
    intent: 'longPress',
    durationMs,
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point },
          { offsetMs: durationMs, point },
        ],
      },
    ],
  };
}

function flingPlan() {
  return buildGesturePlan(
    { intent: 'fling', from: { x: 300, y: 400 }, to: { x: 100, y: 400 } },
    viewport,
  );
}

// Wraps an executor that answers the shared install-decision probe as "already
// current" (a much newer installed versionCode) so tests can focus on the
// gesture/viewport call that follows without also faking an install flow.
function currentVersionAdb(handleInstrument: AndroidAdbExecutor): AndroidAdbExecutor {
  return async (args, options) => {
    if (args.includes('--show-versioncode')) {
      return {
        exitCode: 0,
        stdout: `package:${manifest.packageName} versionCode:999999`,
        stderr: '',
      };
    }
    return handleInstrument(args, options);
  };
}

test('single-pointer plans normalize to a swipe request', () => {
  const request = normalizeAndroidTouchHelperGestureRequest(flingPlan());
  assert.equal(request.kind, 'swipe');
  assert.equal(request.pointers.length, 1);
  assert.equal(request.durationMs, 100);
});

test('dual-pointer plans normalize to a transform request and preserve exact samples', () => {
  const pan = buildGesturePlan(
    {
      intent: 'pan',
      pointerCount: 2,
      origin: { x: 200, y: 300 },
      delta: { x: 20, y: 10 },
      durationMs: 32,
    },
    viewport,
  );
  const request = normalizeAndroidTouchHelperGestureRequest(pan);

  assert.equal(request.kind, 'transform');
  assert.equal(request.durationMs, 32);
  assert.deepEqual(
    request.pointers,
    pan.pointers.map((pointer) => ({
      pointerId: pointer.pointerId,
      samples: pointer.samples.map(({ offsetMs, point }) => ({ offsetMs, x: point.x, y: point.y })),
    })),
  );
});

test('long press lowers to a stationary single-pointer helper request', () => {
  const request = normalizeAndroidTouchHelperGestureRequest(longPressPlan());
  assert.equal(request.kind, 'swipe');
  assert.equal(request.durationMs, 120_000);
  assert.deepEqual(request.pointers[0]?.samples, [
    { offsetMs: 0, x: 20, y: 30 },
    { offsetMs: 120_000, x: 20, y: 30 },
  ]);
});

test('readAndroidTouchHelperFinalRecord extracts the snapshot-helper protocol record', () => {
  const record = readAndroidTouchHelperFinalRecord(
    [
      resultRecord({
        ok: 'true',
        kind: 'transform',
        helperApiVersion: '1',
        injectedEvents: '24',
        elapsedMs: '315',
      }),
      'INSTRUMENTATION_CODE: 0',
    ].join('\n'),
  );
  assert.equal(record.kind, 'transform');
  assert.equal(record.injectedEvents, '24');
  assert.equal(record.elapsedMs, '315');
});

test('readAndroidTouchHelperFinalRecord throws a structured error for ok=false records', () => {
  assert.throws(
    () =>
      readAndroidTouchHelperFinalRecord(
        [
          resultRecord({
            ok: 'false',
            errorType: 'java.lang.IllegalStateException',
            message: 'injectInputEvent returned false',
          }),
          'INSTRUMENTATION_CODE: 1',
        ].join('\n'),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'injectInputEvent returned false');
      assert.equal(error.details?.errorType, 'java.lang.IllegalStateException');
      return true;
    },
  );
});

test('readAndroidTouchHelperFinalRecord throws when no final result record is present', () => {
  assert.throws(() => readAndroidTouchHelperFinalRecord('INSTRUMENTATION_CODE: 0'), {
    message: 'Android automation helper did not return a final result',
  });
});

test('one-shot gesture instruments the snapshot-helper runner with the touch-plan payload', async () => {
  const device = makeIsolatedDevice();
  let capturedArgs: string[] | undefined;
  let capturedTimeoutMs: number | undefined;
  const result = await withAndroidAdbProvider(
    {
      exec: currentVersionAdb(async (args, options) => {
        capturedArgs = args;
        capturedTimeoutMs = options?.timeoutMs;
        return {
          exitCode: 0,
          stdout: [
            resultRecord({
              ok: 'true',
              kind: 'swipe',
              helperApiVersion: '1',
              injectedEvents: '4',
              elapsedMs: '12',
            }),
            'INSTRUMENTATION_CODE: 0',
          ].join('\n'),
          stderr: '',
        };
      }),
    },
    { serial: device.id },
    async () => await executeAndroidTouchHelperPlan(device, flingPlan()),
  );

  assert.deepEqual(capturedArgs?.slice(0, 9), [
    'shell',
    'am',
    'instrument',
    '-w',
    '-e',
    'mode',
    'gesture',
    '-e',
    'payloadBase64',
  ]);
  assert.equal(capturedArgs?.at(-1), manifest.instrumentationRunner);
  assert.equal(capturedTimeoutMs, 45_000);

  const payload = JSON.parse(Buffer.from(capturedArgs![9]!, 'base64').toString('utf8'));
  assert.equal(payload.protocol, ANDROID_TOUCH_PLAN_PROTOCOL);
  assert.equal(payload.kind, 'swipe');

  assert.equal(result.backend, 'android-helper');
  assert.equal(result.helperVersion, manifest.version);
  assert.equal(result.installReason, 'current');
  assert.equal(result.helperTransport, 'instrumentation');
  assert.equal(result.helperKind, 'swipe');
  assert.equal(result.injectedEvents, 4);
  assert.equal(result.elapsedMs, 12);
});

test('one-shot gesture timeout extends beyond the plan duration for long-running gestures', async () => {
  const device = makeIsolatedDevice();
  let capturedTimeoutMs: number | undefined;
  await withAndroidAdbProvider(
    {
      exec: currentVersionAdb(async (_args, options) => {
        capturedTimeoutMs = options?.timeoutMs;
        return {
          exitCode: 0,
          stdout: [resultRecord({ ok: 'true', kind: 'swipe' }), 'INSTRUMENTATION_CODE: 0'].join(
            '\n',
          ),
          stderr: '',
        };
      }),
    },
    { serial: device.id },
    async () => await executeAndroidTouchHelperPlan(device, longPressPlan(120_000)),
  );

  assert.equal(capturedTimeoutMs, 135_000);
});

test('one-shot gesture failure propagates as a structured COMMAND_FAILED error', async () => {
  const device = makeIsolatedDevice();
  await assert.rejects(
    withAndroidAdbProvider(
      {
        exec: currentVersionAdb(async () => ({
          exitCode: 1,
          stdout: [
            resultRecord({
              ok: 'false',
              errorType: 'java.lang.IllegalStateException',
              message: 'injectInputEvent returned false',
            }),
            'INSTRUMENTATION_CODE: 1',
          ].join('\n'),
          stderr: '',
        })),
      },
      { serial: device.id },
      async () => await executeAndroidTouchHelperPlan(device, flingPlan()),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'injectInputEvent returned false');
      assert.equal(error.details?.errorType, 'java.lang.IllegalStateException');
      return true;
    },
  );
});

test('unparseable output with a zero exit code reports a parse failure', async () => {
  const device = makeIsolatedDevice();
  await assert.rejects(
    withAndroidAdbProvider(
      { exec: currentVersionAdb(async () => ({ exitCode: 0, stdout: 'garbage', stderr: '' })) },
      { serial: device.id },
      async () => await executeAndroidTouchHelperPlan(device, flingPlan()),
    ),
    { message: 'Android automation helper output could not be parsed' },
  );
});

test('unparseable output with a non-zero exit code reports a helper failure', async () => {
  const device = makeIsolatedDevice();
  await assert.rejects(
    withAndroidAdbProvider(
      { exec: currentVersionAdb(async () => ({ exitCode: 1, stdout: '', stderr: 'boom' })) },
      { serial: device.id },
      async () => await executeAndroidTouchHelperPlan(device, flingPlan()),
    ),
    { message: 'Android automation helper failed before returning parseable output' },
  );
});

test('one-shot viewport instruments the snapshot-helper runner and validates bounds', async () => {
  const device = makeIsolatedDevice();
  let capturedArgs: string[] | undefined;
  const viewportResult = await withAndroidAdbProvider(
    {
      exec: currentVersionAdb(async (args) => {
        capturedArgs = args;
        return {
          exitCode: 0,
          stdout: [
            resultRecord({ ok: 'true', x: '10', y: '20', width: '300', height: '500' }),
            'INSTRUMENTATION_CODE: 0',
          ].join('\n'),
          stderr: '',
        };
      }),
    },
    { serial: device.id },
    async () => await readAndroidTouchHelperViewport(device),
  );

  assert.deepEqual(capturedArgs, [
    'shell',
    'am',
    'instrument',
    '-w',
    '-e',
    'mode',
    'viewport',
    manifest.instrumentationRunner,
  ]);
  assert.deepEqual(viewportResult, { x: 10, y: 20, width: 300, height: 500 });
});

test('one-shot viewport rejects invalid bounds', async () => {
  const device = makeIsolatedDevice();
  await assert.rejects(
    withAndroidAdbProvider(
      {
        exec: currentVersionAdb(async () => ({
          exitCode: 0,
          stdout: [
            resultRecord({ ok: 'true', x: '0', y: '0', width: '0', height: '500' }),
            'INSTRUMENTATION_CODE: 0',
          ].join('\n'),
          stderr: '',
        })),
      },
      { serial: device.id },
      async () => await readAndroidTouchHelperViewport(device),
    ),
    { code: 'COMMAND_FAILED' },
  );
});

test('one-shot viewport failure preserves its structured message and error type', async () => {
  const device = makeIsolatedDevice();
  await assert.rejects(
    withAndroidAdbProvider(
      {
        exec: currentVersionAdb(async () => ({
          exitCode: 1,
          stdout: [
            resultRecord({
              ok: 'false',
              errorType: 'java.lang.SecurityException',
              message: 'UiAutomation is unavailable',
            }),
            'INSTRUMENTATION_CODE: 1',
          ].join('\n'),
          stderr: 'instrumentation failed',
        })),
      },
      { serial: device.id },
      async () => await readAndroidTouchHelperViewport(device),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'UiAutomation is unavailable');
      assert.equal(error.details?.errorType, 'java.lang.SecurityException');
      return true;
    },
  );
});

// --- Persistent snapshot-helper session transport ---------------------------------------
//
// These fake a live `snapshot-helper-session.ts` session the same way
// snapshot-helper-session.test.ts does (a spawned fake process plus a local TCP
// server standing in for the instrumentation's session socket), then drive
// gesture/viewport calls against it to pin the session transport contract.

class FakeAndroidProcess extends EventEmitter implements AndroidAdbProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  onKill: (() => void) | undefined;

  kill(): boolean {
    this.killed = true;
    this.onKill?.();
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

type TouchSessionCommandHandler = (command: string, requestId: string) => string;

function readSessionPort(args: string[]): number {
  const index = args.indexOf('sessionPort');
  assert.notEqual(index, -1);
  return Number(args[index + 1]);
}

function sessionHeaderResponse(headers: Record<string, string>): string {
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n\n`;
}

function snapshotSessionResponse(requestId: string): string {
  const body = '<hierarchy><node text="touch-helper-session" /></hierarchy>';
  const headers = {
    agentDeviceProtocol: 'android-snapshot-helper-v1',
    helperApiVersion: '1',
    outputFormat: 'uiautomator-xml',
    requestId,
    ok: 'true',
    byteLength: String(Buffer.byteLength(body, 'utf8')),
  };
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n\n${body}`;
}

function createFakeTouchHelperSessionProvider(
  handleCommand: TouchSessionCommandHandler,
): AndroidAdbProvider {
  return {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    spawn: (args) => {
      const port = readSessionPort(args);
      const process = new FakeAndroidProcess();
      const server = net.createServer((socket) => {
        socket.once('data', (chunk) => {
          const command = chunk.toString('utf8').trim();
          const [, requestId = ''] = command.split(/\s+/, 2);
          socket.end(handleCommand(command, requestId));
        });
      });
      server.listen(port, '127.0.0.1', () => {
        process.stdout.write(
          [
            'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
            'INSTRUMENTATION_STATUS: sessionReady=true',
            'INSTRUMENTATION_STATUS_CODE: 2',
            '',
          ].join('\n'),
        );
      });
      process.onKill = () => {
        server.close(() => process.emitExit(0, null));
      };
      return process;
    },
  };
}

async function startFakeTouchHelperSession(
  device: DeviceInfo,
  handleCommand: TouchSessionCommandHandler,
): Promise<{ deviceKey: string; isSessionAlive: () => Promise<boolean> }> {
  const deviceKey = getAndroidSnapshotHelperSessionDeviceKey(device);
  const provider = createFakeTouchHelperSessionProvider((command, requestId) => {
    if (command.startsWith('snapshot')) return snapshotSessionResponse(requestId);
    return handleCommand(command, requestId);
  });
  const capture = async () =>
    await captureAndroidSnapshotWithHelperSession({
      adb: provider.exec,
      adbProvider: provider,
      deviceKey,
    });
  const output = await capture();
  assert.ok(output, 'expected the fake snapshot helper session to start');
  return {
    deviceKey,
    // A live session serves another capture without restarting; a stopped one must spawn anew.
    isSessionAlive: async () => (await capture())?.metadata.sessionReused === true,
  };
}

test('gesture uses the persistent snapshot-helper session and does not stop it', async () => {
  const device = makeIsolatedDevice();
  let gestureCallCount = 0;
  const session = await startFakeTouchHelperSession(device, (command, requestId) => {
    if (command.startsWith('gesture')) {
      gestureCallCount += 1;
      return sessionHeaderResponse({
        agentDeviceProtocol: 'android-snapshot-helper-v1',
        requestId,
        ok: 'true',
        kind: 'swipe',
        helperApiVersion: '1',
        injectedEvents: '6',
        elapsedMs: '9',
      });
    }
    return sessionHeaderResponse({
      agentDeviceProtocol: 'android-snapshot-helper-v1',
      requestId,
      ok: 'true',
    });
  });

  const result = await withAndroidAdbProvider(
    {
      exec: currentVersionAdb(async (args) => {
        throw new Error(
          `unexpected instrumentation call while a session is active: ${args.join(' ')}`,
        );
      }),
    },
    { serial: device.id },
    async () => await executeAndroidTouchHelperPlan(device, flingPlan()),
  );

  assert.equal(result.helperTransport, 'persistent-session');
  assert.equal(result.helperKind, 'swipe');
  assert.equal(result.injectedEvents, 6);
  assert.equal(result.elapsedMs, 9);
  assert.equal(gestureCallCount, 1);
  assert.equal(await session.isSessionAlive(), true);
});

test('a structured ok=false session gesture response throws but leaves the session alive', async () => {
  const device = makeIsolatedDevice();
  const session = await startFakeTouchHelperSession(device, (command, requestId) => {
    if (command.startsWith('gesture')) {
      return sessionHeaderResponse({
        agentDeviceProtocol: 'android-snapshot-helper-v1',
        requestId,
        ok: 'false',
        errorType: 'java.lang.IllegalStateException',
        message: 'injectInputEvent returned false',
      });
    }
    return sessionHeaderResponse({
      agentDeviceProtocol: 'android-snapshot-helper-v1',
      requestId,
      ok: 'true',
    });
  });

  await assert.rejects(
    withAndroidAdbProvider(
      {
        exec: currentVersionAdb(async (args) => {
          throw new Error(
            `unexpected instrumentation call while a session is active: ${args.join(' ')}`,
          );
        }),
      },
      { serial: device.id },
      async () => await executeAndroidTouchHelperPlan(device, flingPlan()),
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'injectInputEvent returned false');
      return true;
    },
  );

  assert.equal(await session.isSessionAlive(), true);
});

test('a malformed session gesture response stops the session and does not fall back to one-shot', async () => {
  const device = makeIsolatedDevice();
  const session = await startFakeTouchHelperSession(device, (command, requestId) => {
    if (command.startsWith('gesture')) return 'not a session response';
    return sessionHeaderResponse({
      agentDeviceProtocol: 'android-snapshot-helper-v1',
      requestId,
      ok: 'true',
    });
  });

  let instrumentCalled = false;
  await assert.rejects(
    withAndroidAdbProvider(
      {
        exec: currentVersionAdb(async () => {
          instrumentCalled = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        }),
      },
      { serial: device.id },
      async () => await executeAndroidTouchHelperPlan(device, flingPlan()),
    ),
  );

  assert.equal(instrumentCalled, false);
  assert.equal(await session.isSessionAlive(), false);
});

test('viewport falls back to one-shot instrumentation after a session error', async () => {
  const device = makeIsolatedDevice();
  const session = await startFakeTouchHelperSession(device, (command, requestId) => {
    if (command.startsWith('viewport')) return 'not a session response';
    return sessionHeaderResponse({
      agentDeviceProtocol: 'android-snapshot-helper-v1',
      requestId,
      ok: 'true',
    });
  });

  let oneShotArgs: string[] | undefined;
  const viewportResult = await withAndroidAdbProvider(
    {
      exec: currentVersionAdb(async (args) => {
        oneShotArgs = args;
        return {
          exitCode: 0,
          stdout: [
            resultRecord({ ok: 'true', x: '5', y: '6', width: '300', height: '400' }),
            'INSTRUMENTATION_CODE: 0',
          ].join('\n'),
          stderr: '',
        };
      }),
    },
    { serial: device.id },
    async () => await readAndroidTouchHelperViewport(device),
  );

  assert.deepEqual(viewportResult, { x: 5, y: 6, width: 300, height: 400 });
  assert.ok(oneShotArgs?.includes('viewport'));
  assert.equal(await session.isSessionAlive(), false);
});

test('a structured ok=false viewport response stops the session before the one-shot retry', async () => {
  const device = makeIsolatedDevice();
  const session = await startFakeTouchHelperSession(device, (command, requestId) => {
    if (command.startsWith('viewport')) {
      return sessionHeaderResponse({
        agentDeviceProtocol: 'android-snapshot-helper-v1',
        requestId,
        ok: 'false',
        errorType: 'java.lang.IllegalStateException',
        message: 'Active application interaction viewport is unavailable',
      });
    }
    return sessionHeaderResponse({
      agentDeviceProtocol: 'android-snapshot-helper-v1',
      requestId,
      ok: 'true',
    });
  });

  let oneShotArgs: string[] | undefined;
  const viewportResult = await withAndroidAdbProvider(
    {
      exec: currentVersionAdb(async (args) => {
        // One instrumentation may own UiAutomation: the one-shot retry must only run once the
        // structurally-failed session has been stopped.
        assert.equal(await session.isSessionAlive(), false);
        oneShotArgs = args;
        return {
          exitCode: 0,
          stdout: [
            resultRecord({ ok: 'true', x: '5', y: '6', width: '300', height: '400' }),
            'INSTRUMENTATION_CODE: 0',
          ].join('\n'),
          stderr: '',
        };
      }),
    },
    { serial: device.id },
    async () => await readAndroidTouchHelperViewport(device),
  );

  assert.deepEqual(viewportResult, { x: 5, y: 6, width: 300, height: 400 });
  assert.ok(oneShotArgs?.includes('viewport'));
});
