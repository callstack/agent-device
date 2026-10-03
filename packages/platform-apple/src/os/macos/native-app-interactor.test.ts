import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';
import { macOsNativeAppInteractor } from './native-app-interactor.ts';

const context: RunnerContext = { appBundleId: 'com.apple.TextEdit' };

/** The XCTest-backed interactor the native one draws from; any member it calls is recorded. */
function runnerInteractor(reached: string[] = []): Interactor {
  return new Proxy({} as Interactor, {
    get: (_target, member) => async () => {
      reached.push(String(member));
      return {};
    },
  });
}

function nativeInteractor(ctx: RunnerContext = context, reached: string[] = []): Interactor {
  return macOsNativeAppInteractor(runnerInteractor(reached), ctx);
}

async function recordHelperCalls(
  data: Record<string, unknown>,
  run: (interactor: Interactor) => Promise<unknown>,
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
    async () => await run(nativeInteractor(context, reachedRunner)),
  );
  // Served through the helper alone: the XCTest-backed interactor never ran.
  assert.deepEqual(reachedRunner, []);
  return { calls, result };
}

test('a native tap presses the app surface and reports the mechanism', async () => {
  const { calls, result } = await recordHelperCalls(
    { x: 10, y: 20, mechanism: 'ax-press', windowTitle: 'Untitled' },
    async (interactor) => await interactor.tap(10, 20),
  );
  assert.deepEqual(calls, [
    ['press', '--x', '10', '--y', '20', '--bundle-id', 'com.apple.TextEdit', '--surface', 'app'],
  ]);
  assert.deepEqual(result, { mechanism: 'ax-press', windowTitle: 'Untitled' });
});

test('native type and fill address the session app, not the frontmost one', async () => {
  const { calls } = await recordHelperCalls({ mechanism: 'ax-value' }, async (interactor) => {
    await interactor.type('hello');
    await interactor.fill(5, 6, 'world');
  });
  assert.deepEqual(calls, [
    ['type', '--text', 'hello', '--bundle-id', 'com.apple.TextEdit'],
    ['fill', '--x', '5', '--y', '6', '--text', 'world', '--bundle-id', 'com.apple.TextEdit'],
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
    async (interactor) => await interactor.scroll('down', { pixels: 300 }),
  );
  assert.deepEqual(calls, [
    ['scroll', '--direction', 'down', '--pixels', '300', '--bundle-id', 'com.apple.TextEdit'],
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

test('runner-only members refuse with the backend reason instead of starting XCTest', async () => {
  const reached: string[] = [];
  const interactor = nativeInteractor(context, reached);
  for (const refused of [
    () => interactor.back(),
    () => interactor.setOrientation('portrait'),
    () => interactor.pressPoint!({ x: 1, y: 2 }, secondaryClick),
    () => interactor.pressPoint!({ x: 1, y: 2 }, { ...primaryClick, doubleTap: true }),
    () => interactor.pressPoint!({ x: 1, y: 2 }, { ...primaryClick, holdMs: 500 }),
    () => interactor.longPress(1, 2, 500),
  ]) {
    await assert.rejects(refused, isNativeBackendRefusal);
  }
  assert.equal(interactor.gestureViewport, undefined);
  assert.equal(interactor.doubleTap, undefined);
  assert.equal(interactor.findText, undefined);
  assert.deepEqual(reached, []);
});

test('an action without an app session refuses rather than falling back to the runner', async () => {
  const reached: string[] = [];
  const interactor = nativeInteractor({}, reached);
  await assert.rejects(() => interactor.type('hello'), isNativeBackendRefusal);
  await assert.rejects(() => interactor.scroll('down'), isNativeBackendRefusal);
  assert.deepEqual(reached, []);
});

test('a press on another surface stays with the helper press of that surface', async () => {
  const reached: string[] = [];
  await nativeInteractor(context, reached).pressPoint!(
    { x: 1, y: 2 },
    { ...primaryClick, surface: 'menubar' },
  );
  assert.deepEqual(reached, ['pressPoint']);
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
      await withAppleToolProvider(provider, async () => await nativeInteractor().tap(1, 2)),
    (error: unknown) =>
      isNativeBackendRefusal(error) &&
      (error as AppError).details?.helperReason === 'no-accessible-target',
  );
});

const primaryClick = {
  button: 'primary',
  count: 1,
  intervalMs: 0,
  holdMs: 0,
  jitterPx: 0,
  doubleTap: false,
} as const;

const secondaryClick = { ...primaryClick, button: 'secondary' } as const;

function isNativeBackendRefusal(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'UNSUPPORTED_OPERATION' &&
    error.details?.reason === 'unsupported-device-backend'
  );
}
