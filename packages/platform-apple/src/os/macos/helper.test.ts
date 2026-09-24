import assert from 'node:assert/strict';
import { test } from 'vitest';
import { macOsHelperSurface } from '@agent-device/contracts/session';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';
import {
  macOsClickScheduleMs,
  runMacOsPressAction,
  runMacOsReadTextAction,
  runMacOsScreenshotAction,
  runMacOsSnapshotAction,
} from './helper.ts';

const desktop = macOsHelperSurface('desktop')!;
const menubar = macOsHelperSurface('menubar')!;
const frontmostApp = macOsHelperSurface('frontmost-app')!;

test('macOS helper snapshot passes cancellation to the helper process', async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const provider = createLocalAppleToolProvider({
    macosHelper: {
      run: async (_args, options) => {
        receivedSignal = options?.signal;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              surface: 'desktop',
              nodes: [],
              truncated: false,
              backend: 'macos-helper',
            },
          }),
          stderr: '',
        };
      },
    },
  });

  await withAppleToolProvider(
    provider,
    async () => await runMacOsSnapshotAction(desktop, { signal: controller.signal }),
  );

  assert.equal(receivedSignal, controller.signal);
});

function helperReturn(data: Record<string, unknown>) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({ ok: true, data }),
    stderr: '',
  };
}

test('macOS helper press carries the hold, repeat count, and interval to the click schedule', async () => {
  let receivedArgs: string[] = [];
  const provider = createLocalAppleToolProvider({
    macosHelper: {
      run: async (args) => {
        receivedArgs = args;
        return helperReturn({ x: 12, y: 34, holdMs: 800, clicks: 2 });
      },
    },
  });

  const result = await withAppleToolProvider(
    provider,
    async () =>
      await runMacOsPressAction(12, 34, {
        surface: menubar,
        bundleId: 'com.example.Menu',
        holdMs: 800,
        clicks: 2,
        intervalMs: 140,
      }),
  );

  assert.deepEqual(
    [
      receivedArgs.slice(receivedArgs.indexOf('--hold-ms'), receivedArgs.indexOf('--hold-ms') + 2),
      receivedArgs.slice(receivedArgs.indexOf('--clicks'), receivedArgs.indexOf('--clicks') + 2),
      receivedArgs.slice(
        receivedArgs.indexOf('--interval-ms'),
        receivedArgs.indexOf('--interval-ms') + 2,
      ),
    ],
    [
      ['--hold-ms', '800'],
      ['--clicks', '2'],
      ['--interval-ms', '140'],
    ],
  );
  // The helper reports the hold it delivered, which the caller republishes as the
  // press's hold so a clamped request cannot read back as the requested one.
  assert.equal(result.holdMs, 800);
});

test('macOS helper press carries an explicit zero interval instead of dropping it', async () => {
  let receivedArgs: string[] = [];
  const provider = createLocalAppleToolProvider({
    macosHelper: {
      run: async (args) => {
        receivedArgs = args;
        return helperReturn({ x: 7, y: 8, holdMs: 60, clicks: 2 });
      },
    },
  });

  await withAppleToolProvider(
    provider,
    async () => await runMacOsPressAction(7, 8, { surface: desktop, clicks: 2, intervalMs: 0 }),
  );

  assert.ok(receivedArgs.includes('--clicks'), receivedArgs.join(' '));
  assert.deepEqual(
    receivedArgs.slice(
      receivedArgs.indexOf('--interval-ms'),
      receivedArgs.indexOf('--interval-ms') + 2,
    ),
    ['--interval-ms', '0'],
  );
});

test('macOS helper press keeps repeats independent and names a double-click explicitly', async () => {
  let receivedArgs: string[] = [];
  const provider = createLocalAppleToolProvider({
    macosHelper: {
      run: async (args) => {
        receivedArgs = args;
        return helperReturn({ x: 7, y: 8, holdMs: 60, clicks: 3, doubleClick: true });
      },
    },
  });

  await withAppleToolProvider(
    provider,
    async () =>
      await runMacOsPressAction(7, 8, { surface: frontmostApp, clicks: 3, doubleClick: true }),
  );

  // `--count 3 --double-tap` is three double-clicks: the count stays the press count and the
  // rising click state is a separate flag, never derived from the count.
  assert.deepEqual(
    receivedArgs.slice(receivedArgs.indexOf('--clicks'), receivedArgs.indexOf('--clicks') + 2),
    ['--clicks', '3'],
  );
  assert.ok(receivedArgs.includes('--double-click'), receivedArgs.join(' '));
});

