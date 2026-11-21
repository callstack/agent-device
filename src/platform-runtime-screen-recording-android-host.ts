import path from 'node:path';
import { execFailureDetails } from '@agent-device/host-kit/command';
import {
  ANDROID_SCREEN_RECORDING_REASONS,
  type AndroidScreenRecordingProcessIdentity,
  type AndroidScreenRecordingProcessOwnership,
  type AndroidScreenRecordingTransport,
} from '@agent-device/contracts/screen-recording-runtime-host';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { type ShellWord, shellFragment, shellQuote } from '@agent-device/kernel/device-shell';
import { isPlayableVideo } from '@agent-device/capture-kit/recording-video';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

const ANDROID_MANIFEST_NAME = 'agent-device-recording-active.json';
const ADB_TIMEOUT_MS = 5_000;
const BIT_RATE = { medium: 8_000_000, high: 20_000_000 } as const;

export async function createAndroidScreenRecordingTransport(
  device: DeviceInfo,
  host: HostEnvironment,
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
      const startupLog = screenrecordStartupLogPath(remotePath);
      const launch = await shell(
        [shellFragment(buildScreenrecordStartCommand(remotePath, BIT_RATE[quality], startupLog))],
        signal,
      );
      const remotePid = parseScreenrecordLaunchPid(launch.stdout);
      if (!remotePid) {
        await shell(['rm', '-f', startupLog], signal);
        throw new Error('Android screenrecord did not return a process id');
      }
      const inspected = await inspectAndroidScreenRecordingProcess(
        shell,
        { pid: remotePid, remotePath, startTime: '' },
        signal,
      );
      // A pid the probe already finds gone means the device refused the recorder at startup. The
      // recorder wrote its own reason to the capture file before it exited, so read that back here,
      // once, instead of paying for a liveness wait on launches that succeed.
      if (inspected.status === 'missing')
        throw await screenrecordStartupRefused(shell, remotePath, startupLog, signal);
      if (inspected.status !== 'owned-alive' || !inspected.process) {
        await shell(['rm', '-f', startupLog], signal);
        throw new Error('Android screenrecord did not expose a complete process identity');
      }
      // The recording is live, so the capture file can hold nothing the start will report. Remove it
      // rather than leave it on the device for the whole recording.
      await shell(['rm', '-f', startupLog], signal);
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
        playable: result.exitCode === 0 && (await isPlayableVideo(outputPath, host)),
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
) => Promise<
  Readonly<{ stdout: string; stderr: string; exitCode: number | null; signal?: string }>
>;

/** What the bounded read-back of the capture file answers. */
type ScreenrecordStartupCapture = Readonly<{ stdout: string; stderr: string }>;

/**
 * The launch command's own answer line, prefix-tagged so nothing else on stdout can read as a pid.
 * A transport that runs the device shell on a pty merges the device's stderr into stdout, so the
 * recorder's refusal text, the device shell's own complaints, and the pid share one stream.
 */
const STARTUP_PID_MARKER = 'agent-device-screenrecord-pid';

/** The pid from the marker line, or nothing when the launch never answered with one. */
function parseScreenrecordLaunchPid(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const pid = /^agent-device-screenrecord-pid:(\d+)$/.exec(line.trim())?.[1];
    if (pid) return pid;
  }
  return undefined;
}

/**
 * The device directory the recorder's own startup output is captured to. The adb shell user opens
 * the redirect before it execs `screenrecord`, so the file is writable even on a device whose
 * policy stops the recorder from opening its artifact — which is what makes a refused launch
 * reportable instead of silent.
 */
const STARTUP_LOG_DIR = '/data/local/tmp';

/**
 * The most of the recorder's startup output a refusal reads back. A recorder the device keeps
 * restarting would otherwise write until the partition is full, and the report needs only the
 * recorder's first verdict.
 */
const STARTUP_OUTPUT_LIMIT_BYTES = 1_000;

/** The capture file for one artifact, named after it so concurrent paths never share one. */
function screenrecordStartupLogPath(remotePath: string): string {
  return `${STARTUP_LOG_DIR}/${path.posix.basename(remotePath, '.mp4')}.err`;
}

