import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import type { ProviderAndroidHost, ProviderHostCapabilities } from '@agent-device/plugins/host';
import {
  androidAdbHostTarget,
  androidAdbInvocation,
} from '@agent-device/platform-android/mechanics';
import { createLimrunRuntimeDependencies } from './limrun-runtime-dependencies.ts';

const device = {
  platform: 'android' as const,
  id: 'limrun:android:lease-capabilities',
  name: 'Limrun Android',
  kind: 'emulator' as const,
  target: 'mobile' as const,
  booted: true,
};

type Call = { name: string; args: unknown[] };

function recordingAndroid(calls: Call[]): ProviderAndroidHost {
  const record =
    (name: string) =>
    async (...args: unknown[]): Promise<never> => {
      calls.push({ name, args });
      throw new Error(`captured:${name}`);
    };
  return {
    runAdb: record('runAdb') as ProviderAndroidHost['runAdb'],
    adbError: record('adbError') as ProviderAndroidHost['adbError'],
    withAdbProvider: record('withAdbProvider') as ProviderAndroidHost['withAdbProvider'],
    runShell: record('runShell') as ProviderAndroidHost['runShell'],
    createPortReverse: record('createPortReverse') as ProviderAndroidHost['createPortReverse'],
    listApps: record('listApps') as ProviderAndroidHost['listApps'],
    readLogs: record('readLogs') as ProviderAndroidHost['readLogs'],
    keyboardState: record('keyboardState') as ProviderAndroidHost['keyboardState'],
    dismissKeyboard: record('dismissKeyboard') as ProviderAndroidHost['dismissKeyboard'],
  };
}

async function captured(task: () => Promise<unknown>): Promise<Call> {
  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /^captured:/);
    return { name: message.slice('captured:'.length), args: [] };
  }
  throw new Error('the capability boundary was not reached');
}

test('the Android adapter serves shared operations through the host capabilities', async () => {
  const calls: Call[] = [];
  const capabilities: ProviderHostCapabilities = { android: recordingAndroid(calls) };
  const dependencies = createLimrunRuntimeDependencies(
    { env: process.env, cwd: process.cwd() },
    capabilities,
  );
  const adb = async () => ({ exitCode: 0, stdout: '', stderr: '' });

  await captured(() => dependencies.host.runAdb(androidAdbInvocation(androidAdbHostTarget(), [])));
  assert.equal(calls.at(-1)?.name, 'runAdb');
  await captured(() => dependencies.android.listApps(adb, 'all'));
  assert.equal(calls.at(-1)?.name, 'listApps');
  await captured(() => dependencies.android.readLogs(adb, 10));
  assert.equal(calls.at(-1)?.name, 'readLogs');
  assert.deepEqual(calls.at(-1)?.args[1], { lines: 10, timeoutMs: 5_000 });
  await captured(() => dependencies.android.getKeyboardState(adb));
  assert.equal(calls.at(-1)?.name, 'keyboardState');
  await captured(() => dependencies.android.dismissKeyboard(adb));
  assert.equal(calls.at(-1)?.name, 'dismissKeyboard');
  await captured(() => dependencies.android.forceStopApp(adb, 'com.example.app'));
  assert.equal(calls.at(-1)?.name, 'runShell');
  assert.deepEqual(calls.at(-1)?.args[1], ['am', 'force-stop', 'com.example.app']);
  // The adapter hands the capability plain words; the capability owns the device-shell quoting.
  await captured(() =>
    dependencies.android.createPortReverse(adb, { noRebind: true }).then(() => {}),
  );
  assert.equal(calls.at(-1)?.name, 'createPortReverse');
  await captured(() =>
    dependencies.android.adbError('failed', { exitCode: 1, stdout: '', stderr: 'x' }),
  );
  assert.equal(calls.at(-1)?.name, 'adbError');
  // The provider still owns its own addressing builders.
  assert.deepEqual(
    dependencies.android.deviceAdbInvocation('127.0.0.1:62001', ['get-state']).command,
    ['get-state'],
  );
});

test('a binary stdout answer from the capabilities reaches the provider as a buffer', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const capabilities: ProviderHostCapabilities = {
    android: {
      ...recordingAndroid([]),
      runAdb: async () => ({ exitCode: 0, stdout: '', stderr: '', stdoutBuffer: png }),
    },
  };
  const dependencies = createLimrunRuntimeDependencies(
    { env: process.env, cwd: process.cwd() },
    capabilities,
  );
  const result = await dependencies.host.runAdb(
    androidAdbInvocation(androidAdbHostTarget(), ['exec-out', 'screencap', '-p']),
    { binaryStdout: true },
  );
  // The provider's own contract reads the binary answer as a Node buffer, and the platform's bytes
  // reach it whole: this is the call path `adb exec-out` capture takes through the boundary.
  assert.ok(Buffer.isBuffer(result.stdoutBuffer));
  assert.deepEqual([...result.stdoutBuffer!], [...png]);
});

test('execution options the capabilities hand back reach this adapter executors as buffers', async () => {
  const payload = new Uint8Array([0x70, 0x69, 0x70, 0x65]);
  const seen: unknown[] = [];
  const capabilities: ProviderHostCapabilities = {
    android: {
      ...recordingAndroid([]),
      runShell: async (adb, words, options) => {
        // A capability that pipes a payload through the shell hands the executor the contract's own
        // byte array; this adapter's executors take a Node buffer.
        await adb(words.map(String), { ...options, stdin: payload });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  };
  const dependencies = createLimrunRuntimeDependencies(
    { env: process.env, cwd: process.cwd() },
    capabilities,
  );
  await dependencies.android.forceStopApp(async (_args, options) => {
    seen.push(options?.stdin);
    return { exitCode: 0, stdout: '', stderr: '' };
  }, 'com.example.app');
  assert.ok(Buffer.isBuffer(seen[0]));
  assert.deepEqual([...(seen[0] as Buffer)], [...payload]);
});

test('without capabilities the adapter keeps its own lazy platform edges', async () => {
  const dependencies = createLimrunRuntimeDependencies({ env: process.env, cwd: process.cwd() });
  const seen: string[][] = [];
  const { withAndroidHostAdbTransport } = await import('@agent-device/platform-android/mechanics');
  const result = await withAndroidHostAdbTransport(
    async (invocation) => {
      seen.push(invocation.command as string[]);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
    async () =>
      await dependencies.host.runAdb(androidAdbInvocation(androidAdbHostTarget(), ['devices'])),
  );
  assert.deepEqual(result, { stdout: 'ok', stderr: '', exitCode: 0 });
  assert.deepEqual(seen, [['devices']]);
});

test('the iOS runner receives the Apple facet tools when one is supplied', async () => {
  const runnerModule = '../core/interactors/limrun-ios-runner.ts';
  const received: unknown[] = [];
  vi.doMock(runnerModule, () => ({
    createLimrunIosRunner: async (_session: unknown, _host: unknown, tools: unknown) => {
      received.push(tools);
      throw new Error('runner creation is not exercised here');
    },
  }));
  const { createLimrunRuntimeDependencies: create } =
    await import('./limrun-runtime-dependencies.ts');
  const appleTools = { marker: 'capability-apple-tools' };
  const dependencies = create(
    { env: process.env, cwd: process.cwd() },
    { apple: { applicationTools: appleTools as never } },
  );
  await expect(
    dependencies.ios.createRunner({
      client: {} as never,
      apiUrl: 'https://instance.test',
      token: 'token',
      device,
    }),
  ).rejects.toThrow('runner creation is not exercised here');
  assert.deepEqual(received, [appleTools]);
  vi.doUnmock(runnerModule);
});
