import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';
import {
  MACOS_NATIVE_BACKEND_UNSUPPORTED,
  withMacOsNativeAppBackend,
} from './native-app-interactor.ts';

const context: RunnerContext = { appBundleId: 'com.apple.TextEdit' };

/** The XCTest-backed interactor the native backend wraps; any call reaching it is recorded. */
function runnerInteractor(reached: string[] = []): Interactor {
  const record = (method: string) => async () => {
    reached.push(method);
    return {};
  };
  return {
    pressPoint: record('pressPoint'),
    type: record('type'),
    scroll: record('scroll'),
  } as unknown as Interactor;
}

function nativeOverrides(ctx: RunnerContext = context, reached: string[] = []): Interactor {
  return withMacOsNativeAppBackend(runnerInteractor(reached), ctx);
}

async function recordHelperCalls(
  data: Record<string, unknown>,
  run: (overrides: Interactor) => Promise<unknown>,
): Promise<{ calls: string[][]; result: unknown }> {
  const calls: string[][] = [];
  const reachedRunner: string[] = [];
  const provider = createLocalAppleToolProvider({
    macosHelper: {
      run: async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '' };
      },
    },
  });
  const result = await withAppleToolProvider(
    provider,
    async () => await run(nativeOverrides(context, reachedRunner)),
  );
  // Served through the helper alone: the XCTest-backed interactor never ran.
  assert.deepEqual(reachedRunner, []);
  return { calls, result };
}

test('a native tap presses the app surface under the ghost cursor and reports the mechanism', async () => {
  const { calls, result } = await recordHelperCalls(
    { x: 10, y: 20, mechanism: 'ax-press' },
    async (overrides) => await overrides.tap(10, 20),
  );
  assert.deepEqual(calls, [
    [
      'press',
      '--x',
      '10',
      '--y',
      '20',
      '--bundle-id',
      'com.apple.TextEdit',
      '--surface',
      'app',
      '--ghost-cursor',
    ],
  ]);
  assert.deepEqual(result, { mechanism: 'ax-press' });
});

test('native type and fill address the session app, not the frontmost one', async () => {
  const { calls } = await recordHelperCalls({ mechanism: 'ax-value' }, async (overrides) => {
    await overrides.type('hello');
    await overrides.fill(5, 6, 'world');
  });
  assert.deepEqual(calls, [
    ['type', '--text', 'hello', '--bundle-id', 'com.apple.TextEdit', '--ghost-cursor'],
    [
      'fill',
      '--x',
      '5',
      '--y',
      '6',
      '--text',
      'world',
      '--bundle-id',
      'com.apple.TextEdit',
      '--ghost-cursor',
    ],
  ]);
});

test('a native scroll reports travel from the window frame the helper resolved', async () => {
  const { calls, result } = await recordHelperCalls(
    {
      x: 480,
      y: 434,
      x2: 480,
      y2: 134,
      referenceWidth: 656,
      referenceHeight: 422,
      travelPixels: 300,
      mechanism: 'ax-scroll-bar',
    },
    async (overrides) => await overrides.scroll('down', { pixels: 300 }),
  );
  assert.deepEqual(calls, [
    [
      'scroll',
      '--direction',
      'down',
      '--pixels',
      '300',
      '--bundle-id',
      'com.apple.TextEdit',
      '--ghost-cursor',
    ],
  ]);
  assert.deepEqual(result, {
    x1: 480,
    y1: 434,
    x2: 480,
    y2: 134,
    referenceWidth: 656,
    referenceHeight: 422,
    pixels: 300,
    mechanism: 'ax-scroll-bar',
  });
});

test('commands only the runner serves refuse with a typed reason instead of starting XCTest', async () => {
  const overrides = nativeOverrides();
  for (const refused of [
    () => overrides.back(),
    () => overrides.setOrientation('portrait'),
    () => overrides.gestureViewport!(),
    () => overrides.pressPoint!({ x: 1, y: 2 }, secondaryClick),
  ]) {
    await assert.rejects(refused, isNativeBackendRefusal);
  }
});

test('a helper refusal surfaces as an unsupported operation that keeps the helper reason', async () => {
  const provider = createLocalAppleToolProvider({
    macosHelper: {
      run: async () => ({
        exitCode: 1,
        stdout: JSON.stringify({
          ok: false,
          error: {
            message: 'no pressable accessibility element at the point',
            details: { reason: 'no-accessible-target', bundleId: 'com.apple.TextEdit' },
          },
        }),
        stderr: '',
      }),
    },
  });
  await assert.rejects(
    async () =>
      await withAppleToolProvider(provider, async () => await nativeOverrides().tap(1, 2)),
    (error: unknown) =>
      isNativeBackendRefusal(error) &&
      (error as AppError).details?.helperReason === 'no-accessible-target',
  );
});

test('sessions that name no app, and presses on other surfaces, keep their XCTest-backend owner', async () => {
  const reached: string[] = [];
  const noApp = withMacOsNativeAppBackend(runnerInteractor(reached), {});
  await noApp.type('hello');
  await noApp.scroll('down');
  const menubar = withMacOsNativeAppBackend(runnerInteractor(reached), context);
  await menubar.pressPoint!({ x: 1, y: 2 }, { ...primaryClick, surface: 'menubar' });
  assert.deepEqual(reached, ['type', 'scroll', 'pressPoint']);
});

const primaryClick = {
  button: 'primary',
  count: 1,
  intervalMs: 0,
  holdMs: 0,
  jitterPx: 0,
  doubleTap: false,
} as const;

const secondaryClick = {
  button: 'secondary',
  count: 1,
  intervalMs: 0,
  holdMs: 0,
  jitterPx: 0,
  doubleTap: false,
} as const;

function isNativeBackendRefusal(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'UNSUPPORTED_OPERATION' &&
    error.details?.reason === MACOS_NATIVE_BACKEND_UNSUPPORTED
  );
}
