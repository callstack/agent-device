import { expect, test, vi } from 'vitest';
import { withAndroidAdbProvider } from '@agent-device/platform-android/mechanics';
import { ANDROID_SCREEN_RECORDING_REASONS } from '@agent-device/contracts/screen-recording-runtime-host';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { createAndroidScreenRecordingTransport } from './platform-runtime-screen-recording-android-host.ts';
import './platform-runtime-android-adb-host.ts';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';

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
  const calls: (readonly string[])[] = [];
  await withAndroidAdbProvider(
    {
      exec: async (args: readonly string[]) => {
        calls.push(args);
        const command = args.slice(1).join(' ');
        if (command.includes('screenrecord --bit-rate'))
          return result('agent-device-screenrecord-pid:42\n');
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
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      expect(transport.mode).toBe('transport-composed');
      await expect(transport.start({ remotePath: '/sdcard/capture.mp4' })).resolves.toEqual({
        process: { pid: '42', remotePath: '/sdcard/capture.mp4', startTime: '42' },
      });
      await expect(transport.size('/sdcard/capture.mp4')).resolves.toBe(42);
    },
  );
  expect(calls).toEqual([
    ['shell', expect.stringContaining('screenrecord --bit-rate 8000000')],
    ['shell', 'test', '-d', '/proc/42'],
    ['shell', 'cat', '/proc/42/cmdline'],
    ['shell', 'cat', '/proc/42/stat'],
    ['shell', 'rm', '-f', '/data/local/tmp/capture.err'],
    ['shell', 'test', '-e', '/sdcard/capture.mp4'],
    ['shell', 'stat', '-c', '%s', '/sdcard/capture.mp4'],
  ]);
  // A recorder the device accepts answers right away: a liveness wait in the launch would tax every
  // successful start to make a refused one slightly earlier.
  const launchCommand = String(calls[0]?.[1]);
  expect(launchCommand).not.toMatch(/sleep/);
});

test('finds only exact screenrecord processes for the canonical remote path', async () => {
  const remotePath = '/sdcard/agent-device-recording-123.mp4';
  let candidateExited = false;
  const candidateCalls: string[] = [];
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.slice(1).join(' ');
        if (command.includes('/proc/45')) candidateCalls.push(command);
        if (command === 'ps -A -o pid=') return result('41\n42\n43\n44\n45\n');
        if (command === 'test -d /proc/45') return result('', '', candidateExited ? 1 : 0);
        if (/^test -d \/proc\/\d+$/.test(command)) return result();
        const pid = /\/proc\/(\d+)\//.exec(command)?.[1];
        if (!pid) return result('', 'unexpected command', 1);
        if (pid === '45') {
          candidateExited = true;
          return result('', 'process exited', 1);
        }
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
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      await expect(transport.probeRunningWriters(remotePath)).resolves.toEqual({
        writers: [
          { pid: '41', remotePath, startTime: '41' },
          { pid: '44', remotePath, startTime: '44' },
        ],
        conclusive: true,
      });
      expect(candidateCalls).toContain('cat /proc/45/cmdline');
      expect(candidateCalls).toContain('cat /proc/45/stat');
      expect(candidateCalls.filter((command) => command === 'test -d /proc/45')).toHaveLength(2);
    },
  );
});
const writerScanRemotePath = '/sdcard/agent-device-recording-123.mp4';

type WriterScanDevice = Readonly<{ pids?: string; unreadablePid?: string; writerPid?: string }>;

const inconclusiveWriterScans: readonly (readonly [
  string,
  WriterScanDevice,
  {
    writers: readonly { pid: string; remotePath: string; startTime: string }[];
    conclusive: boolean;
  },
])[] = [
  ['no process table at all', {}, { writers: [], conclusive: false }],
  [
    'an unreadable candidate',
    { pids: '41\n42\n', unreadablePid: '42' },
    { writers: [], conclusive: false },
  ],
  [
    'one writer and an unreadable candidate',
    { pids: '41\n42\n', unreadablePid: '42', writerPid: '41' },
    {
      writers: [{ pid: '41', remotePath: writerScanRemotePath, startTime: '41' }],
      conclusive: false,
    },
  ],
];

