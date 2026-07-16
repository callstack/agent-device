import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { buildGesturePlan } from '../../../contracts/gesture-plan.ts';
import { AppError } from '../../../kernel/errors.ts';
import { withAndroidAdbProvider } from '../adb-executor.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session.ts';
import {
  ANDROID_TOUCH_PLAN_PROTOCOL,
  executeAndroidTouchHelperPlan,
  normalizeAndroidTouchHelperGestureRequest,
  readAndroidTouchHelperFinalRecord,
  readAndroidTouchHelperViewport,
} from '../touch-helper.ts';
import { resolveAndroidHelperArtifact } from '../helper-package-install.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from '../../../__tests__/test-utils/android-snapshot-helper.ts';
import {
  ANDROID_TOUCH_HELPER_MANIFEST as manifest,
  ANDROID_TOUCH_HELPER_VIEWPORT as viewport,
  androidTouchHelperResultRecord as resultRecord,
  currentVersionAdb,
  flingPlan,
  longPressPlan,
  makeIsolatedDevice,
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

test('a provider-supplied snapshotHelperArtifact overrides the bundled artifact for touch', async () => {
  const device = makeIsolatedDevice();
  const providerArtifact = {
    ...ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    manifest: {
      ...ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT.manifest,
      packageName: 'com.example.provider.snapshothelper',
      instrumentationRunner: 'com.example.provider.snapshothelper/.SnapshotInstrumentation',
    },
  };
  vi.mocked(resolveAndroidHelperArtifact).mockClear();

  let probeArgs: string[] | undefined;
  let installArgs: string[] | undefined;
  let instrumentArgs: string[] | undefined;
  const result = await withAndroidAdbProvider(
    {
      // ADB-backed provider carrying a helper artifact but no native touch implementation:
      // gestures must install and run the provider's helper, same as snapshots do, never the
      // bundled artifact resolver.
      exec: async (args) => {
        if (args.includes('--show-versioncode')) {
          probeArgs = [...args];
          return {
            exitCode: 0,
            stdout: `package:${providerArtifact.manifest.packageName} versionCode:1`,
            stderr: '',
          };
        }
        if (args[0] === 'install') {
          installArgs = [...args];
          return { exitCode: 0, stdout: 'Success', stderr: '' };
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

  assert.equal(vi.mocked(resolveAndroidHelperArtifact).mock.calls.length, 0);
  assert.ok(probeArgs?.includes(providerArtifact.manifest.packageName));
  assert.equal(installArgs?.at(-1), providerArtifact.apkPath);
  assert.equal(instrumentArgs?.at(-1), providerArtifact.manifest.instrumentationRunner);
  assert.equal(result.installReason, 'outdated');
  assert.equal(result.helperVersion, providerArtifact.manifest.version);
  assert.equal(result.helperTransport, 'instrumentation');
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
