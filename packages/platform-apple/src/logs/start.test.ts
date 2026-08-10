import { localRuntimeOwner } from '@agent-device/contracts/platform';
import { expect, test, vi } from 'vitest';
import { startAppleAppLogs } from './start.ts';
import { appleDevice, hostFixture } from './runtime.fixtures.ts';

test('simulator start resolves its app container through appleTools and keeps plutil generic', async () => {
  const appleToolRun = vi.fn(async () => ({
    stdout: '/tmp/Example.app\n',
    stderr: '',
    exitCode: 0,
  }));
  const commandRun = vi.fn(async (request) => {
    if (request.executable === 'xcrun') throw new Error('raw foreground xcrun must not run');
    return { stdout: 'Example\n', stderr: '', exitCode: 0 };
  });
  const fixture = hostFixture({ appleToolRun, commandRun, failProcessStart: true });

  await expect(
    startAppleAppLogs(
      fixture.host,
      appleDevice(),
      {
        sessionId: 'session',
        appBundleId: 'com.example.app',
        outputPath: '/tmp/app.log',
        fence: { token: 'fence', generation: 1 },
      },
      localRuntimeOwner('apple'),
    ),
  ).rejects.toThrow('start failed');

  expect(appleToolRun).toHaveBeenCalledWith(
    {
      tool: 'simctl',
      args: ['get_app_container', 'apple-1', 'com.example.app', 'app'],
      allowFailure: true,
      timeoutMs: 4_000,
    },
    undefined,
  );
  expect(commandRun).toHaveBeenCalledWith(
    {
      executable: 'plutil',
      args: ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', '/tmp/Example.app/Info.plist'],
      allowFailure: true,
      timeoutMs: 4_000,
    },
    undefined,
  );
  expect(fixture.backgroundCommands[0]?.slice(0, 5)).toEqual([
    'xcrun',
    'simctl',
    'spawn',
    'apple-1',
    'log',
  ]);
});
