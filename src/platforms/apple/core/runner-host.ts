import type { AppleRunnerHost } from '@agent-device/platform-apple/runner';
import { publishFileSync } from '../../../utils/atomic-file.ts';
import { resolveIosSimulatorDeviceSetPath } from '../../../utils/device-isolation.ts';
import { emitDiagnostic, withDiagnosticTimer } from '../../../utils/diagnostics.ts';
import {
  requireExecSuccess,
  runCmdBackground,
  runCmdStreaming,
  runCmdSync,
} from '../../../utils/exec.ts';
import {
  isProcessAlive,
  isProcessGroupAlive,
  readProcessCommand,
  readProcessStartTime,
  signalPidsBestEffort,
  signalProcessGroupBestEffort,
} from '../../../utils/host-process.ts';
import { withKeyedLock } from '../../../utils/keyed-lock.ts';
import { classifyOwnerLiveness } from '../../../utils/owner-identity.ts';
import { isRecord } from '../../../utils/parsing.ts';
import { acquireProcessLock } from '../../../utils/process-lock.ts';
import { Deadline, isEnvTruthy, retryWithPolicy } from '../../../utils/retry.ts';
import { parseBooleanLiteral } from '../../../utils/source-value.ts';
import { createTtlMemo } from '../../../utils/ttl-memo.ts';
import { findProjectRoot, readVersion } from '../../../utils/version.ts';
import { getRequestSignal, isRequestCanceled } from '../../../request/cancel.ts';
import { emitRequestProgress } from '../../../request/progress.ts';
import { bootFailureHint, classifyBootFailure } from '../../boot-diagnostics.ts';
import { resolveIosPhysicalDeviceControl } from './physical-device-control.ts';
import { visitXmlPlistEntries } from './plist-xml.ts';
import { getRunnerLeaseOwnerStateDir } from './runner-owner-state.ts';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { readApplePlistJson, runAppleToolCommand, runXcrun } from './tool-provider.ts';

/**
 * The real host capabilities for `@agent-device/platform-apple/runner`: the one place
 * the runner package's port meets the root-owned utilities. Consumed by the
 * production composition module (`runner-client.ts`) and by the vitest
 * `apple-runner` project setup, which installs the same capabilities as
 * overridable test defaults.
 */
export const appleRunnerHost: AppleRunnerHost = {
  runCmdStreaming,
  runCmdSync,
  runCmdBackground,
  requireExecSuccess,
  emitDiagnostic,
  withDiagnosticTimer,
  retryWithPolicy,
  isEnvTruthy,
  deadlineFromTimeoutMs: (timeoutMs, nowMs) => Deadline.fromTimeoutMs(timeoutMs, nowMs),
  isProcessAlive,
  isProcessGroupAlive,
  readProcessStartTime,
  readProcessCommand,
  signalPidsBestEffort,
  signalProcessGroupBestEffort,
  findProjectRoot,
  readVersion,
  acquireProcessLock,
  withKeyedLock,
  publishFileSync,
  classifyOwnerLiveness,
  createTtlMemo,
  parseBooleanLiteral,
  isRecord,
  resolveIosSimulatorDeviceSetPath,
  emitRequestProgress,
  getRequestSignal,
  isRequestCanceled,
  classifyBootFailure,
  bootFailureHint,
  runAppleToolCommand,
  runXcrun,
  readApplePlistJson,
  buildSimctlArgsForDevice,
  resolveIosPhysicalDeviceControl,
  visitXmlPlistEntries,
  leaseOwnerStateDir: getRunnerLeaseOwnerStateDir,
};
