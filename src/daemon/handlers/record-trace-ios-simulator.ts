import { sleep } from '../../utils/timeouts.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { ExecResult } from '../../utils/exec.ts';
import { signalPidsBestEffort, uniquePositivePids } from '../../utils/host-process.ts';
import { formatRecordTraceError } from '../record-trace-errors.ts';
import type { SessionState } from '../types.ts';
import type { RecordTraceDeps } from './record-trace-types.ts';

export const IOS_SIMULATOR_RECORDING_STOP_TIMEOUT_MS = 5_000;

const IOS_SIMULATOR_RECORDING_FORCE_STOP_TIMEOUT_MS = 2_000;

/**
 * Worst-case wall-clock time for {@link stopIosSimulatorRecordingProcess} to
 * conclude: the direct child-handle SIGINT wait plus the three escalating
 * PID-based retries (SIGINT, SIGTERM, SIGKILL). Any teardown path that bounds
 * recording finalization with its own timeout (daemon shutdown's per-session
 * teardown race) must budget at least this long, or a recorder stuck past the
 * direct-handle wait is abandoned mid-escalation and the simctl child orphans
 * with an unfinalized 0-byte mp4.
 */
export const IOS_SIMULATOR_RECORDING_STOP_ESCALATION_BUDGET_MS =
  IOS_SIMULATOR_RECORDING_STOP_TIMEOUT_MS + 3 * IOS_SIMULATOR_RECORDING_FORCE_STOP_TIMEOUT_MS;

type IosSimulatorRecording = Extract<NonNullable<SessionState['recording']>, { platform: 'ios' }>;

export async function stopIosSimulatorRecordingProcess(params: {
  deps: RecordTraceDeps;
  recording: IosSimulatorRecording;
}): Promise<ExecResult | null> {
  const { deps, recording } = params;
  // First signal the direct ChildProcess handle. If it does not exit, retry through
  // session-owned PID metadata so cleanup still works when the process tree outlives the handle.
  recording.child.kill('SIGINT');
  let result = await waitForRecordingProcessExit(
    recording.wait,
    IOS_SIMULATOR_RECORDING_STOP_TIMEOUT_MS,
  );
  if (result) return result;

  await signalIosSimulatorRecorderCleanup(deps, recording, 'SIGINT');
  result = await waitForRecordingProcessExit(
    recording.wait,
    IOS_SIMULATOR_RECORDING_FORCE_STOP_TIMEOUT_MS,
  );
  if (result) return result;

  recording.child.kill('SIGTERM');
  await signalIosSimulatorRecorderCleanup(deps, recording, 'SIGTERM');
  result = await waitForRecordingProcessExit(
    recording.wait,
    IOS_SIMULATOR_RECORDING_FORCE_STOP_TIMEOUT_MS,
  );
  if (result) return result;

  recording.child.kill('SIGKILL');
  await signalIosSimulatorRecorderCleanup(deps, recording, 'SIGKILL');
  return await waitForRecordingProcessExit(
    recording.wait,
    IOS_SIMULATOR_RECORDING_FORCE_STOP_TIMEOUT_MS,
  );
}

async function waitForRecordingProcessExit(
  wait: Promise<ExecResult>,
  timeoutMs: number,
): Promise<ExecResult | null> {
  return await Promise.race([wait, sleep(timeoutMs).then(() => null)]);
}

async function signalIosSimulatorRecorderCleanup(
  deps: RecordTraceDeps,
  recording: IosSimulatorRecording,
  signal: NodeJS.Signals,
): Promise<void> {
  if (await signalSessionOwnedIosSimulatorRecorders(deps, recording, signal)) {
    return;
  }
  await signalMatchingIosSimulatorRecorders(deps, recording.outPath, signal);
}

async function signalMatchingIosSimulatorRecorders(
  deps: RecordTraceDeps,
  outPath: string,
  signal: NodeJS.Signals,
): Promise<void> {
  const pattern = `simctl.*recordVideo.*${escapeProcessRegex(outPath)}`;
  let result: ExecResult;
  try {
    result = await deps.runCmd('pgrep', ['-f', pattern], { allowFailure: true });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'record_stop_ios_simulator_pgrep_failed',
      data: {
        outPath,
        signal,
        error: formatRecordTraceError(error),
      },
    });
    return;
  }

  const pids = uniquePositivePids(parseProcessIds(result.stdout), { excludePid: process.pid });
  const signaled = signalPidsBestEffort(pids, signal);

  emitDiagnostic({
    level: signaled > 0 ? 'warn' : 'debug',
    phase: 'record_stop_ios_simulator_signal_recorders',
    data: {
      outPath,
      signal,
      matchedPidCount: pids.length,
      signaled,
      pgrepExitCode: result.exitCode,
    },
  });
}

async function signalSessionOwnedIosSimulatorRecorders(
  deps: RecordTraceDeps,
  recording: IosSimulatorRecording,
  signal: NodeJS.Signals,
): Promise<boolean> {
  const recorderPid = recording.recorderPid ?? recording.child.pid;
  if (typeof recorderPid !== 'number' || !Number.isInteger(recorderPid) || recorderPid <= 0) {
    emitDiagnostic({
      level: 'debug',
      phase: 'record_stop_ios_simulator_owned_recorder_unavailable',
      data: {
        outPath: recording.outPath,
        signal,
        reason: 'missing_recorder_pid',
      },
    });
    return false;
  }

  const childResult = await findChildProcessIds(deps, recorderPid, recording.outPath, signal);
  const pids = uniquePositivePids([recorderPid, ...childResult.pids], {
    excludePid: process.pid,
  });
  const signaled = signalPidsBestEffort(pids, signal);

  emitDiagnostic({
    level: signaled > 0 ? 'warn' : 'debug',
    phase: 'record_stop_ios_simulator_signal_owned_recorder',
    data: {
      outPath: recording.outPath,
      signal,
      recorderPid,
      childPidCount: childResult.pids.length,
      matchedPidCount: pids.length,
      signaled,
      pgrepExitCode: childResult.exitCode,
    },
  });

  return signaled > 0;
}

async function findChildProcessIds(
  deps: RecordTraceDeps,
  parentPid: number,
  outPath: string,
  signal: NodeJS.Signals,
): Promise<{ pids: number[]; exitCode?: number }> {
  let result: ExecResult;
  try {
    result = await deps.runCmd('pgrep', ['-P', String(parentPid)], { allowFailure: true });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'record_stop_ios_simulator_owned_pgrep_failed',
      data: {
        outPath,
        signal,
        parentPid,
        error: formatRecordTraceError(error),
      },
    });
    return { pids: [] };
  }

  return {
    pids: parseProcessIds(result.stdout),
    exitCode: result.exitCode,
  };
}

function parseProcessIds(stdout: string): number[] {
  return stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function escapeProcessRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
