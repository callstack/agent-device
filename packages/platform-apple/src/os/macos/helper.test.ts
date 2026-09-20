import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';
import { runMacOsPressAction, runMacOsSnapshotAction } from './helper.ts';

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
    async () => await runMacOsSnapshotAction('desktop', { signal: controller.signal }),
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
        surface: 'menubar',
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

test('macOS helper press leaves the repeat gap to the click schedule by default', async () => {
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
    async () => await runMacOsPressAction(7, 8, { surface: 'desktop', clicks: 2, intervalMs: 0 }),
  );

  assert.ok(receivedArgs.includes('--clicks'), receivedArgs.join(' '));
  assert.equal(receivedArgs.includes('--interval-ms'), false);
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
    async () => await runMacOsPressAction(5, 6, { surface: 'frontmost-app' }),
  );

  assert.equal(receivedArgs.includes('--clicks'), false);
  assert.equal(receivedArgs.includes('--hold-ms'), false);
  assert.equal(receivedArgs.includes('--interval-ms'), false);
});