function unreadableProcStat(device: WriterScanDevice, pid: string) {
  return pid === device.unreadablePid
    ? result('', `cat: /proc/${pid}/stat: Permission denied`, 1)
    : result(procStat(Number(pid), pid));
}

function screenrecordArgv(device: WriterScanDevice, pid: string): string {
  return device.writerPid === pid
    ? ['/system/bin/screenrecord', '--bit-rate', '8000000', writerScanRemotePath, ''].join('\0')
    : ['/system/bin/sh', '-c', 'screenrecord', writerScanRemotePath, ''].join('\0');
}

test.each(inconclusiveWriterScans)(
  'reports the writer scan inconclusive on %s',
  async (_name, device: WriterScanDevice, expected) => {
    await withAndroidAdbProvider(
      {
        exec: async (args) => {
          const command = args.slice(1).join(' ');
          if (command === 'ps -A -o pid=') {
            return device.pids ? result(device.pids) : result('', 'adb: device offline', 1);
          }
          if (/^test -d \/proc\/\d+$/.test(command)) return result();
          const pid = /\/proc\/(\d+)\//.exec(command)?.[1] ?? '';
          return command.endsWith('/stat')
            ? unreadableProcStat(device, pid)
            : result(screenrecordArgv(device, pid));
        },
      },
      { serial: android.id },
      async () => {
        const transport = await createAndroidScreenRecordingTransport(
          android,
          createLiveTestHostEnvironment(),
        );
        await expect(transport.probeRunningWriters(writerScanRemotePath)).resolves.toEqual(
          expected,
        );
      },
    );
  },
);

test('revalidates start-time and exact argv before SIGINT', async () => {
  const commands: string[] = [];
  let currentStart = '52';
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.slice(1).join(' ');
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
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
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
        const command = args.slice(1).join(' ');
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
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      const expected = { remotePath: '/sdcard/capture.mp4', startTime: '42' };
      await expect(transport.inspect({ ...expected, pid: '42' })).resolves.toBe('missing');
      await expect(transport.inspect({ ...expected, pid: '43' })).resolves.toBe('uncertain');
    },
  );
});

for (const failure of ['cmdline', 'stat', 'empty-stat'] as const) {
  const field = failure === 'cmdline' ? 'cmdline' : 'stat';
  test.each([
    ['absent', 1, 'already-missing'],
    ['present', 0, 'uncertain'],
    ['interrupted', null, 'uncertain'],
  ] as const)(
    `rechecks process presence after ${failure}: %s`,
    async (_presence, probeExit, expected) => {
      const commands: string[] = [];
      let probes = 0;
      adbExecutor.override = async (args) => {
        const command = args.slice(1).join(' ');
        commands.push(command);
        if (command === 'test -d /proc/42') {
          return ++probes === 1 ? result() : { stdout: '', stderr: '', exitCode: probeExit };
        }
        if (command === `cat /proc/42/${field}`) {
          return failure === 'empty-stat' ? result('') : result('', 'read failed', 1);
        }
        if (command.endsWith('/stat')) return result(procStat(42, '42'));
        return result(['/system/bin/screenrecord', '/sdcard/capture.mp4', ''].join('\0'));
      };
      try {
        const transport = await createAndroidScreenRecordingTransport(
          android,
          createLiveTestHostEnvironment(),
        );
        await expect(
          transport.stop({ pid: '42', remotePath: '/sdcard/capture.mp4', startTime: '42' }),
        ).resolves.toBe(expected);
        expect(commands.some((command) => command.startsWith('kill '))).toBe(false);
      } finally {
        adbExecutor.override = undefined;
      }
    },
  );
}

