// --- Persistent snapshot-helper session transport ---------------------------------------
//
// These fake a live `snapshot-helper-session.ts` session the same way
// snapshot-helper-session.test.ts does (a spawned fake process plus a local TCP
// server standing in for the instrumentation's session socket), then drive
// gesture/viewport calls against it to pin the session transport contract.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import {
  withAndroidAdbProvider,
  type AndroidAdbProcess,
  type AndroidAdbProvider,
} from '../adb-executor.ts';
import {
  captureAndroidSnapshotWithHelperSession,
  getAndroidSnapshotHelperSessionDeviceKey,
  resetAndroidSnapshotHelperSessions,
} from '../snapshot-helper-session.ts';
import { executeAndroidTouchHelperPlan, readAndroidTouchHelperViewport } from '../touch-helper.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../__tests__/test-utils/android-snapshot-helper.ts';
import {
  ANDROID_TOUCH_HELPER_MANIFEST as manifest,
  androidTouchHelperResultRecord as resultRecord,
  currentVersionAdb,
  flingPlan,
  makeIsolatedDevice,
  outdatedVersionAdb,
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

beforeEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

afterEach(async () => {
  delete process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  await resetAndroidSnapshotHelperSessions();
});

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
  helperIdentity: {
    helperVersion?: string;
    helperVersionCode?: number;
    helperSha256?: string;
  } = {},
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
      ...helperIdentity,
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

test('an APK replacement stops the stale session and the gesture runs one-shot', async () => {
  const device = makeIsolatedDevice();
  let sessionGestureCallCount = 0;
  const session = await startFakeTouchHelperSession(device, (command, requestId) => {
    if (command.startsWith('gesture')) {
      sessionGestureCallCount += 1;
      return sessionHeaderResponse({
        agentDeviceProtocol: 'android-snapshot-helper-v1',
        requestId,
        ok: 'true',
        kind: 'swipe',
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

  let oneShotArgs: string[] | undefined;
  const result = await withAndroidAdbProvider(
    {
      // The install probe reports an outdated helper, so prepareAndroidTouchHelper replaces the
      // APK. That replacement kills the instrumentation the live session socket belongs to; the
      // gesture must not be sent there and must run one-shot against the fresh binary instead.
      exec: outdatedVersionAdb(async (args) => {
        assert.ok(args.includes('instrument'), `unexpected adb call: ${args.join(' ')}`);
        oneShotArgs = args;
        return {
          exitCode: 0,
          stdout: [
            resultRecord({ ok: 'true', kind: 'swipe', injectedEvents: '4', elapsedMs: '12' }),
            'INSTRUMENTATION_CODE: 0',
          ].join('\n'),
          stderr: '',
        };
      }),
    },
    { serial: device.id },
    async () => await executeAndroidTouchHelperPlan(device, flingPlan()),
  );

  assert.equal(result.installReason, 'outdated');
  assert.equal(result.helperTransport, 'instrumentation');
  assert.equal(result.helperKind, 'swipe');
  assert.ok(oneShotArgs?.includes('gesture'));
  assert.equal(sessionGestureCallCount, 0);
  assert.equal(await session.isSessionAlive(), false);
});

test('a provider artifact that mismatches the live session helper stops it and runs one-shot', async () => {
  const device = makeIsolatedDevice();
  let sessionGestureCallCount = 0;
  const session = await startFakeTouchHelperSession(device, (command, requestId) => {
    if (command.startsWith('gesture')) {
      sessionGestureCallCount += 1;
      return sessionHeaderResponse({
        agentDeviceProtocol: 'android-snapshot-helper-v1',
        requestId,
        ok: 'true',
        kind: 'swipe',
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

  const providerArtifact = {
    ...ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    manifest: {
      ...ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest,
      packageName: 'com.example.provider.snapshothelper',
      instrumentationRunner: 'com.example.provider.snapshothelper/.SnapshotInstrumentation',
    },
  };

  let instrumentArgs: string[] | undefined;
  const result = await withAndroidAdbProvider(
    {
      // Artifact B is already current on the device, so no install happens: the session started
      // by artifact A must be invalidated by the helper-identity guard, not the install path.
      exec: async (args) => {
        if (args.includes('--show-versioncode')) {
          return {
            exitCode: 0,
            stdout: `package:${providerArtifact.manifest.packageName} versionCode:999999`,
            stderr: '',
          };
        }
        instrumentArgs = [...args];
        return {
          exitCode: 0,
          stdout: [
            resultRecord({ ok: 'true', kind: 'swipe', injectedEvents: '4', elapsedMs: '12' }),
            'INSTRUMENTATION_CODE: 0',
          ].join('\n'),
          stderr: '',
        };
      },
      snapshotHelperArtifact: providerArtifact,
    },
    { serial: device.id },
    async () => await executeAndroidTouchHelperPlan(device, flingPlan()),
  );

  assert.equal(result.installReason, 'current');
  assert.equal(result.helperTransport, 'instrumentation');
  assert.equal(instrumentArgs?.at(-1), providerArtifact.manifest.instrumentationRunner);
  assert.equal(sessionGestureCallCount, 0);
  assert.equal(await session.isSessionAlive(), false);
});

test('a same-version artifact with a different sha stops the live session and runs one-shot', async () => {
  const device = makeIsolatedDevice();
  // Artifacts A and B share packageName/runner/version/versionCode and differ only in APK bytes
  // (sha256) — the supported same-version replacement. B owns the live session; a command that
  // selects A must not be served by B's binary.
  const artifactA = ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT;
  const shaB = 'b'.repeat(64);
  let sessionGestureCallCount = 0;
  const session = await startFakeTouchHelperSession(
    device,
    (command, requestId) => {
      if (command.startsWith('gesture')) {
        sessionGestureCallCount += 1;
        return sessionHeaderResponse({
          agentDeviceProtocol: 'android-snapshot-helper-v1',
          requestId,
          ok: 'true',
          kind: 'swipe',
          injectedEvents: '6',
          elapsedMs: '9',
        });
      }
      return sessionHeaderResponse({
        agentDeviceProtocol: 'android-snapshot-helper-v1',
        requestId,
        ok: 'true',
      });
    },
    {
      helperVersion: artifactA.manifest.version,
      helperVersionCode: artifactA.manifest.versionCode,
      helperSha256: shaB,
    },
  );

  let instrumentArgs: string[] | undefined;
  const result = await withAndroidAdbProvider(
    {
      // A is reported already current by versionCode, so no install occurs: only the sha in the
      // session helper identity can reveal that the live session runs B's binary.
      exec: async (args) => {
        if (args.includes('--show-versioncode')) {
          return {
            exitCode: 0,
            stdout: `package:${artifactA.manifest.packageName} versionCode:999999`,
            stderr: '',
          };
        }
        instrumentArgs = [...args];
        return {
          exitCode: 0,
          stdout: [
            resultRecord({ ok: 'true', kind: 'swipe', injectedEvents: '4', elapsedMs: '12' }),
            'INSTRUMENTATION_CODE: 0',
          ].join('\n'),
          stderr: '',
        };
      },
      snapshotHelperArtifact: artifactA,
    },
    { serial: device.id },
    async () => await executeAndroidTouchHelperPlan(device, flingPlan()),
  );

  assert.equal(result.installReason, 'current');
  assert.equal(result.helperTransport, 'instrumentation');
  assert.equal(instrumentArgs?.at(-1), artifactA.manifest.instrumentationRunner);
  assert.equal(sessionGestureCallCount, 0);
  assert.equal(await session.isSessionAlive(), false);
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
