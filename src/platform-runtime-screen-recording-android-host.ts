import path from 'node:path';
import type {
  AndroidScreenRecordingProcessIdentity,
  AndroidScreenRecordingProcessOwnership,
  AndroidScreenRecordingTransport,
} from '@agent-device/contracts/screen-recording-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { type ShellWord, shellFragment, shellQuote } from '@agent-device/kernel/device-shell';
import { isPlayableVideo } from '@agent-device/capture-kit/recording-video';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

const ANDROID_MANIFEST_NAME = 'agent-device-recording-active.json';
const ADB_TIMEOUT_MS = 5_000;
const BIT_RATE = { medium: 8_000_000, high: 20_000_000 } as const;

export async function createAndroidScreenRecordingTransport(
  device: DeviceInfo,
): Promise<AndroidScreenRecordingTransport> {
  const { resolveAndroidAdbExecutor, resolveScopedAndroidAdbBackgroundTransport, runAdbShell } =
    await loadAndroidMechanics();
  const adb = resolveAndroidAdbExecutor(device);
  const scoped = resolveScopedAndroidAdbBackgroundTransport(device);
  const shell = async (words: readonly ShellWord[], signal?: AbortSignal) =>
    await runAdbShell(adb, words, { allowFailure: true, timeoutMs: ADB_TIMEOUT_MS, signal });
  // `test -e` exits 0 on a path it saw and 1 on a path it did not, so only those two answers are
  // evidence. Any other exit — a killed probe, a device that went away mid-call, a shell that could
  // not run the test — says nothing about the path and must not read as an absence.
  const probeRemotePath = async (
    remotePath: string,
    signal?: AbortSignal,
  ): Promise<'present' | 'absent' | 'uncertain'> => {
    const probed = await shell(['test', '-e', remotePath], signal);
    if (probed.exitCode === 0) return 'present';
    return probed.exitCode === 1 && probed.stderr.trim() === '' ? 'absent' : 'uncertain';
  };
  return Object.freeze({
    mode: scoped.mode,
    start: async ({ remotePath, quality = 'medium' }, signal) => {
      const result = await shell(
        [
          shellFragment(
            `screenrecord --bit-rate ${BIT_RATE[quality]} ${shellQuote(remotePath)} >/dev/null 2>&1 & echo $!`,
          ),
        ],
        signal,
      );
      const remotePid = result.stdout.split(/\s+/).find((value) => /^\d+$/.test(value));
      if (!remotePid) throw new Error('Android screenrecord did not return a process id');
      const inspected = await inspectAndroidScreenRecordingProcess(
        shell,
        { pid: remotePid, remotePath, startTime: '' },
        signal,
      );
      if (inspected.status !== 'owned-alive' || !inspected.process) {
        throw new Error('Android screenrecord did not expose a complete process identity');
      }
      return Object.freeze({ process: inspected.process });
    },
    inspect: async (process, signal) =>
      (await inspectAndroidScreenRecordingProcess(shell, process, signal)).status,
    stop: async (process, options, signal) => {
      const inspected = await inspectAndroidScreenRecordingProcess(shell, process, signal);
      if (inspected.status === 'missing') return 'already-missing';
      if (inspected.status === 'foreign-writer') return 'ownership-lost';
      if (inspected.status !== 'owned-alive') return inspected.status;
      const stopped = await shell(['kill', options?.force ? '-9' : '-2', process.pid], signal);
      return stopped.exitCode === 0 ? 'stopped' : 'uncertain';
    },
    exists: async (remotePath, signal) => {
      const probe = await probeRemotePath(remotePath, signal);
      if (probe === 'present') return true;
      return probe === 'absent' ? false : 'uncertain';
    },
    size: async (remotePath, signal) => {
      const probe = await probeRemotePath(remotePath, signal);
      if (probe !== 'present') return probe === 'absent' ? undefined : 'uncertain';
      const result = await shell(['stat', '-c', '%s', remotePath], signal);
      if (result.exitCode !== 0) return 'uncertain';
      const size = Number(result.stdout.trim());
      return Number.isSafeInteger(size) && size >= 0 ? size : 'uncertain';
    },
    probeRunningWriters: async (remotePath, signal) => {
      const result = await shell(['ps', '-A', '-o', 'pid='], signal);
      if (result.exitCode !== 0) return { writers: [], conclusive: false };
      const pids = result.stdout.split(/\s+/).filter((pid) => /^\d+$/.test(pid));
      const inspected = await Promise.all(
        pids.map(
          async (pid) =>
            await inspectAndroidScreenRecordingProcess(
              shell,
              { pid, remotePath, startTime: '' },
              signal,
            ),
        ),
      );
      return {
        writers: inspected.flatMap((outcome) =>
          outcome.status === 'owned-alive' && outcome.process ? [outcome.process] : [],
        ),
        conclusive: !inspected.some((outcome) => outcome.status === 'uncertain'),
      };
    },
    pullPlayable: async ({ remotePath, outputPath }, signal) => {
      const result = await adb(['pull', remotePath, outputPath], {
        allowFailure: true,
        signal,
      });
      return {
        ...result,
        playable: result.exitCode === 0 && (await isPlayableVideo(outputPath)),
      };
    },
    remove: async (remotePath, signal) =>
      (await shell(['rm', '-f', remotePath], signal)).exitCode === 0,
    manifestPathFor: (remotePath) => `${path.posix.dirname(remotePath)}/${ANDROID_MANIFEST_NAME}`,
    readManifest: async (manifestPath, signal) => {
      const exists = await shell(['test', '-e', manifestPath], signal);
      if (exists.exitCode !== 0) {
        return exists.exitCode === 1 && exists.stderr.trim() === ''
          ? { status: 'missing' as const }
          : {
              status: 'unavailable' as const,
              message: exists.stderr.trim() || 'Android recording manifest probe failed',
            };
      }
      const result = await shell(['cat', manifestPath], signal);
      return result.exitCode === 0
        ? { status: 'read' as const, contents: result.stdout }
        : {
            status: 'unavailable' as const,
            message: result.stderr.trim() || 'Android recording manifest could not be read',
          };
    },
    writeManifest: async ({ manifestPath, contents }, signal) => {
      const temporary = `${manifestPath}.tmp`;
      const result = await shell(
        [
          shellFragment(
            `printf %s ${shellQuote(contents)} > ${shellQuote(temporary)} && mv -f ${shellQuote(temporary)} ${shellQuote(manifestPath)}`,
          ),
        ],
        signal,
      );
      if (result.exitCode !== 0) throw new Error('failed to write Android recording manifest');
    },
    removeManifest: async (manifestPath, signal) =>
      (await shell(['rm', '-f', manifestPath], signal)).exitCode === 0,
  });
}

