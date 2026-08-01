import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';
import { runMacOsSnapshotAction } from './helper.ts';

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
