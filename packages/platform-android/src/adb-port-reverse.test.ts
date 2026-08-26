import { expect, test } from 'vitest';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { createAndroidPortReverseManager } from './adb-port-reverse.ts';
import type { AndroidAdbExecutorResult, AndroidPortReverseProvider } from './adb-transport.ts';

const ok = (stdout = ''): AndroidAdbExecutorResult => ({ exitCode: 0, stdout, stderr: '' });

test('the manager enforces per-owner mapping ownership and dedupes identical ensures', async () => {
  bindAndroidAdbHostStub();
  const calls: string[][] = [];
  const manager = createAndroidPortReverseManager(async (args) => {
    calls.push(args);
    return ok();
  });

  await manager.ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'a' });
  // Same owner, same remote: no second adb call.
  await manager.ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'a' });
  expect(calls).toEqual([['reverse', 'tcp:8081', 'tcp:8081']]);

  await expect(
    manager.ensure({ local: 'tcp:8081', remote: 'tcp:9090', ownerId: 'b' }),
  ).rejects.toThrow(/already owned by a/);

  await manager.removeAllOwned('a');
  expect(calls.at(-1)).toEqual(['reverse', '--remove', 'tcp:8081']);
});

test('remove tolerates an already-missing listener but rethrows real failures', async () => {
  bindAndroidAdbHostStub();
  let result: AndroidAdbExecutorResult = {
    exitCode: 1,
    stdout: '',
    stderr: 'listener tcp:8081 not found',
  };
  const manager = createAndroidPortReverseManager(async () => result);

  await expect(manager.remove('tcp:8081')).resolves.toBeUndefined();

  result = { exitCode: 1, stdout: '', stderr: 'error: device offline' };
  await expect(manager.remove('tcp:8081')).rejects.toThrow(/Failed to remove Android port reverse/);
});

test('list parses adb reverse --list output and attributes owners', async () => {
  bindAndroidAdbHostStub();
  const manager = createAndroidPortReverseManager(async (args) =>
    args[1] === '--list'
      ? ok('HOST-1 tcp:8081 tcp:8081\nHOST-1 localabstract:sock tcp:9090\n')
      : ok(),
  );
  await manager.ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'session-a' });

  expect(await manager.list?.()).toEqual([
    { local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'session-a' },
    { local: 'localabstract:sock', remote: 'tcp:9090', ownerId: undefined },
  ]);
});

test('a provider-owned reverse implementation is reused as-is when already managed', async () => {
  bindAndroidAdbHostStub();
  const reverse: AndroidPortReverseProvider = {
    ensure: async () => {},
    remove: async () => {},
    removeAllOwned: async () => {},
  };
  const first = createAndroidPortReverseManager({ exec: async () => ok(), reverse });
  const second = createAndroidPortReverseManager({ exec: async () => ok(), reverse: first });
  expect(second).toBe(first);
});