test('macOS helper press outlives its own click schedule and forwards cancellation', async () => {
  let receivedTimeoutMs: number | undefined;
  let receivedSignal: AbortSignal | undefined;
  let receivedKill: { signal: string; graceMs: number } | undefined;
  const controller = new AbortController();
  const provider = createLocalAppleToolProvider({
    macosHelper: {
      run: async (_args, options) => {
        receivedTimeoutMs = options?.timeoutMs;
        receivedSignal = options?.signal;
        receivedKill = options?.kill;
        return helperReturn({ x: 1, y: 2, holdMs: 10_000, clicks: 4 });
      },
    },
  });

  await withAppleToolProvider(
    provider,
    async () =>
      await runMacOsPressAction(1, 2, {
        surface: desktop,
        holdMs: 10_000,
        clicks: 4,
        intervalMs: 120,
        signal: controller.signal,
      }),
  );

  // Four ten-second holds are 40.36s of schedule; a fixed 30s timeout would kill the helper
  // inside the third hold with the button down.
  const scheduleMs = macOsClickScheduleMs({ holdMs: 10_000, clicks: 4, intervalMs: 120 });
  assert.equal(scheduleMs, 40_360);
  assert.equal(receivedTimeoutMs, scheduleMs + 30_000);
  assert.equal(receivedSignal, controller.signal);
  // The host stops the helper with SIGKILL on both routes, and a helper killed between a
  // mouse-down and its mouse-up leaves the button stuck. The helper's release handler only
  // runs if the stop reaches it as a catchable signal first.
  assert.deepEqual(receivedKill, { signal: 'SIGTERM', graceMs: 1_000 });
});

test('macOS click schedule mirrors the helper floors for the timeout it derives', () => {
  assert.equal(macOsClickScheduleMs({}), 60);
  assert.equal(macOsClickScheduleMs({ holdMs: 5 }), 40);
  assert.equal(
    macOsClickScheduleMs({ clicks: 2, doubleClick: true, intervalMs: 100 }),
    4 * 60 + 2 * 80 + 100,
  );
});

test('macOS helper press stays a single held click when nothing is repeated', async () => {
  let receivedArgs: string[] = [];
  const provider = createLocalAppleToolProvider({
    macosHelper: {
      run: async (args) => {
        receivedArgs = args;
        return helperReturn({ x: 5, y: 6, holdMs: 60, clicks: 1 });
      },
    },
  });

  await withAppleToolProvider(
    provider,
    async () => await runMacOsPressAction(5, 6, { surface: frontmostApp }),
  );

  assert.equal(receivedArgs.includes('--clicks'), false);
  assert.equal(receivedArgs.includes('--hold-ms'), false);
  assert.equal(receivedArgs.includes('--interval-ms'), false);
});

test('macOS helper screenshot argv carries only --out and --surface', async () => {
  let receivedArgs: string[] = [];
  const provider = createLocalAppleToolProvider({
    macosHelper: {
      run: async (args) => {
        receivedArgs = args;
        return helperReturn({ path: '/tmp/out.png', surface: 'desktop' });
      },
    },
  });

  await withAppleToolProvider(
    provider,
    async () => await runMacOsScreenshotAction('/tmp/out.png', { surface: desktop }),
  );

  assert.deepEqual(receivedArgs, ['screenshot', '--out', '/tmp/out.png', '--surface', 'desktop']);
});

test('helper entry points accept only an owner-routed surface', () => {
  // Never invoked: each directive fails typecheck once its entry point widens back to an
  // unbranded or optional surface.
  const widenedCalls = async (out: string) => {
    // @ts-expect-error a bare literal skips the routing owner
    await runMacOsSnapshotAction('desktop');
    // @ts-expect-error a bare literal skips the routing owner
    await runMacOsScreenshotAction(out, { surface: 'menubar' });
    // @ts-expect-error the surface is required
    await runMacOsReadTextAction(1, 2, { bundleId: 'com.example' });
    // @ts-expect-error the surface is required
    await runMacOsPressAction(1, 2, {});
    // @ts-expect-error the surface is required
    await runMacOsScreenshotAction(out);
  };
  assert.equal(typeof widenedCalls, 'function');
});
