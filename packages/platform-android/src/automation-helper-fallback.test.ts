import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { withAndroidAdbProvider } from './adb-executor.ts';
import { fillAndroid } from './text-input.ts';
import { pressAndroid, backAndroid } from './input-actions.ts';
import { screenshotAndroid } from './screenshot.ts';
import { readAndroidFillTargetBeforeMutation } from './fill-verification.ts';
import { resetAndroidSnapshotHelperSessions } from './snapshot-helper-session-lifecycle.ts';
import {
  createPersistentSnapshotHelperProvider,
  type FakeAndroidProcess,
} from './__tests__/snapshot-helper-session.fixtures.ts';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './__tests__/test-utils/android-snapshot-helper.ts';
import { ANDROID_EMULATOR as device } from './__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTest } from './__tests__/test-utils/android-host-test-setup.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+b9xkAAAAASUVORK5CYII=',
  'base64',
);
const helper = { helperSessionScope: 'daemon-session' } as const;
afterEach(resetAndroidSnapshotHelperSessions);

function fixture(response: Record<string, string>) {
  const calls: (readonly string[])[] = [];
  const requests: string[] = [];
  const processes: FakeAndroidProcess[] = [];
  let value = '';
  const provider = createPersistentSnapshotHelperProvider({
    calls,
    processes,
    spawnArgs: [],
    sessionRequests: requests,
    sessionCommands: ['input', 'screenshot', 'focus', 'snapshot-immediate'],
    sessionCommand: (command) =>
      /^(input|screenshot|focus) /.test(command) ? response : undefined,
    sessionXml: () =>
      `<hierarchy><node package="com.example" resource-id="com.example:id/field" class="android.widget.EditText" focused="true" editable="true" text="${value}" bounds="[0,0][200,100]"/></hierarchy>`,
  });
  const exec = provider.exec;
  provider.exec = async (args, options) => {
    if (args[0] === 'shell' && args[1] === 'input') {
      calls.push(args);
      if (args[2] === 'text') value += args[3];
      if (args.includes('KEYCODE_DEL')) value = '';
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'exec-out') {
      calls.push(args);
      return { exitCode: 0, stdout: '', stderr: '', stdoutBuffer: png };
    }
    return await exec(args, options);
  };
  return {
    calls,
    requests,
    processes,
    provider: { ...provider, snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
  };
}

const refused = {
  ok: 'false',
  errorType: 'java.lang.IllegalStateException',
  message: 'No editable field at the fill point',
};

test('a validated no-injection refusal completes fill through adb without a helper resend', async () => {
  const f = fixture({ ...refused, injected: 'false' });
  await withAndroidAdbProvider(f.provider, { serial: device.id }, async () => {
    await fillAndroid(device, 10, 10, 'chips', 0, helper);
    expect((await readAndroidFillTargetBeforeMutation(device, 10, 10, helper))?.text).toBe('chips');
  });
  expect(f.calls.filter((args) => args[0] === 'shell' && args[2] === 'text')).toHaveLength(1);
  expect(f.requests.filter((request) => request.startsWith('input '))).toHaveLength(1);
  expect(f.requests.some((request) => request.startsWith('quit '))).toBe(true);
});

test.each([undefined, 'true', 'unknown'])(
  'the same refusal with injected=%s never resends input',
  async (injected) => {
    const f = fixture(injected ? { ...refused, injected } : refused);
    await expect(
      withAndroidAdbProvider(f.provider, { serial: device.id }, () =>
        fillAndroid(device, 10, 10, 'chips', 0, helper),
      ),
    ).rejects.toMatchObject({ details: { dispatched: 'unknown' } });
    expect(f.calls.some((args) => args[0] === 'shell' && args[1] === 'input')).toBe(false);
  },
);

test.each<Record<string, string>>([
  {
    ok: 'false',
    errorType: 'java.lang.IllegalStateException',
    message: 'Screen capture was unavailable',
  },
  { ok: 'true', requestId: 'wrong-request' },
])(
  'a failed helper screenshot %j stops its session and captures a PNG through screencap',
  async (response) => {
    const f = fixture(response);
    const dir = await mkdtempForTest('android-helper-screenshot-fallback-');
    const output = path.join(dir, 'fallback.png');
    await withAndroidAdbProvider(f.provider, { serial: device.id }, async () => {
      await readAndroidFillTargetBeforeMutation(device, 10, 10, helper);
      await screenshotAndroid(device, output);
    });
    expect(await fs.readFile(output)).toEqual(png);
    expect(f.requests.filter((request) => request.startsWith('screenshot '))).toHaveLength(1);
    expect(f.requests.some((request) => request.startsWith('quit '))).toBe(true);
    expect(
      f.calls.filter((args) => args[0] === 'exec-out' && args.includes('screencap')),
    ).toHaveLength(1);
  },
);

test('a cached ended helper is retired before a pointer command takes the host path', async () => {
  const f = fixture({ ok: 'true' });
  await withAndroidAdbProvider(f.provider, { serial: device.id }, async () => {
    await readAndroidFillTargetBeforeMutation(device, 10, 10, helper);
    const exited = once(f.processes[0]!, 'close');
    f.processes[0]!.kill();
    await exited;
    await pressAndroid(device, 10, 10);
  });
  expect(f.requests.some((request) => request.startsWith('input '))).toBe(false);
  expect(f.calls.filter((args) => args[0] === 'shell' && args[2] === 'tap')).toHaveLength(1);
  expect(f.calls.some((args) => args[0] === 'forward' && args[1] === '--remove')).toBe(true);
});

test.each([
  ['tap', () => pressAndroid(device, 10, 10)],
  ['key', () => backAndroid(device)],
] as const)(
  'a typed no-injection %s refusal uses the host input path once',
  async (_kind, action) => {
    const f = fixture({ ...refused, injected: 'false' });
    await withAndroidAdbProvider(f.provider, { serial: device.id }, async () => {
      await readAndroidFillTargetBeforeMutation(device, 10, 10, helper);
      await action();
    });
    expect(f.requests.filter((request) => request.startsWith('input '))).toHaveLength(1);
    expect(f.calls.filter((args) => args[0] === 'shell' && args[1] === 'input')).toHaveLength(1);
  },
);

test('an uncorrelated no-injection reply cannot authorize a mutation resend', async () => {
  const f = fixture({ ...refused, injected: 'false', requestId: 'wrong-request' });
  await expect(
    withAndroidAdbProvider(f.provider, { serial: device.id }, () =>
      fillAndroid(device, 10, 10, 'chips', 0, helper),
    ),
  ).rejects.toMatchObject({ details: { dispatched: 'unknown' } });
  expect(f.calls.some((args) => args[0] === 'shell' && args[1] === 'input')).toBe(false);
});

test.each(['tap', 'back'])(
  'cancellable %s preserves the host signal with a live helper',
  async (kind) => {
    const f = fixture({ ok: 'true' });
    const signal = new AbortController().signal;
    const exec = f.provider.exec;
    f.provider.exec = async (args, options) => {
      if (args[0] === 'shell' && args[1] === 'input') expect(options?.signal).toBe(signal);
      return await exec(args, options);
    };
    await withAndroidAdbProvider(f.provider, { serial: device.id }, async () => {
      await readAndroidFillTargetBeforeMutation(device, 10, 10, helper);
      if (kind === 'tap') await pressAndroid(device, 10, 10, { signal });
      else await backAndroid(device, { signal });
    });
    expect(f.requests.some((request) => request.startsWith('input '))).toBe(false);
    expect(f.calls.filter((args) => args[0] === 'shell' && args[1] === 'input')).toHaveLength(1);
  },
);
