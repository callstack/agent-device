import { expect, test, vi } from 'vitest';
import {
  bindLocalGestureInteractor,
  bindProviderGestureInteractor,
  gestureRuntimeOperationFacts,
} from './gesture-runtime.ts';
import type { GesturePlan } from './gesture-plan-types.ts';
import type { Interactor } from './interactor-types.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;

const available = { available: true } as const;
const unavailable = { available: false, reason: 'unsupported-platform-leaf' } as const;

const allAvailable = gestureRuntimeOperationFacts({
  plan: available,
  directionalFling: available,
  multiTouch: available,
  targetAuthoredDrag: available,
  viewport: available,
});

const plan: GesturePlan = {
  topology: 'single',
  intent: 'pan',
  executionProfile: 'timed-pan',
  durationMs: 300,
  viewport: { x: 0, y: 0, width: 400, height: 800 },
  pointers: [
    {
      pointerId: 0,
      samples: [
        { offsetMs: 0, point: { x: 10, y: 20 } },
        { offsetMs: 300, point: { x: 10, y: 220 } },
      ],
    },
  ],
};

test('builds the exact gesture operation fact catalog', () => {
  expect(
    gestureRuntimeOperationFacts({
      plan: available,
      directionalFling: unavailable,
      multiTouch: unavailable,
      targetAuthoredDrag: available,
      viewport: unavailable,
    }),
  ).toEqual({
    performGesturePlan: available,
    performDirectionalFlingPlan: unavailable,
    performMultiTouchGesturePlan: unavailable,
    performTargetAuthoredDrag: available,
    gestureViewport: unavailable,
  });
});

test('a local binding executes the plan through the owner interactor', async () => {
  const performGesture = vi.fn(async () => ({ backend: 'adb' }));
  const resolveInteractor = vi.fn(async () => ({ performGesture }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindLocalGestureInteractor({
    device,
    signal,
    facts: allAvailable,
    resolveInteractor,
  });
  await operations.performGesturePlan?.({
    plan,
    options: { appBundleId: 'com.example.app' },
    execution: { logPath: '/tmp/daemon.log', requestId: 'gesture-1' },
  });

  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    logPath: '/tmp/daemon.log',
    requestId: 'gesture-1',
    appBundleId: 'com.example.app',
    signal,
  });
  // The plan reaches the seam whole and unmodified — this is the sole argument, so an executor
  // that dropped or rebuilt it shows up here.
  expect(performGesture).toHaveBeenCalledWith(plan);
});

test('every admitted tier reaches the same single plan executor', async () => {
  const performGesture = vi.fn(async () => ({}));
  const operations = bindLocalGestureInteractor({
    device,
    signal: new AbortController().signal,
    facts: allAvailable,
    resolveInteractor: async () => ({ performGesture }) as unknown as Interactor,
  });

  await operations.performDirectionalFlingPlan?.({ plan });
  await operations.performMultiTouchGesturePlan?.({ plan });
  await operations.performTargetAuthoredDrag?.({ plan });

  expect(performGesture).toHaveBeenCalledTimes(3);
});

test('a binding exposes only the tiers its owner facts admitted', () => {
  const operations = bindLocalGestureInteractor({
    device,
    signal: new AbortController().signal,
    facts: gestureRuntimeOperationFacts({
      plan: available,
      directionalFling: unavailable,
      multiTouch: unavailable,
      targetAuthoredDrag: unavailable,
      viewport: unavailable,
    }),
    resolveInteractor: async () => ({ performGesture: async () => ({}) }) as unknown as Interactor,
  });

  expect(operations.performGesturePlan).toBeTypeOf('function');
  expect(operations.performDirectionalFlingPlan).toBeUndefined();
  expect(operations.performMultiTouchGesturePlan).toBeUndefined();
  expect(operations.performTargetAuthoredDrag).toBeUndefined();
  expect(operations.gestureViewport).toBeUndefined();
});

test('a local binding reads the owner frame through its interactor', async () => {
  const gestureViewport = vi.fn(async () => ({ x: 0, y: 0, width: 393, height: 852 }));
  const resolveInteractor = vi.fn(async () => ({ gestureViewport }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindLocalGestureInteractor({
    device,
    signal,
    facts: allAvailable,
    resolveInteractor,
  });

  await expect(
    operations.gestureViewport?.({ execution: { requestId: 'gesture-2' } }),
  ).resolves.toEqual({ x: 0, y: 0, width: 393, height: 852 });
  expect(resolveInteractor).toHaveBeenCalledWith(device, {
    requestId: 'gesture-2',
    appBundleId: undefined,
    signal,
  });
});

test('a provider binding executes through its own resolved interactor', async () => {
  const performGesture = vi.fn(async () => ({}));
  const resolveInteractor = vi.fn(() => ({ performGesture }) as unknown as Interactor);
  const signal = new AbortController().signal;

  const operations = bindProviderGestureInteractor({
    device,
    signal,
    facts: allAvailable,
    resolveInteractor,
  });
  await operations.performGesturePlan?.({ plan, execution: { requestId: 'gesture-3' } });

  expect(resolveInteractor).toHaveBeenCalledWith({
    requestId: 'gesture-3',
    appBundleId: undefined,
    signal,
  });
  expect(performGesture).toHaveBeenCalledWith(plan);
});

test('a provider binding fails closed when its exact owner exposes no interactor', async () => {
  const operations = bindProviderGestureInteractor({
    device,
    signal: new AbortController().signal,
    facts: allAvailable,
    resolveInteractor: () => undefined,
  });

  await expect(operations.performGesturePlan?.({ plan })).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'provider-runtime-interactor-missing', deviceId: device.id },
  });
});

test('an advertised tier whose interactor cannot execute is a contract bug, not a refusal', async () => {
  const operations = bindLocalGestureInteractor({
    device,
    signal: new AbortController().signal,
    facts: allAvailable,
    resolveInteractor: async () => ({}) as unknown as Interactor,
  });

  await expect(operations.performGesturePlan?.({ plan })).rejects.toMatchObject({
    message: expect.stringContaining('advertised gesture execution'),
  });
});

test('an already-cancelled request never resolves an interactor', async () => {
  const controller = new AbortController();
  controller.abort();
  const performGesture = vi.fn(async () => ({}));
  const resolveInteractor = vi.fn(async () => ({ performGesture }) as unknown as Interactor);

  const operations = bindLocalGestureInteractor({
    device,
    signal: controller.signal,
    facts: allAvailable,
    resolveInteractor,
  });

  await expect(operations.performGesturePlan?.({ plan })).rejects.toThrow();
  expect(resolveInteractor).not.toHaveBeenCalled();
  expect(performGesture).not.toHaveBeenCalled();
});