test('retains an interrupted empty-stderr presence probe as uncertain', async () => {
  adbExecutor.override = async (args) => {
    expect(args).toEqual(['shell', 'test', '-d', '/proc/44']);
    return result('', '', null);
  };
  try {
    const transport = await createAndroidScreenRecordingTransport(
      android,
      createLiveTestHostEnvironment(),
    );
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

test('reports the recorder startup message with a typed reason when its pid is gone', async () => {
  const commands: string[] = [];
  const recorderMessage = "Unable to open '/sdcard/capture.mp4': Permission denied";
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.slice(1).join(' ');
        commands.push(command);
        if (command.startsWith('screenrecord --bit-rate'))
          return result('agent-device-screenrecord-pid:42\n');
        if (command === 'test -d /proc/42') return result('', '', 1);
        if (command.startsWith("head -c 1000 '/data/local/tmp/capture.err'"))
          return result(recorderMessage);
        return result('', `unexpected command: ${command}`, 1);
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      const failure = await transport.start({ remotePath: '/sdcard/capture.mp4' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AppError);
      expect(normalizeError(failure)).toMatchObject({
        code: 'COMMAND_FAILED',
        message: expect.stringContaining(recorderMessage),
        details: {
          reason: ANDROID_SCREEN_RECORDING_REASONS.startupFailed.reason,
          stderr: recorderMessage,
          remotePath: '/sdcard/capture.mp4',
        },
      });
    },
  );
  // The launch redirects the recorder's stderr so its reason survives, and the refusal reads that
  // capture back once and removes it. The success-path cost is the redirect, not a liveness wait.
  expect(commands).toEqual([
    expect.stringMatching(
      /^screenrecord --bit-rate 8000000 '\/sdcard\/capture\.mp4' >\/dev\/null 2>'\/data\/local\/tmp\/capture\.err' & echo agent-device-screenrecord-pid:\$!$/,
    ),
    'test -d /proc/42',
    expect.stringMatching(
      /^head -c 1000 '\/data\/local\/tmp\/capture\.err' 2>\/dev\/null; rm -f '\/data\/local\/tmp\/capture\.err'$/,
    ),
  ]);
});

test('refuses a launch whose merged stream carries only the recorder output, never a bare number as a pid', async () => {
  // On a pty transport the recorder's own text shares stdout with the marker line. A refusal line
  // that happens to be a bare number must not read as the recorder's pid: only the marker answers.
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.slice(1).join(' ');
        if (command.startsWith('screenrecord --bit-rate')) return result('1\n');
        return result('', `unexpected command: ${command}`, 1);
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      await expect(transport.start({ remotePath: '/sdcard/capture.mp4' })).rejects.toThrow(
        'Android screenrecord did not return a process id',
      );
    },
  );
});

test('reads the recorder startup message from a pty transport that merges its streams', async () => {
  // `adb exec-out` on a pty carries the device's stderr inside stdout, so the capture read-back
  // answers there.
  const recorderMessage = "Unable to open '/sdcard/capture.mp4': Permission denied";
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.slice(1).join(' ');
        if (command.startsWith('screenrecord --bit-rate'))
          return result('agent-device-screenrecord-pid:42\n');
        if (command === 'test -d /proc/42') return result('', '', 1);
        if (command.startsWith("head -c 1000 '/data/local/tmp/capture.err'"))
          return result('', recorderMessage, 1);
        return result('', `unexpected command: ${command}`, 1);
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      const failure = await transport.start({ remotePath: '/sdcard/capture.mp4' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(normalizeError(failure)).toMatchObject({
        code: 'COMMAND_FAILED',
        message: expect.stringContaining(recorderMessage),
        details: {
          reason: ANDROID_SCREEN_RECORDING_REASONS.startupFailed.reason,
          stderr: recorderMessage,
        },
      });
    },
  );
});

