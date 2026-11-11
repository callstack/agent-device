import { beforeEach, expect, test, vi } from 'vitest';
import { IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';

const { queryAppleRunnerSelector } = vi.hoisted(() => ({
  queryAppleRunnerSelector: vi.fn(async (): Promise<Record<string, unknown>> => ({
    found: true,
  })),
}));

vi.mock('../core/runner-selector-query.ts', () => ({ queryAppleRunnerSelector }));

import {
  bindAppleQuerySelectorRuntime,
  bindApplePressReadinessRuntime,
} from '../runtime-selector-query.ts';

beforeEach(() => {
  queryAppleRunnerSelector.mockReset();
  queryAppleRunnerSelector.mockResolvedValue({ found: true });
});

const APP = 'com.example.app';

function bind(signal?: AbortSignal) {
  return bindAppleQuerySelectorRuntime({
    device: IOS_SIMULATOR,
    signal: signal ?? new AbortController().signal,
  });
}

test('forwards the selector, app scope, and the full runner-execution projection', async () => {
  await bind().querySelector({
    selector: { key: 'id', value: 'submit-order' },
    options: { appBundleId: APP },
    execution: {
      requestId: 'req-9',
      logPath: '/tmp/runner.log',
      traceLogPath: '/tmp/trace.log',
      verbose: true,
      iosXctestrunFile: '/tmp/run.xctestrun',
    },
  });

  expect(queryAppleRunnerSelector).toHaveBeenCalledWith(
    IOS_SIMULATOR,
    { key: 'id', value: 'submit-order' },
    APP,
    expect.objectContaining({
      requestId: 'req-9',
      logPath: '/tmp/runner.log',
      traceLogPath: '/tmp/trace.log',
      verbose: true,
      iosXctestrunFile: '/tmp/run.xctestrun',
    }),
  );
});

test('refuses an already-aborted binding signal without querying the runner', async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(
    bind(controller.signal).querySelector({ selector: { key: 'label', value: 'Go' } }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(queryAppleRunnerSelector).not.toHaveBeenCalled();
});

test('projects the matched node to its rect and hittability', async () => {
  queryAppleRunnerSelector.mockResolvedValue({
    found: true,
    nodes: [{ index: 0, rect: { x: 1, y: 2, width: 3, height: 4 }, hittable: true }],
  });

  await expect(bind().querySelector({ selector: { key: 'label', value: 'Go' } })).resolves.toEqual({
    found: true,
    node: { rect: { x: 1, y: 2, width: 3, height: 4 }, hittable: true },
  });
});

test('a miss answers found:false with no node', async () => {
  queryAppleRunnerSelector.mockResolvedValue({ found: false, nodes: [] });

  await expect(
    bind().querySelector({ selector: { key: 'label', value: 'Gone' } }),
  ).resolves.toEqual({ found: false });
});

test('a node without a usable rect answers found without a node (the rescue stays fail-closed)', async () => {
  queryAppleRunnerSelector.mockResolvedValue({ found: true, nodes: [{ index: 0 }] });

  await expect(bind().querySelector({ selector: { key: 'label', value: 'Go' } })).resolves.toEqual({
    found: true,
  });
});

function readinessBinding(signal = new AbortController().signal) {
  return bindApplePressReadinessRuntime({ device: IOS_SIMULATOR, signal });
}

test('strict readiness requires app scope before contacting the runner', async () => {
  const input = {
    authorizedTarget: {
      type: 9,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      point: { x: 5, y: 5 },
    },
    execution: {},
  };
  await expect(
    // @ts-expect-error Untyped callers cannot omit the authorized app scope.
    readinessBinding().pressReadiness(input),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(queryAppleRunnerSelector).not.toHaveBeenCalled();
});

test('strict readiness cannot accept a public selector response as native proof', async () => {
  await expect(
    readinessBinding().pressReadiness({
      appBundleId: APP,
      execution: {},
      authorizedTarget: {
        type: 9,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        point: { x: 5, y: 5 },
      },
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
});

for (const readiness of ['ready', 'blocked', 'missing', 'ambiguous'] as const) {
  test(`strict native ${readiness} preserves the proof and request scope`, async () => {
    queryAppleRunnerSelector.mockResolvedValue({
      pressReadiness: readiness,
      pressReadinessAppBundleId: APP,
    });
    const authorizedTarget = {
      type: 9,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      point: { x: 5, y: 5 },
    };
    await expect(
      readinessBinding().pressReadiness({
        appBundleId: APP,
        execution: {
          requestId: 'native-read',
          iosXctestrunFile: '/tmp/native.xctestrun',
          traceLogPath: '/tmp/native-trace.log',
          verbose: true,
        },
        authorizedTarget,
      }),
    ).resolves.toEqual({ readiness, appBundleId: APP });
    expect(queryAppleRunnerSelector).toHaveBeenCalledWith(
      IOS_SIMULATOR,
      { authorizedTarget },
      APP,
      expect.objectContaining({
        requestId: 'native-read',
        iosXctestrunFile: '/tmp/native.xctestrun',
        traceLogPath: '/tmp/native-trace.log',
        verbose: true,
        signal: expect.any(AbortSignal),
      }),
    );
  });
}

test('a ready reply from another surface cannot authorize the app target', async () => {
  queryAppleRunnerSelector.mockResolvedValue({
    pressReadiness: 'ready',
    pressReadinessAppBundleId: 'com.apple.springboard',
  });
  await expect(
    readinessBinding().pressReadiness({
      appBundleId: APP,
      execution: {},
      authorizedTarget: {
        type: 9,
        rect: { x: 0, y: 0, width: 10, height: 10 },
        point: { x: 5, y: 5 },
      },
    }),
  ).resolves.toEqual({ readiness: 'surface-mismatch', appBundleId: 'com.apple.springboard' });
});

test.each(['binding', 'input'] as const)(
  'an aborted %s signal prevents a strict runner read',
  async (source) => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readinessBinding(source === 'binding' ? controller.signal : undefined).pressReadiness({
        appBundleId: APP,
        execution: {},
        signal: source === 'input' ? controller.signal : undefined,
        authorizedTarget: {
          type: 9,
          rect: { x: 0, y: 0, width: 10, height: 10 },
          point: { x: 5, y: 5 },
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(queryAppleRunnerSelector).not.toHaveBeenCalled();
  },
);
