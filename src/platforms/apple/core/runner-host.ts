import type { AppleRunnerHost } from '@agent-device/platform-apple/runner';
import {
  publishFileSync,
  resolveIosSimulatorDeviceSetPath,
  acquireProcessLock,
} from '@agent-device/host-kit/fs';

import {
  emitDiagnostic,
  withDiagnosticTimer,
  requireExecSuccess,
  runCmdBackground,
  runCmdStreaming,
  runCmdSync,
  isProcessAlive,
  isProcessGroupAlive,
  readProcessCommand,
  readProcessStartTime,
  signalPidsBestEffort,
  signalProcessGroupBestEffort,
  classifyOwnerLiveness,
  Deadline,
  isEnvTruthy,
  retryWithPolicy,
} from '@agent-device/host-kit/exec';

import { withKeyedLock } from '@agent-device/kernel/keyed-lock';

import {
  isRecord,
  parseBooleanLiteral,
  createTtlMemo,
  findProjectRoot,
  readVersion,
} from '@agent-device/host-kit/values';

import {
  getRequestSignal,
  isRequestCanceled,
  emitRequestProgress,
} from '@agent-device/host-kit/request';

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
