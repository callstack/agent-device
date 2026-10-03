import { expect, test } from 'vitest';
import { macOsHelperSurface } from '@agent-device/contracts/session';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../../core/tool-provider.ts';
import { captureMacOsSurfaceSnapshot } from './surface-snapshot.ts';

test('an app snapshot carries the helper warning that web content may be missing', async () => {
  const warning = "The app's Chromium accessibility tree did not populate.";
  const calls: string[][] = [];
  const provider = createLocalAppleToolProvider({
    macosHelper: {
      run: async (args) => {
        calls.push([...args]);
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            data: {
              surface: 'app',
              nodes: [],
              truncated: false,
              backend: 'macos-helper',
              warnings: [warning],
            },
          }),
          stderr: '',
        };
      },
    },
  });
  const result = await withAppleToolProvider(
    provider,
    async () =>
      await captureMacOsSurfaceSnapshot({
        surface: macOsHelperSurface('app', 'native')!,
        appBundleId: 'com.openai.codex',
      }),
  );
  expect(calls).toEqual([['snapshot', '--surface', 'app', '--bundle-id', 'com.openai.codex']]);
  expect(result.warnings).toEqual([warning]);
});
