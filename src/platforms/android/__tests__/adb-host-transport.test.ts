import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { runAndroidHostAdb, withAndroidHostAdbTransport } from '../adb-host-transport.ts';
import {
  withCommandExecutorOverride,
  type CommandExecutorOverride,
  type ExecOptions,
  type ExecResult,
} from '../../../utils/exec.ts';

type RecordedExecCall = Readonly<{
  cmd: string;
  args: string[];
  options: ExecOptions;
}>;

// Proves routing through the local runCmd arm without spawning a real adb:
// an installed command-executor override observes exactly what runCmd is asked
// to execute (the same driver style as utils exec boundary tests).
function recordingExecOverride(stdout = 'override'): {
  override: CommandExecutorOverride;
  calls: RecordedExecCall[];
} {
  const calls: RecordedExecCall[] = [];
  return {
    calls,
    override: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return Promise.resolve({ stdout, stderr: '', exitCode: 0 });
    },
  };
}

test('an installed transport intercepts host adb without reaching the exec layer', async () => {
  const driver = recordingExecOverride();
  const seen: Array<{ args: string[]; options?: ExecOptions }> = [];

  const result = await withAndroidHostAdbTransport(
    async (args, options) => {
      seen.push({ args, ...(options ? { options } : {}) });
      return { stdout: 'transport', stderr: '', exitCode: 0 };
    },
    async () =>
      await withCommandExecutorOverride(
        driver.override,
        async () => await runAndroidHostAdb(['devices'], { timeoutMs: 1_234 }),
      ),
  );

  assert.deepEqual(result, { stdout: 'transport', stderr: '', exitCode: 0 });
  assert.deepEqual(seen, [{ args: ['devices'], options: { timeoutMs: 1_234 } }]);
  assert.deepEqual(driver.calls, []);
});

test('without a transport host adb falls back to local runCmd with argv and options intact', async () => {
  const driver = recordingExecOverride();
  const options = { allowFailure: true, timeoutMs: 5_000 } as const;
  const args = ['-s', 'emulator-5554', 'shell', 'getprop', 'sys.boot_completed'];

  const result = await withCommandExecutorOverride(
    driver.override,
    async () => await runAndroidHostAdb(args, options),
  );

  assert.equal(result.stdout, 'override');
  assert.deepEqual(driver.calls, [{ cmd: 'adb', args, options }]);
});

test('transport results and errors pass through with their ExecResult shape', async () => {
  // Nonzero results only pass through under allowFailure; the throw contract
  // has its own tests below.
  const scripted: ExecResult = { stdout: '', stderr: 'boom', exitCode: 7 };
  const result = await withAndroidHostAdbTransport(
    async () => scripted,
    async () => await runAndroidHostAdb(['devices'], { allowFailure: true }),
  );
  assert.deepEqual(result, scripted);

  // SDK-supplied transports cross an unchecked boundary; malformed fields
  // normalize once here like every other exec callback in the repo.
  const sloppy = { stdout: undefined, stderr: null, exitCode: '1' } as unknown as ExecResult;
  const coerced = await withAndroidHostAdbTransport(
    async () => sloppy,
    async () => await runAndroidHostAdb(['devices'], { allowFailure: true }),
  );
  assert.deepEqual(coerced, { stdout: '', stderr: '', exitCode: 1 });

  const failure = new AppError('COMMAND_FAILED', 'tunnel closed');
  await assert.rejects(
    withAndroidHostAdbTransport(
      async () => {
        throw failure;
      },
      async () => await runAndroidHostAdb(['devices']),
    ),
    (error: unknown) => error === failure,
  );
});

test('a transport nonzero exit without allowFailure throws the classified adb failure', async () => {
  const error = await withAndroidHostAdbTransport(
    async () => ({ stdout: '', stderr: 'error: device offline', exitCode: 1 }),
    async () =>
      await runAndroidHostAdb(['devices']).then(
        () => assert.fail('expected the host adb call to reject'),
        (err: unknown) => err,
      ),
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.message, 'adb devices exited with code 1');
  assert.equal(error.details?.adbFailure, 'device_offline');
  assert.equal(error.details?.retriable, true);
  assert.match(String(error.details?.hint), /adb reconnect/i);
  assert.equal(error.details?.stderr, 'error: device offline');
});

test('a transport nonzero exit with allowFailure returns the result untouched', async () => {
  const scripted: ExecResult = { stdout: '', stderr: 'error: device offline', exitCode: 1 };

  const result = await withAndroidHostAdbTransport(
    async () => scripted,
    async () => await runAndroidHostAdb(['devices'], { allowFailure: true }),
  );

  assert.deepEqual(result, scripted);
});

test('nested transport scopes compose innermost-wins and restore on scope end', async () => {
  const calls: string[] = [];
  const transportFor = (name: string) => async () => {
    calls.push(name);
    return { stdout: name, stderr: '', exitCode: 0 };
  };

  await withAndroidHostAdbTransport(transportFor('outer'), async () => {
    assert.equal((await runAndroidHostAdb(['devices'])).stdout, 'outer');
    await withAndroidHostAdbTransport(transportFor('inner'), async () => {
      assert.equal((await runAndroidHostAdb(['devices'])).stdout, 'inner');
    });
    assert.equal((await runAndroidHostAdb(['devices'])).stdout, 'outer');
  });

  const driver = recordingExecOverride();
  await withCommandExecutorOverride(driver.override, async () => {
    assert.equal((await runAndroidHostAdb(['devices'])).stdout, 'override');
  });
  assert.deepEqual(calls, ['outer', 'inner', 'outer']);
  assert.equal(driver.calls.length, 1);
});
