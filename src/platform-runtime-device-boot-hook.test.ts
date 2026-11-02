import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn(actual.runCmd) };
});

import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { IOS_SIMULATOR, mkdtempForTestSync } from '@agent-device/test-kit';
import { createDeviceBootHook } from './platform-runtime-device-boot-hook.ts';

function stateDirWithHook(hook: unknown): string {
  const stateDir = mkdtempForTestSync('agent-device-boot-hook-');
  if (hook !== undefined) {
    fs.writeFileSync(path.join(stateDir, 'boot-hook.json'), JSON.stringify(hook));
  }
  return stateDir;
}

test('without boot-hook.json in the state directory there is no hook to run', async () => {
  const stateDir = stateDirWithHook(undefined);
  const hook = createDeviceBootHook({ env: { AGENT_DEVICE_STATE_DIR: stateDir }, cwd: stateDir });

  await expect(hook.run(IOS_SIMULATOR)).resolves.toBeNull();
});

test('the hook runs in its cwd with the device in its environment, and reports its output', async () => {
  const stateDir = stateDirWithHook(undefined);
  const workspace = fs.realpathSync(mkdtempForTestSync('agent-device-boot-hook-cwd-'));
  const script = [
    'const env = process.env;',
    'console.log(JSON.stringify([process.cwd(), env.AGENT_DEVICE_BOOT_HOOK_PLATFORM, env.AGENT_DEVICE_BOOT_HOOK_DEVICE_ID, env.AGENT_DEVICE_BOOT_HOOK_DEVICE_NAME]));',
    'console.error("device is gone");',
    'process.exit(3);',
  ].join('\n');
  fs.writeFileSync(
    path.join(stateDir, 'boot-hook.json'),
    JSON.stringify({ command: [process.execPath, '-e', script], cwd: workspace }),
  );
  const hook = createDeviceBootHook({ env: { AGENT_DEVICE_STATE_DIR: stateDir }, cwd: stateDir });

  const run = await hook.run(IOS_SIMULATOR);

  expect(run).toMatchObject({ exitCode: 3, stderr: 'device is gone\n' });
  expect(JSON.parse(run?.stdout ?? '')).toEqual([
    workspace,
    'ios',
    IOS_SIMULATOR.id,
    IOS_SIMULATOR.name,
  ]);
});

test.each([
  ['an unknown key', { command: ['stim', 'revive'], timeoutMs: 1 }],
  ['an empty command', { command: [] }],
  ['a relative cwd', { command: ['stim', 'revive'], cwd: 'app' }],
])('a hook file with %s is refused as an invalid boot hook', async (_name, contents) => {
  const stateDir = stateDirWithHook(contents);
  const hook = createDeviceBootHook({ env: { AGENT_DEVICE_STATE_DIR: stateDir }, cwd: stateDir });

  await expect(hook.run(IOS_SIMULATOR)).rejects.toMatchObject({
    code: 'INVALID_ARGS',
    details: { reason: 'invalid_boot_hook' },
  });
});

test.each<[string, string | undefined, () => void, RegExp]>([
  ['cannot start', undefined, () => {}, /could not run from .*boot-hook\.json/],
  [
    'runs from a deleted directory',
    '/nonexistent/workspace',
    () => {},
    /its cwd \/nonexistent\/workspace does not exist/,
  ],
  [
    'runs past its limit',
    undefined,
    () =>
      vi.mocked(runCmd).mockRejectedValueOnce(
        new AppError('COMMAND_FAILED', 'stim timed out after 1000ms', {
          timeoutMs: 1000,
          stdout: '',
          stderr: 'still booting',
        }),
      ),
    /ran past its \d+ ms limit/,
  ],
])('a hook that %s is reported as a failed run', async (_name, cwd, arrange, failure) => {
  const stateDir = stateDirWithHook({
    command: ['agent-device-missing-boot-hook-binary'],
    ...(cwd ? { cwd } : {}),
  });
  const hook = createDeviceBootHook({ env: { AGENT_DEVICE_STATE_DIR: stateDir }, cwd: stateDir });
  arrange();

  const run = await hook.run(IOS_SIMULATOR, undefined, { deadlineAtMs: Date.now() + 1_000 });

  expect(run).toMatchObject({ exitCode: null, failure: expect.stringMatching(failure) });
});

test('the refusal names the hook and quotes its output, or why it did not finish', () => {
  const hook = createDeviceBootHook({ env: { AGENT_DEVICE_STATE_DIR: '/state' }, cwd: '/state' });
  const command = ['stim', 'revive', '--json'];

  const exited = hook.leftDeviceDown(
    { command, exitCode: 1, stdout: '{"code":"STIM_NO_METRO"}', stderr: '' },
    IOS_SIMULATOR,
  );
  const stopped = hook.leftDeviceDown(
    {
      command,
      exitCode: null,
      failure: 'ran past its 1000 ms limit and was stopped',
      stdout: '',
      stderr: '',
    },
    IOS_SIMULATOR,
  );

  expect(exited).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'boot_hook_left_device_down', hook: command, exitCode: 1 },
  });
  expect(exited.message).toMatch(/stim revive --json\) exited 1[\s\S]*STIM_NO_METRO/);
  expect(stopped.message).toContain('ran past its 1000 ms limit and was stopped');
});
