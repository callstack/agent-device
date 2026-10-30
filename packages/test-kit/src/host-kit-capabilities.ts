import {
  commandDeveloperDir,
  isCommandTimeoutError,
  requireExecSuccess,
  runCmd,
  runCmdBackground,
  runCmdStreaming,
} from '@agent-device/host-kit/command';
import { emitDiagnostic, withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { acquireProcessLock, publishFileSync, withProcessLock } from '@agent-device/host-kit/file';
import {
  classifyOwnerLiveness,
  isProcessAlive,
  isProcessGroupAlive,
  readHostCpuArchSync,
  readProcessCommand,
  readProcessStartTime,
  signalPidsBestEffort,
  signalProcessGroupBestEffort,
} from '@agent-device/host-kit/process';
import {
  emitRequestProgress,
  getRequestSignal,
  isRequestCanceled,
} from '@agent-device/host-kit/request';
import { Deadline, isEnvTruthy, retryWithPolicy } from '@agent-device/host-kit/retry';
import { runtimeSlot } from '@agent-device/host-kit/runtime-slots';
import { findProjectRoot, readVersion } from '@agent-device/host-kit/version';

/**
 * The real host-kit capabilities a package suite takes as its host defaults, under the names the
 * Apple runner host port uses for them. A suite that must not import host-kit itself (the runner
 * port is the one place its package reaches host-kit) assembles its host from these and from its own
 * explicit adapters, so retry, lock, process and request-cancellation semantics stay genuine.
 */
export const realHostKitCapabilities = {
  runCmdStreaming,
  runCmdBackground,
  requireExecSuccess,
  isCommandTimeoutError,
  commandDeveloperDir,
  emitDiagnostic,
  withDiagnosticTimer,
  retryWithPolicy,
  isEnvTruthy,
  deadlineFromTimeoutMs: (timeoutMs: number, nowMs?: number) =>
    Deadline.fromTimeoutMs(timeoutMs, nowMs),
  isProcessAlive,
  isProcessGroupAlive,
  readProcessStartTime,
  readProcessCommand,
  signalPidsBestEffort,
  signalProcessGroupBestEffort,
  classifyOwnerLiveness,
  readHostCpuArchSync,
  findProjectRoot,
  readVersion,
  acquireProcessLock,
  withProcessLock,
  publishFileSync,
  emitRequestProgress,
  getRequestSignal,
  isRequestCanceled,
  runnerRuntimeSlot: runtimeSlot,
} as const;

/** The real host command runner, for a suite adapter that runs one genuine tool (such as `plutil`). */
export const runRealHostCommand = runCmd;
