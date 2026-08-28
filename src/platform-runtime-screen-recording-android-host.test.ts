import { expect, test, vi } from 'vitest';
import { withAndroidAdbProvider } from '@agent-device/platform-android/mechanics';
import { createAndroidScreenRecordingTransport } from './platform-runtime-screen-recording-android-host.ts';
import './platform-runtime-android-adb-host.ts';

const adbExecutor = vi.hoisted(() => ({
  override: undefined as
    | ((args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>)
    | undefined,
}));

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...original,
    resolveAndroidAdbExecutor: (...args: Parameters<typeof original.resolveAndroidAdbExecutor>) =>
      adbExecutor.override ?? original.resolveAndroidAdbExecutor(...args),
  };
});

const android = {
  platform: 'android' as const,
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator' as const,
  target: 'mobile' as const,
  booted: true,
};

test('uses the request-scoped Android ADB executor rather than a host fallback', async () => {
  const calls: string[][] = [];
  await withAndroidAdbProvider(
    {
      exec: async (args: string[]) => {
        calls.push(args);
        const command = args[1] ?? '';
        if (command.includes('screenrecord --bit-rate')) return result('42\n');
        if (command === 'cat /proc/42/stat') return result(procStat(42, '42'));
        if (command === 'cat /proc/42/cmdline') {
          return result(
            ['/system/bin/screenrecord', '--bit-rate', '8000000', '/sdcard/capture.mp4', ''].join(
              '\0',
            ),
          );
        }
        if (command.startsWith('stat -c')) return result('42\n');
        return result('');
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(android);
      expect(transport.mode).toBe('transport-composed');
      await expect(transport.start({ remotePath: '/sdcard/capture.mp4' })).resolves.toEqual({
        process: { pid: '42', remotePath: '/sdcard/capture.mp4', startTime: '42' },
      });
      await expect(transport.size('/sdcard/capture.mp4')).resolves.toBe(42);
    },
  );
  expect(calls).toEqual([
    ['shell', expect.stringContaining('screenrecord --bit-rate 8000000')],
    ['shell', 'test -d /proc/42'],
    ['shell', 'cat /proc/42/stat'],
    ['shell', 'cat /proc/42/cmdline'],
    ['shell', "test -e '/sdcard/capture.mp4'"],
    ['shell', "stat -c %s '/sdcard/capture.mp4'"],
  ]);
});

test('finds only exact screenrecord processes for the canonical remote path', async () => {
  const remotePath = '/sdcard/agent-device-recording-123.mp4';
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args[1] ?? '';
        if (command === 'ps -A -o pid=') return result('41\n42\n43\n44\n');
        if (/^test -d \/proc\/\d+$/.test(command)) return result();
        const pid = /\/proc\/(\d+)\//.exec(command)?.[1];
        if (!pid) return result('', 'unexpected command', 1);
        if (command.endsWith('/stat')) return result(procStat(Number(pid), pid));
        const commandLines: Record<string, string> = {
          '41': ['/system/bin/screenrecord', '--bit-rate', '8000000', remotePath, ''].join('\0'),
          '42': [
            '/system/bin/screenrecord',
            '--bit-rate',
            '8000000',
            '/sdcard/agent-device-recording-456.mp4',
            '',
          ].join('\0'),
          '43': ['/system/bin/sh', '-c', 'screenrecord', remotePath, ''].join('\0'),
          '44': ['/system/bin/screenrecord', '--bit-rate', '8000000', remotePath, ''].join('\0'),
        };
        return result(commandLines[pid] ?? '');
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(android);
      await expect(transport.findRunning(remotePath)).resolves.toEqual([
        { pid: '41', remotePath, startTime: '41' },
        { pid: '44', remotePath, startTime: '44' },
      ]);
    },
  );
});