test('names the startup refusal for a recorder that dies without a word', async () => {
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.slice(1).join(' ');
        if (command.startsWith('screenrecord --bit-rate'))
          return result('agent-device-screenrecord-pid:42\n');
        if (command === 'test -d /proc/42') return result('', '', 1);
        if (command.startsWith("head -c 1000 '/data/local/tmp/capture.err'")) return result('');
        return result('', `unexpected command: ${command}`, 1);
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      const failure = await transport.start({ remotePath: '/sdcard/capture.mp4' }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(normalizeError(failure)).toMatchObject({
        code: 'COMMAND_FAILED',
        message: 'Android screenrecord exited before it started recording',
        details: {
          reason: ANDROID_SCREEN_RECORDING_REASONS.startupFailed.reason,
          stderr: '',
        },
      });
    },
  );
});

test('keeps the identity refusal when a dead pid still has a live recorder of ours', async () => {
  // Only a pid the presence probe finds gone is a startup refusal. A pid that is alive but whose
  // identity cannot be read is a different failure, and reading a capture file the recorder may
  // still be writing would report a live recording as refused.
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.slice(1).join(' ');
        if (command.startsWith('screenrecord --bit-rate'))
          return result('agent-device-screenrecord-pid:42\n');
        if (command === 'test -d /proc/42') return result();
        if (command === 'cat /proc/42/cmdline')
          return result(['/system/bin/screenrecord', '/sdcard/capture.mp4', ''].join('\0'));
        if (command === 'cat /proc/42/stat') return result('', 'no such file', 1);
        if (command === 'rm -f /data/local/tmp/capture.err') return result();
        return result('', `unexpected command: ${command}`, 1);
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      await expect(transport.start({ remotePath: '/sdcard/capture.mp4' })).rejects.toThrow(
        'Android screenrecord did not expose a complete process identity',
      );
    },
  );
});

test('credits a path as absent only from a probe that answered, not from one that failed', async () => {
  let attempt = 0;
  adbExecutor.override = async (args) => {
    expect(args).toEqual(['shell', 'test', '-e', '/sdcard/capture.mp4']);
    attempt += 1;
    if (attempt === 1) return result('', '', 1);
    if (attempt === 2) return result('', '', null);
    if (attempt === 3) return result('', 'adb: device offline', 1);
    if (attempt === 4) return result('', '', null);
    return result('');
  };
  try {
    const transport = await createAndroidScreenRecordingTransport(
      android,
      createLiveTestHostEnvironment(),
    );
    await expect(transport.exists('/sdcard/capture.mp4')).resolves.toBe(false);
    await expect(transport.exists('/sdcard/capture.mp4')).resolves.toBe('uncertain');
    await expect(transport.exists('/sdcard/capture.mp4')).resolves.toBe('uncertain');
    await expect(transport.size('/sdcard/capture.mp4')).resolves.toBe('uncertain');
    await expect(transport.exists('/sdcard/capture.mp4')).resolves.toBe(true);
  } finally {
    adbExecutor.override = undefined;
  }
});

test('retains an interrupted empty-stderr manifest probe as unavailable', async () => {
  adbExecutor.override = async (args) => {
    expect(args).toEqual(['shell', 'test', '-e', '/sdcard/interrupted.json']);
    return result('', '', null);
  };
  try {
    const transport = await createAndroidScreenRecordingTransport(
      android,
      createLiveTestHostEnvironment(),
    );
    await expect(transport.readManifest('/sdcard/interrupted.json')).resolves.toEqual({
      status: 'unavailable',
      message: 'Android recording manifest probe failed',
    });
  } finally {
    adbExecutor.override = undefined;
  }
});

