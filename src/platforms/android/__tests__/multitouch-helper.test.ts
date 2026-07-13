import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildGesturePlan } from '../../../contracts/gesture-plan.ts';
import {
  normalizeAndroidMultiTouchHelperGestureRequest,
  parseAndroidMultiTouchHelperOutput,
  runAndroidMultiTouchHelperGesture,
  parseAndroidGestureViewportResult,
} from '../multitouch-helper.ts';
import {
  ANDROID_MULTITOUCH_HELPER_MANIFEST as manifest,
  androidMultiTouchResultRecord as resultRecord,
} from './multitouch-helper.fixtures.ts';

const viewport = { x: 0, y: 0, width: 400, height: 800 };

function longPressRequest(durationMs = 120_000) {
  const point = { x: 20, y: 30 };
  return normalizeAndroidMultiTouchHelperGestureRequest({
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
  });
}

test('helper response parsing returns instrumentation evidence', () => {
  assert.deepEqual(
    parseAndroidMultiTouchHelperOutput(
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
    ),
    {
      helperKind: 'transform',
      helperApiVersion: '1',
      injectedEvents: 24,
      elapsedMs: 315,
    },
  );
});

test('canonical plans lower to exact helper samples without semantic geometry', () => {
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
  const request = normalizeAndroidMultiTouchHelperGestureRequest(pan);

  assert.ok('pointers' in request);
  assert.equal(request.kind, 'transform');
  assert.equal(request.durationMs, 32);
  assert.deepEqual(
    request.pointers,
    pan.pointers.map((pointer) => ({
      pointerId: pointer.pointerId,
      samples: pointer.samples.map(({ offsetMs, point }) => ({
        offsetMs,
        x: point.x,
        y: point.y,
      })),
    })),
  );
  assert.equal('scale' in request, false);
  assert.equal('degrees' in request, false);
  assert.equal('dx' in request, false);
});

test('single-pointer plans use the same exact helper protocol', () => {
  const fling = buildGesturePlan(
    { intent: 'fling', from: { x: 300, y: 400 }, to: { x: 100, y: 400 } },
    viewport,
  );
  const request = normalizeAndroidMultiTouchHelperGestureRequest(fling);
  assert.equal(request.kind, 'swipe');
  assert.equal(request.pointers.length, 1);
  assert.equal(request.durationMs, 100);
});

test('Android long press lowers to a stationary single-pointer helper request', () => {
  const request = longPressRequest();
  assert.equal(request.kind, 'swipe');
  assert.equal(request.durationMs, 120_000);
  assert.deepEqual(request.pointers[0]?.samples, [
    { offsetMs: 0, x: 20, y: 30 },
    { offsetMs: 120_000, x: 20, y: 30 },
  ]);
});

test('max-duration long press extends the helper process timeout', async () => {
  await runAndroidMultiTouchHelperGesture({
    adb: async (_args, options) => {
      assert.equal(options?.timeoutMs, 135_000);
      return {
        exitCode: 0,
        stdout: [resultRecord({ ok: 'true', kind: 'swipe' }), 'INSTRUMENTATION_CODE: 0'].join('\n'),
        stderr: '',
      };
    },
    request: longPressRequest(),
    packageName: manifest.packageName,
    instrumentationRunner: manifest.instrumentationRunner,
  });
});

test('transform sends the planner-owned choreography without regenerating geometry', async () => {
  const plan = buildGesturePlan(
    {
      intent: 'transform',
      origin: { x: 200, y: 300 },
      delta: { x: 20, y: 10 },
      scale: 1.2,
      degrees: 10,
      durationMs: 32,
    },
    viewport,
  );
  const request = normalizeAndroidMultiTouchHelperGestureRequest(plan);
  assert.equal(request.kind, 'transform');
  assert.deepEqual(
    request.pointers,
    plan.pointers.map((pointer) => ({
      pointerId: pointer.pointerId,
      samples: pointer.samples.map(({ offsetMs, point }) => ({
        offsetMs,
        x: point.x,
        y: point.y,
      })),
    })),
  );
  let payload: Record<string, unknown> | undefined;
  await runAndroidMultiTouchHelperGesture({
    adb: async (args, options) => {
      payload = JSON.parse(Buffer.from(args[6]!, 'base64').toString('utf8'));
      assert.equal(options?.timeoutMs, 45_000);
      return {
        exitCode: 0,
        stdout: [resultRecord({ ok: 'true', kind: 'transform' }), 'INSTRUMENTATION_CODE: 0'].join(
          '\n',
        ),
        stderr: '',
      };
    },
    request,
    packageName: manifest.packageName,
    instrumentationRunner: manifest.instrumentationRunner,
  });
  assert.deepEqual(payload, { protocol: 'android-multitouch-helper-v1', ...request });
});

test('helper failures remain structured and actionable', async () => {
  const request = normalizeAndroidMultiTouchHelperGestureRequest(
    buildGesturePlan({ intent: 'pinch', scale: 1.5 }, viewport),
  );
  await assert.rejects(
    () =>
      runAndroidMultiTouchHelperGesture({
        adb: async () => ({
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
        }),
        request,
        packageName: manifest.packageName,
        instrumentationRunner: manifest.instrumentationRunner,
      }),
    { code: 'COMMAND_FAILED', message: 'injectInputEvent returned false' },
  );
});

test('gesture viewport result is typed and rejects invalid bounds', () => {
  assert.deepEqual(
    parseAndroidGestureViewportResult([
      {
        agentDeviceProtocol: 'android-multitouch-helper-v1',
        ok: 'true',
        x: '10',
        y: '20',
        width: '300',
        height: '500',
      },
    ]),
    { x: 10, y: 20, width: 300, height: 500 },
  );
  assert.throws(
    () =>
      parseAndroidGestureViewportResult([
        {
          agentDeviceProtocol: 'android-multitouch-helper-v1',
          ok: 'true',
          x: '0',
          y: '0',
          width: '0',
          height: '500',
        },
      ]),
    { code: 'COMMAND_FAILED' },
  );
  assert.throws(() => parseAndroidGestureViewportResult([]), { code: 'COMMAND_FAILED' });
});
