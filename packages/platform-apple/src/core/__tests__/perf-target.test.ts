import { test } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { IOS_DEVICE } from '../../__tests__/device-fixtures.ts';
import { parseApplePsOutput, resolveIosDevicePerfTarget } from '../perf-target.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';

test('parseApplePsOutput reads pid cpu rss and command columns', () => {
  const rows = parseApplePsOutput(
    ['123 12.5 45678 /Applications/Test.app/Contents/MacOS/Test --flag', '456 0.0 2048 Test'].join(
      '\n',
    ),
  );

  assert.deepEqual(rows, [
    {
      pid: 123,
      cpuPercent: 12.5,
      rssKb: 45678,
      command: '/Applications/Test.app/Contents/MacOS/Test --flag',
    },
    {
      pid: 456,
      cpuPercent: 0,
      rssKb: 2048,
      command: 'Test',
    },
  ]);
});

test('resolveIosDevicePerfTarget skips nested extensions and other installed copies', async () => {
  const containers = 'file:///private/var/containers/Bundle/Application';
  const appUrl = `${containers}/DEV/App.app/`;
  const provider = createLocalAppleToolProvider({
    devicectl: {
      run: async (args) => {
        const result =
          args[2] === 'apps'
            ? { apps: [{ bundleIdentifier: 'com.example.app-dev', name: 'App', url: appUrl }] }
            : {
                runningProcesses: [
                  { executable: `${containers}/PROD/App.app/App`, processIdentifier: 10089 },
                  {
                    executable: `${appUrl}PlugIns/LiveActivityExtension.appex/LiveActivityExtension`,
                    processIdentifier: 10844,
                  },
                  { executable: `${appUrl}App`, processIdentifier: 10870 },
                ],
              };
        const outputPath = args[args.indexOf('--json-output') + 1]!;
        await fs.writeFile(outputPath, JSON.stringify({ result }), 'utf8');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  });

  const processes = await withAppleToolProvider(provider, () =>
    resolveIosDevicePerfTarget(IOS_DEVICE, 'com.example.app-dev'),
  );

  assert.deepEqual(processes, [{ executable: `${appUrl}App`, pid: 10870 }]);
});