type AndroidShell = (
  words: readonly ShellWord[],
  signal?: AbortSignal,
) => Promise<Readonly<{ stdout: string; stderr: string; exitCode: number | null }>>;

async function inspectAndroidScreenRecordingProcess(
  shell: AndroidShell,
  expected: AndroidScreenRecordingProcessIdentity,
  signal?: AbortSignal,
): Promise<
  Readonly<{
    status: AndroidScreenRecordingProcessOwnership;
    process?: AndroidScreenRecordingProcessIdentity;
  }>
> {
  const presence = await probeAndroidProcessPresence(shell, expected.pid, signal);
  if (presence !== 'present') return { status: presence };
  const stat = await shell(['cat', `/proc/${expected.pid}/stat`], signal);
  if (stat.exitCode !== 0) return { status: 'uncertain' };
  const startTime = parseProcStartTime(stat.stdout);
  if (!startTime) return { status: 'uncertain' };
  const command = await shell(['cat', `/proc/${expected.pid}/cmdline`], signal);
  if (command.exitCode !== 0) return { status: 'uncertain' };
  if (!matchesScreenRecordingCommand(command.stdout, expected.remotePath)) {
    return { status: 'ownership-lost' };
  }
  if (expected.startTime.length > 0 && expected.startTime !== startTime) {
    return { status: 'foreign-writer' };
  }
  return {
    status: 'owned-alive',
    process: Object.freeze({ pid: expected.pid, remotePath: expected.remotePath, startTime }),
  };
}

async function probeAndroidProcessPresence(
  shell: AndroidShell,
  pid: string,
  signal?: AbortSignal,
): Promise<'present' | 'missing' | 'uncertain'> {
  const result = await shell(['test', '-d', `/proc/${pid}`], signal);
  if (result.exitCode === 0) return 'present';
  return result.exitCode === 1 && result.stderr.trim() === '' ? 'missing' : 'uncertain';
}

function matchesScreenRecordingCommand(commandLine: string, remotePath: string): boolean {
  const args = commandLine.split('\0').filter((value) => value.length > 0);
  const executable = args[0];
  return (
    executable !== undefined &&
    path.posix.basename(executable) === 'screenrecord' &&
    args.at(-1) === remotePath
  );
}

function parseProcStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const fieldsAfterCommand = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
}
