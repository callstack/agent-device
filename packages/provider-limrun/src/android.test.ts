import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbSerialTarget,
  serializeAndroidAdbInvocation,
  type AndroidAdbInvocation,
} from '@agent-device/platform-android/mechanics';
import {
  cleanupLimrunAndroidAdbTunnel,
  createLimrunAndroidSession,
  type LimrunAndroidSession,
} from './android.ts';
import type {
  LimrunAdbCommandOptions,
  LimrunAdbProvider,
  LimrunRuntimeDependencies,
} from './runtime-dependencies.ts';

const ok = { exitCode: 0, stdout: '', stderr: '' };

/**
 * The serial a reverse cleanup is ending is not a route a retained caller may take: an ordinary command
 * arriving inside that window has to be refused, or the taken session keeps taking commands on the device.
 */
test('a command that arrives while cleanup holds its serial is refused', async () => {
  const runs: string[][] = [];
  const session = await createLimrunAndroidSession(
    ANDROID_SESSION_OPTIONS,
    androidDependencies(runs),
  );
  // The first command raises the tunnel this session owns, so a later one has a serial to reach for.
  await session.adbProvider.exec(['shell', 'echo', 'ready']);
  const dispatched = runs.length;
  let reportList!: () => void;
  reverse.listGate = new Promise<void>((resolve) => {
    reportList = resolve;
  });
  try {
    // Cleanup has retired this session and is inside the device with the serial it is ending.
    const cleanup = cleanupLimrunAndroidAdbTunnel(session);
    await vi.waitFor(() => expect(reverse.list).toHaveBeenCalledOnce());

    await expect(session.adbProvider.exec(['shell', 'echo', 'again'])).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      details: { reason: 'limrun_adb_tunnel_cleaned_up' },
    });

    reportList();
    await cleanup;
  } finally {
    reverse.listGate = undefined;
  }
  // The only commands this session dispatched are its own cleanup's: the listing and the disconnect.
  expect(runs.slice(dispatched).filter((argv) => argv.includes('shell'))).toEqual([]);
  expect(tunnels.start).toHaveBeenCalledOnce();
});

const tunnels = vi.hoisted(() => ({
  /**
   * Held by a case that has to keep a tunnel in flight, which is the window a session's cleanup has to
   * cover: the endpoint the SDK is still raising can answer after that cleanup answered.
   */
  gate: undefined as Promise<void> | undefined,
  start: vi.fn(async () => {
    await tunnels.gate;
    return { address: { address: '127.0.0.1', port: 62_001 }, close: tunnels.close };
  }),
  close: vi.fn(),
}));

/** The reverse manager every session of a case gets, with its listing held by the case that needs a window. */
const reverse = vi.hoisted(() => ({
  /** Held by a case that has to keep a cleanup inside the window in which it holds its serial. */
  listGate: undefined as Promise<void> | undefined,
  list: vi.fn(async () => {
    await reverse.listGate;
    return [];
  }),
  ensure: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  removeAllOwned: vi.fn(async () => {}),
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => ({ startAdbTunnel: tunnels.start })),
}));

beforeEach(() => {
  tunnels.gate = undefined;
  tunnels.start.mockClear();
  tunnels.close.mockClear();
  reverse.listGate = undefined;
  reverse.list.mockClear();
});

test('cleanup asks the platform to address the disconnect as a server-level command and hands it over unchanged', async () => {
  const calls: Array<{ argv: string[]; options: LimrunAdbCommandOptions | undefined }> = [];
  const close = vi.fn();
  const provider: LimrunAdbProvider = { exec: async () => ok };
  const hostAdbInvocation = vi.fn((command: readonly string[]) =>
    androidAdbInvocation(androidAdbHostTarget(), command),
  );
  const session = {
    platform: 'android',
    adbProvider: provider,
    adbSerial: '127.0.0.1:62001',
    adbTunnel: { close },
    adbTunnelPromise: Promise.resolve(),
    dependencies: {
      android: { hostAdbInvocation },
      host: {
        runAdb: async (invocation: AndroidAdbInvocation, options?: LimrunAdbCommandOptions) => {
          calls.push({ argv: [...serializeAndroidAdbInvocation(invocation)], options });
          return ok;
        },
      },
    },
  } as unknown as LimrunAndroidSession;

  await cleanupLimrunAndroidAdbTunnel(session);

  expect(hostAdbInvocation).toHaveBeenCalledWith(['disconnect', '127.0.0.1:62001']);
  expect(calls).toEqual([
    {
      argv: ['disconnect', '127.0.0.1:62001'],
      options: { allowFailure: true, timeoutMs: 10_000 },
    },
  ]);
  expect(close).toHaveBeenCalledOnce();
  expect(session.adbSerial).toBeUndefined();
  expect(session.adbTunnel).toBeUndefined();
  expect(session.adbTunnelPromise).toBeUndefined();
});

