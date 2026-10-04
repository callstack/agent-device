import { expect, test } from 'vitest';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { createAndroidPortReverseManager } from './adb-port-reverse.ts';
import type { AndroidAdbExecutorResult, AndroidPortReverseProvider } from './adb-transport.ts';

const ok = (stdout = ''): AndroidAdbExecutorResult => ({ exitCode: 0, stdout, stderr: '' });

test('the manager enforces per-owner mapping ownership and dedupes identical ensures', async () => {
  bindAndroidAdbHostStub();
  const calls: (readonly string[])[] = [];
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

test('no-rebind refuses a device mapping another client owns with a typed reason', async () => {
  bindAndroidAdbHostStub();
  const calls: (readonly string[])[] = [];
  const manager = createAndroidPortReverseManager(
    async (args) => {
      calls.push(args);
      if (args.includes('--no-rebind')) {
        return { exitCode: 1, stdout: '', stderr: 'adb: error: cannot rebind existing socket' };
      }
      return ok(args[1] === '--list' ? 'owner-host tcp:8081 tcp:8081\n' : '');
    },
    { noRebind: true },
  );

  await expect(
    manager.ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'metro' }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'android_port_reverse_rebind_refused',
      existing: { local: 'tcp:8081', remote: 'tcp:8081' },
    },
  });
  await manager.removeAllOwned('metro');

  expect(calls).toEqual([
    ['reverse', '--no-rebind', 'tcp:8081', 'tcp:8081'],
    ['reverse', '--list'],
  ]);
});

test('no-rebind still rebinds a mapping the same provider created', async () => {
  bindAndroidAdbHostStub();
  const calls: (readonly string[])[] = [];
  const manager = createAndroidPortReverseManager(
    async (args) => {
      calls.push(args);
      return ok();
    },
    { noRebind: true },
  );

  await manager.ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'metro' });
  await manager.ensure({ local: 'tcp:8081', remote: 'tcp:9090', ownerId: 'metro' });

  expect(calls).toEqual([
    ['reverse', '--no-rebind', 'tcp:8081', 'tcp:8081'],
    ['reverse', 'tcp:8081', 'tcp:9090'],
  ]);
});

test('no-rebind reports an adb failure when the device lists no mapping for the endpoint', async () => {
  bindAndroidAdbHostStub();
  const manager = createAndroidPortReverseManager(
    async (args) =>
      args.includes('--no-rebind')
        ? { exitCode: 1, stdout: '', stderr: 'error: device offline' }
        : ok(),
    { noRebind: true },
  );

  const failure = await manager
    .ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'metro' })
    .then(
      () => undefined,
      (error: unknown) => error,
    );

  expect(failure).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { adbFailure: 'device_offline' },
  });
  expect(failure).not.toMatchObject({ details: { reason: 'android_port_reverse_rebind_refused' } });
});