test('revalidates start-time and exact argv before SIGINT', async () => {
  const commands: string[] = [];
  let currentStart = '52';
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args[1] ?? '';
        commands.push(command);
        if (command.endsWith('/stat')) return result(procStat(51, currentStart));
        if (command.endsWith('/cmdline')) {
          return result(['/system/bin/screenrecord', '/sdcard/capture.mp4', ''].join('\0'));
        }
        return result('');
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(android);
      const process = {
        pid: '51',
        remotePath: '/sdcard/capture.mp4',
        startTime: '51',
      };
      await expect(transport.stop(process)).resolves.toBe('ownership-lost');
      expect(commands.some((command) => command.startsWith('kill '))).toBe(false);
      currentStart = '51';
      await expect(transport.stop(process)).resolves.toBe('stopped');
      expect(commands.at(-1)).toBe('kill -2 51');
    },
  );
});

test('distinguishes a missing proc directory from an unavailable identity probe', async () => {
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args[1] ?? '';
        if (command === 'test -d /proc/42') return result('', '', 1);
        if (command === 'test -d /proc/43') return result('', 'transport unavailable', 1);
        if (command === 'cat /proc/42/stat') {
          return result('', 'cat: /proc/42/stat: No such file or directory', 1);
        }
        if (command === 'cat /proc/43/stat') return result('', 'transport unavailable', 1);
        return result('', 'unexpected command', 1);
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(android);
      const expected = { remotePath: '/sdcard/capture.mp4', startTime: '42' };
      await expect(transport.inspect({ ...expected, pid: '42' })).resolves.toBe('missing');
      await expect(transport.inspect({ ...expected, pid: '43' })).resolves.toBe('uncertain');
    },
  );
});

test('retains an interrupted empty-stderr presence probe as uncertain', async () => {
  adbExecutor.override = async (args) => {
    expect(args).toEqual(['shell', 'test -d /proc/44']);
    return result('', '', null);
  };
  try {
    const transport = await createAndroidScreenRecordingTransport(android);
    await expect(
      transport.inspect({
        pid: '44',
        remotePath: '/sdcard/capture.mp4',
        startTime: '44',
      }),
    ).resolves.toBe('uncertain');
  } finally {
    adbExecutor.override = undefined;
  }
});

test('retains an interrupted empty-stderr manifest probe as unavailable', async () => {
  adbExecutor.override = async (args) => {
    expect(args).toEqual(['shell', "test -e '/sdcard/interrupted.json'"]);
    return result('', '', null);
  };
  try {
    const transport = await createAndroidScreenRecordingTransport(android);
    await expect(transport.readManifest('/sdcard/interrupted.json')).resolves.toEqual({
      status: 'unavailable',
      message: 'Android recording manifest probe failed',
    });
  } finally {
    adbExecutor.override = undefined;
  }
});

function procStat(pid: number, startTime: string): string {
  return `${pid} (screenrecord) S ${Array.from({ length: 18 }, () => '0').join(' ')} ${startTime}`;
}

function result(
  stdout?: string,
  stderr?: string,
  exitCode?: number,
): {
  stdout: string;
  stderr: string;
  exitCode: number;
};
function result(
  stdout: string,
  stderr: string,
  exitCode: null,
): {
  stdout: string;
  stderr: string;
  exitCode: null;
};
function result(stdout = '', stderr = '', exitCode: number | null = 0) {
  return { stdout, stderr, exitCode };
}

test('retains unavailable manifest reads and confirms manifest deletion', async () => {
  const commands: string[] = [];
  await withAndroidAdbProvider(
    {
      exec: async (args: string[]) => {
        const command = args[1] ?? '';
        commands.push(command);
        if (command.startsWith('test -e')) {
          return { stdout: '', stderr: 'transport unavailable', exitCode: 1 };
        }
        return { stdout: '', stderr: 'permission denied', exitCode: 1 };
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(android);
      await expect(transport.readManifest('/sdcard/manifest.json')).resolves.toEqual({
        status: 'unavailable',
        message: 'transport unavailable',
      });
      await expect(transport.removeManifest('/sdcard/manifest.json')).resolves.toBe(false);
    },
  );
  expect(commands).toHaveLength(2);
});