/**
 * Cleanup yields before it can look at the session's endpoint, so it has to retire that endpoint in the step
 * that started it: a command arriving inside that window would otherwise raise a tunnel the cleanup had no way
 * to see, which then answers into a session nothing owns any more.
 */
test('a command that arrives while cleanup is starting raises no tunnel', async () => {
  const session = await createLimrunAndroidSession(ANDROID_SESSION_OPTIONS, androidDependencies());
  const cleanup = cleanupLimrunAndroidAdbTunnel(session);
  // The cleanup has not looked at the endpoint yet, and this command has no retired flag to stop it.
  const command = session.adbProvider.exec(['shell', 'echo', 'again']);

  await expect(command).rejects.toMatchObject({
    code: 'SESSION_NOT_FOUND',
    details: { reason: 'limrun_adb_tunnel_cleaned_up' },
  });
  await cleanup;

  expect(tunnels.start).not.toHaveBeenCalled();
  expect(session.adbSerial).toBeUndefined();
  expect(session.adbTunnel).toBeUndefined();
});

/**
 * A tunnel already being raised when cleanup arrives answers after cleanup returned, and the endpoint is
 * process-wide: the session has to end it where it lands rather than publish it to nobody.
 */
test('a tunnel still being raised when cleanup arrives is ended and its command refused', async () => {
  const session = await createLimrunAndroidSession(ANDROID_SESSION_OPTIONS, androidDependencies());
  let reportTunnel!: () => void;
  tunnels.gate = new Promise<void>((resolve) => {
    reportTunnel = resolve;
  });
  try {
    const command = session.adbProvider.exec(['shell', 'echo', 'held']);
    await vi.waitFor(() => expect(tunnels.start).toHaveBeenCalledOnce());

    const cleanup = cleanupLimrunAndroidAdbTunnel(session);
    reportTunnel();

    await expect(command).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
      details: { reason: 'limrun_adb_tunnel_cleaned_up' },
    });
    await cleanup;
  } finally {
    tunnels.gate = undefined;
  }
  // The tunnel this session raised was closed, and nothing published it for a later command to use.
  expect(tunnels.close).toHaveBeenCalledOnce();
  expect(session.adbSerial).toBeUndefined();
  expect(session.adbTunnel).toBeUndefined();
});

/**
 * The host ADB endpoint is process-wide, so an interactor kept from a cleaned-up session has to be refused
 * rather than handed a fresh tunnel: nothing owns that tunnel any more, and it survives the daemon's work
 * on the device.
 */
test('an interactor kept from a cleaned-up session is refused instead of raising a second tunnel', async () => {
  const session = await createLimrunAndroidSession(ANDROID_SESSION_OPTIONS, androidDependencies());
  // The first command raises the tunnel this session owns.
  await session.adbProvider.exec(['shell', 'echo', 'ready']);
  expect(tunnels.start).toHaveBeenCalledOnce();

  await cleanupLimrunAndroidAdbTunnel(session);

  await expect(session.adbProvider.exec(['shell', 'echo', 'again'])).rejects.toMatchObject({
    code: 'SESSION_NOT_FOUND',
    details: { reason: 'limrun_adb_tunnel_cleaned_up' },
  });
  expect(tunnels.start).toHaveBeenCalledOnce();
});

const ANDROID_SESSION_OPTIONS = {
  lease: {
    leaseId: 'lease-android',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  } satisfies DeviceLease,
  instanceId: 'android-instance-1',
  ownership: 'created' as const,
  device: {
    platform: 'android',
    id: 'limrun:android:lease-android',
    name: 'Android 14',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  } satisfies DeviceInfo,
  apiUrl: 'https://android.example',
  adbUrl: 'wss://adb.example',
  token: 'instance-token',
};

function androidDependencies(
  runs?: string[][],
): Pick<LimrunRuntimeDependencies, 'android' | 'host'> {
  return {
    android: {
      deviceAdbInvocation: (serial: string, command: readonly string[]) =>
        androidAdbInvocation(androidAdbSerialTarget(serial), command),
      hostAdbInvocation: (command: readonly string[]) =>
        androidAdbInvocation(androidAdbHostTarget(), command),
      adbError: async (message: string) => new Error(message),
      createPortReverse: async () => reverse,
    } as unknown as LimrunRuntimeDependencies['android'],
    host: {
      runAdb: async (invocation: AndroidAdbInvocation) => {
        runs?.push([...serializeAndroidAdbInvocation(invocation)]);
        return ok;
      },
    } as unknown as LimrunRuntimeDependencies['host'],
  };
}