/**
 * The device-shell command that starts one recorder and reports its pid. It answers as fast as the
 * device shell forks the job: no liveness wait, because a recorder the device refuses is reported by
 * the identity probe's own presence check. What the launch adds is the redirect — a `screenrecord`
 * that cannot open its artifact writes its reason to the capture file and exits, so the probe's
 * dead-pid answer still has the recorder's explanation to carry.
 * The reported pid is the recorder's own, because a job of one simple command with redirections runs
 * without a subshell, so the probe keeps reading `screenrecord` in that pid's command line. The
 * capture file outlives the launch: a start that records removes it, and a refused start reads it
 * back and removes it.
 */
function buildScreenrecordStartCommand(
  remotePath: string,
  bitRate: number,
  startupLog: string,
): string {
  return `screenrecord --bit-rate ${bitRate} ${shellQuote(remotePath)} >/dev/null 2>${shellQuote(startupLog)} & echo ${STARTUP_PID_MARKER}:$!`;
}

/**
 * The recorder was gone by the time the probe looked at it, so the device refused it at startup and
 * its own startup output is in the capture file. `execFailureDetails` keeps that message in details,
 * so `normalizeError` surfaces it beside this message and `details.reason` names the class of
 * failure. The capture is bounded and removed on the way out, whatever it holds.
 */
async function screenrecordStartupRefused(
  shell: AndroidShell,
  remotePath: string,
  startupLog: string,
  signal?: AbortSignal,
): Promise<AppError> {
  const captured = await shell(
    [
      shellFragment(
        `head -c ${STARTUP_OUTPUT_LIMIT_BYTES} ${shellQuote(startupLog)} 2>/dev/null; rm -f ${shellQuote(startupLog)}`,
      ),
    ],
    signal,
  );
  return new AppError(
    'COMMAND_FAILED',
    'Android screenrecord exited before it started recording',
    execFailureDetails(
      {
        stdout: '',
        stderr: recorderStartupOutput(captured),
        // The launch reported no exit code: the recorder's own status was never observed, only its
        // absence. The recorder's message, not an exit code, is the evidence here.
        exitCode: null,
      },
      {
        reason: ANDROID_SCREEN_RECORDING_REASONS.startupFailed.reason,
        remotePath,
        hint: 'Android refused the recorder at startup and its own message is in the details. Report that message to the device manufacturer; agent-device has no alternative Android recording backend.',
      },
    ),
  );
}

/**
 * What the read-back of the capture file answered. A transport that runs the device shell on a pty
 * merges the device's stderr into stdout, so the message can arrive on either stream.
 */
function recorderStartupOutput(captured: ScreenrecordStartupCapture): string {
  return captured.stdout.trim().length > 0 ? captured.stdout : captured.stderr;
}

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
  const command = await shell(['cat', `/proc/${expected.pid}/cmdline`], signal);
  const stat = await shell(['cat', `/proc/${expected.pid}/stat`], signal);
  const identity = stat.exitCode === 0 ? parseProcIdentity(stat.stdout) : undefined;
  if (command.exitCode !== 0 || !identity) {
    return {
      status:
        (await probeAndroidProcessPresence(shell, expected.pid, signal)) === 'missing'
          ? 'missing'
          : 'uncertain',
    };
  }
  if (identity.state === 'Z') return { status: 'missing' };
  if (!matchesScreenRecordingCommand(command.stdout, expected.remotePath)) {
    return { status: 'ownership-lost' };
  }
  if (expected.startTime.length > 0 && expected.startTime !== identity.startTime) {
    return { status: 'foreign-writer' };
  }
  return {
    status: 'owned-alive',
    process: Object.freeze({
      pid: expected.pid,
      remotePath: expected.remotePath,
      startTime: identity.startTime,
    }),
  };
}

async function probeAndroidProcessPresence(
  shell: AndroidShell,
  pid: string,
  signal?: AbortSignal,
): Promise<'present' | 'missing' | 'uncertain'> {
  const result = await shell(['test', '-d', `/proc/${pid}`], signal);
  if (result.signal) return 'uncertain';
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

function parseProcIdentity(stat: string) {
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const fieldsAfterCommand = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const startTime = fieldsAfterCommand[19];
  return startTime && /^\d+$/.test(startTime)
    ? { startTime, state: fieldsAfterCommand[0] }
    : undefined;
}
