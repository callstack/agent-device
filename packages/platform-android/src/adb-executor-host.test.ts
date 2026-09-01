import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { runAndroidHostAdb, withAndroidHostAdbTransport } from './adb-executor.ts';

test('a scoped transport intercepts host adb without reaching the injected host', async () => {
  let hostCalls = 0;
  bindAndroidAdbHostStub({
    execHostAdb: async () => {
      hostCalls += 1;
      return { stdout: 'host', stderr: '', exitCode: 0 };
    },
  });

  const result = await withAndroidHostAdbTransport(
    async (args, options) => {
      assert.deepEqual(args, ['devices']);
      assert.deepEqual(options, { timeoutMs: 1_234 });
      return { stdout: 'transport', stderr: '', exitCode: 0 };
    },
    async () => await runAndroidHostAdb(['devices'], { timeoutMs: 1_234 }),
  );

  assert.equal(result.stdout, 'transport');
  assert.equal(hostCalls, 0);
});

test('the local host arm always obtains a result before applying the shared failure contract', async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  bindAndroidAdbHostStub({
    execHostAdb: async (_args, options) => {
      receivedOptions = options;
      return { stdout: '', stderr: 'error: device offline', exitCode: 1 };
    },
  });

  const error = await runAndroidHostAdb(['devices']).then(
    () => assert.fail('expected the host adb call to reject'),
    (error: unknown) => error,
  );

  assert.deepEqual(receivedOptions, { allowFailure: true });
  assert.ok(error instanceof AppError);
  assert.equal(error.details?.adbFailure, 'device_offline');
  assert.equal(error.details?.retriable, true);
  assert.match(String(error.details?.hint), /adb reconnect/i);
});

test('allowFailure returns a nonzero local result unchanged', async () => {
  const scripted = { stdout: '', stderr: 'offline', exitCode: 7 };
  bindAndroidAdbHostStub({ execHostAdb: async () => scripted });

  assert.deepEqual(
    await runAndroidHostAdb(['devices'], { allowFailure: true, timeoutMs: 5_000 }),
    scripted,
  );
});

test('unchecked transport results are normalized at the package boundary', async () => {
  bindAndroidAdbHostStub({
    coerceAdbResult: (result) => ({
      ...result,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      exitCode: Number(result.exitCode),
    }),
  });
  const sloppy = { stdout: undefined, stderr: null, exitCode: '1' } as never;

  const result = await withAndroidHostAdbTransport(
    async () => sloppy,
    async () => await runAndroidHostAdb(['devices'], { allowFailure: true }),
  );

  assert.deepEqual(result, { stdout: '', stderr: '', exitCode: 1 });
});

test('nested transport scopes are innermost-first and restore on scope exit', async () => {
  bindAndroidAdbHostStub({
    execHostAdb: async () => ({ stdout: 'host', stderr: '', exitCode: 0 }),
  });
  const transportFor = (name: string) => async () => ({
    stdout: name,
    stderr: '',
    exitCode: 0,
  });

  await withAndroidHostAdbTransport(transportFor('outer'), async () => {
    assert.equal((await runAndroidHostAdb(['devices'])).stdout, 'outer');
    await withAndroidHostAdbTransport(transportFor('inner'), async () => {
      assert.equal((await runAndroidHostAdb(['devices'])).stdout, 'inner');
    });
    assert.equal((await runAndroidHostAdb(['devices'])).stdout, 'outer');
  });
  assert.equal((await runAndroidHostAdb(['devices'])).stdout, 'host');
});