test('does not signal an exited or reassigned recorder', async () => {
  const commands: string[] = [];
  const recorded = { pid: '4004', remotePath: '/sdcard/capture.mp4', startTime: '3766' };
  const reassignedPid = {
    stat: procStat(4004, '3766'),
    cmdline: ['/system/bin/servicemanager', ''].join('\0'),
  };
  const otherArtifact = {
    stat: procStat(4004, '3766'),
    cmdline: ['/system/bin/screenrecord', '--bit-rate', '8000000', '/other.mp4', ''].join('\0'),
  };
  const exitedTask = { stat: procStat(4004, '3766'), cmdline: '' };
  let identity = reassignedPid;
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.slice(1).join(' ');
        commands.push(command);
        if (command.endsWith('/stat')) return result(identity.stat);
        if (command.endsWith('/cmdline')) return result(identity.cmdline);
        return result('');
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      for (const replacement of [reassignedPid, otherArtifact, exitedTask]) {
        identity = replacement;
        await expect(transport.inspect(recorded)).resolves.toBe('ownership-lost');
      }
      identity = exitedTask;
      await expect(transport.stop(recorded)).resolves.toBe('ownership-lost');
      identity = { stat: procStat(4004, '3766', 'Z'), cmdline: '' };
      await expect(transport.inspect(recorded)).resolves.toBe('missing');
      await expect(transport.stop(recorded)).resolves.toBe('already-missing');
      expect(commands.some((command) => command.startsWith('kill '))).toBe(false);
    },
  );
});

test('never signals a recorder whose pid was reused during the command-line read', async () => {
  const commands: string[] = [];
  const recorded = { pid: '4004', remotePath: '/sdcard/capture.mp4', startTime: '3766' };
  let currentStart = recorded.startTime;
  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        const command = args.slice(1).join(' ');
        commands.push(command);
        if (command.endsWith('/stat')) return result(procStat(4004, currentStart));
        if (command.endsWith('/cmdline')) {
          currentStart = '9911';
          return result(
            ['/system/bin/screenrecord', '--bit-rate', '8000000', recorded.remotePath, ''].join(
              '\0',
            ),
          );
        }
        return result('');
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      await expect(transport.stop(recorded)).resolves.toBe('ownership-lost');
      await expect(transport.inspect(recorded)).resolves.toBe('foreign-writer');
      expect(commands.some((command) => command.startsWith('kill '))).toBe(false);
    },
  );
});

function procStat(pid: number, startTime: string, state = 'S'): string {
  return `${pid} (screenrecord) ${state} ${Array.from({ length: 18 }, () => '0').join(' ')} ${startTime}`;
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
      exec: async (args: readonly string[]) => {
        const command = args.slice(1).join(' ');
        commands.push(command);
        if (command.startsWith('test -e')) {
          return { stdout: '', stderr: 'transport unavailable', exitCode: 1 };
        }
        return { stdout: '', stderr: 'permission denied', exitCode: 1 };
      },
    },
    { serial: android.id },
    async () => {
      const transport = await createAndroidScreenRecordingTransport(
        android,
        createLiveTestHostEnvironment(),
      );
      await expect(transport.readManifest('/sdcard/manifest.json')).resolves.toEqual({
        status: 'unavailable',
        message: 'transport unavailable',
      });
      await expect(transport.removeManifest('/sdcard/manifest.json')).resolves.toBe(false);
    },
  );
  expect(commands).toHaveLength(2);
});

for (const interruptedAt of ['initial', 'recheck'] as const) {
  test(`retains legal provider interruption on the ${interruptedAt} presence probe`, async () => {
    const commands: string[] = [];
    let probes = 0;
    await withAndroidAdbProvider(
      {
        exec: async (args) => {
          const command = args.slice(1).join(' ');
          commands.push(command);
          if (command === 'test -d /proc/42') {
            return ++probes === 1 && interruptedAt === 'recheck'
              ? result()
              : { stdout: '', stderr: '', exitCode: 1, signal: 'SIGTERM' };
          }
          if (command.endsWith('/cmdline')) return result('', 'read failed', 1);
          if (command.endsWith('/stat')) return result(procStat(42, '42'));
          throw new Error('unexpected command');
        },
      },
      { serial: android.id },
      async () => {
        const transport = await createAndroidScreenRecordingTransport(
          android,
          createLiveTestHostEnvironment(),
        );
        await expect(
          transport.stop({ pid: '42', remotePath: '/sdcard/capture.mp4', startTime: '42' }),
        ).resolves.toBe('uncertain');
        expect(commands.some((command) => command.startsWith('kill '))).toBe(false);
      },
    );
  });
}
