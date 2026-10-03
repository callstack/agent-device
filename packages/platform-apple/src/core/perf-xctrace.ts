import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isIosFamily,
  isApplePlatform,
  publicPlatformString,
  type DeviceInfo,
  type PublicPlatform,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { parseXmlDocumentSync } from '@agent-device/xml';
import {
  execFailureDetails,
  requireExecSuccess,
  runCmdBackground,
  type ExecBackgroundResult,
  type ExecResult,
} from '@agent-device/host-kit/command';
import { uniqueStrings } from '@agent-device/kernel/collections';
import {
  copyHostPath,
  ensureHostDirectory,
  hostFileStat,
  makeHostTemporaryDirectory,
  readHostDirectory,
  readHostTextFile,
  removeHostPath,
  renameHostPath,
  writeHostTextFile,
} from '@agent-device/host-kit/host-file';
import { findAllXmlNodes } from './perf-xml.ts';
import {
  parseAppleTimeProfileSummary,
  type AppleTimeProfileFunction,
} from './perf-time-profile.ts';
import { IOS_DEVICECTL_DEFAULT_HINT, resolveIosDevicectlHint } from './devicectl.ts';
import { runXcrun } from './tool-provider.ts';

// Physical device tracing can take materially longer to initialize than the 1s sample window.
const IOS_DEVICE_PERF_RECORD_TIMEOUT_MS = 60_000;
const IOS_DEVICE_PERF_EXPORT_TIMEOUT_MS = 15_000;
const IOS_DEVICE_TRACE_RECORD_MAX_ATTEMPTS = 3;
const IOS_DEVICE_TRACE_RECORD_RETRY_DELAY_MS = 1_500;
const APPLE_XCTRACE_START_SETTLE_MS = 500;
const APPLE_XCTRACE_STOP_GRACE_TIMEOUT_MS = 45_000;
const APPLE_XCTRACE_STOP_FORCE_TIMEOUT_MS = 5_000;

export type AppleXctracePerfMode = 'cpu-profile' | 'trace';

type AppleXctraceRecordTarget = number[] | 'all-processes';

type AppleXctraceRecordAttempt<T> = { recorded: T } | { failure: ExecResult };

export type AppleXctraceTimedRecord = {
  startedAt: string;
  endedAt: string;
  capturedAtMs: number;
};

export type AppleXctracePerfCapture = {
  kind: 'xctrace';
  mode: AppleXctracePerfMode;
  template: string;
  outPath: string;
  appBundleId: string;
  deviceId: string;
  // approach (b): the PUBLIC leaf platform (ios/macos) surfaced in perf responses, never `apple`.
  platform: PublicPlatform;
  targetPids: number[];
  targetProcesses: string[];
  startedAt: string;
  child: ExecBackgroundResult['child'];
  wait: ExecBackgroundResult['wait'];
};

export type AppleXctracePerfResult = {
  kind: 'xctrace';
  mode: AppleXctracePerfMode;
  template: string;
  outPath: string;
  appBundleId: string;
  deviceId: string;
  // approach (b): the PUBLIC leaf platform (ios/macos) surfaced in perf responses, never `apple`.
  platform: PublicPlatform;
  targetPids: number[];
  targetProcesses: string[];
  startedAt: string;
  endedAt: string;
};

export type AppleXctraceCpuProfileReport = {
  kind: 'xctrace';
  mode: 'cpu-profile';
  template?: string;
  tracePath: string;
  reportPath: string;
  appBundleId?: string;
  generatedAt: string;
  summary: {
    runCount: number;
    tableSchemas: string[];
    sampleCount: number;
    totalSampleWeightMs: number;
    topFunctions: AppleTimeProfileFunction[];
  };
};

export async function startAppleXctracePerfCapture(params: {
  device: DeviceInfo;
  appBundleId: string;
  mode: AppleXctracePerfMode;
  template: string;
  outPath: string;
}): Promise<AppleXctracePerfCapture> {
  const target = await resolveAppleXctracePerfTarget(params.device, params.appBundleId);
  await ensureHostDirectory(path.dirname(params.outPath));
  const args = buildAppleXctraceRecordArgs({
    device: params.device,
    template: params.template,
    target: target.pids,
    outPath: params.outPath,
  });
  const startedAt = new Date().toISOString();
  const background = await recordAppleXctraceWithRetry(
    args,
    params.outPath,
    {
      device: params.device,
      appBundleId: params.appBundleId,
      failureMessage: `Failed to start Apple xctrace ${params.mode} capture for ${params.appBundleId}`,
    },
    async (): Promise<AppleXctraceRecordAttempt<ExecBackgroundResult>> => {
      const recorded = runCmdBackground('xcrun', args, { allowFailure: true });
      const immediate = await waitForImmediateAppleXctraceExit(recorded.wait);
      return immediate ? { failure: immediate } : { recorded };
    },
  );
  return {
    kind: 'xctrace',
    mode: params.mode,
    template: params.template,
    outPath: params.outPath,
    appBundleId: params.appBundleId,
    deviceId: params.device.id,
    platform: publicPlatformString(params.device),
    targetPids: target.pids,
    targetProcesses: target.processNames,
    startedAt,
    child: background.child,
    wait: background.wait,
  };
}

export async function stopAppleXctracePerfCapture(
  capture: AppleXctracePerfCapture,
  outPath = capture.outPath,
): Promise<AppleXctracePerfResult> {
  if (outPath !== capture.outPath) {
    await ensureHostDirectory(path.dirname(outPath));
  }
  const result = requireExecSuccess(
    await stopAppleXctraceProcess(capture, { failOnForcedKill: true }),
    `Failed to stop Apple xctrace ${capture.mode} capture`,
    (result) => ({
      tracePath: capture.outPath,
      captureCleanedUp: true,
      hint: resolveIosDevicePerfHint(result.stdout, result.stderr),
    }),
  );
  if (outPath !== capture.outPath) {
    await renameHostPath(capture.outPath, outPath).catch(async () => {
      await copyHostPath(capture.outPath, outPath);
      await removeHostPath(capture.outPath);
    });
  }
  await assertTracePathHasData(outPath, {
    message: 'xctrace produced no trace data',
    hint: 'Keep the Apple device unlocked and connected, keep the app active, then retry perf.',
    appBundleId: capture.appBundleId,
    deviceId: capture.deviceId,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  return {
    kind: 'xctrace',
    mode: capture.mode,
    template: capture.template,
    outPath,
    appBundleId: capture.appBundleId,
    deviceId: capture.deviceId,
    platform: capture.platform,
    targetPids: capture.targetPids,
    targetProcesses: capture.targetProcesses,
    startedAt: capture.startedAt,
    endedAt: new Date().toISOString(),
  };
}

export async function cleanupAppleXctracePerfCapture(
  capture: AppleXctracePerfCapture,
): Promise<ExecResult> {
  return await stopAppleXctraceProcess(capture, { failOnForcedKill: false });
}

export async function writeAppleXctracePerfReport(params: {
  tracePath: string;
  outPath: string;
  template?: string;
  appBundleId?: string;
}): Promise<AppleXctraceCpuProfileReport> {
  const tempDir = await makeHostTemporaryDirectory('agent-device-xctrace-report-');
  const tocPath = path.join(tempDir, 'trace-toc.xml');
  const timeProfilePath = path.join(tempDir, 'time-profile.xml');
  try {
    const tocXml = await exportAppleXctraceData({
      tracePath: params.tracePath,
      outPath: tocPath,
      query: 'toc',
      failureMessage: 'Failed to export Apple xctrace report metadata',
      failureDetails: { tracePath: params.tracePath },
    });
    const timeProfileXml = await exportAppleXctraceData({
      tracePath: params.tracePath,
      outPath: timeProfilePath,
      query: { schema: 'time-profile' },
      failureMessage: 'Failed to export Apple xctrace Time Profiler samples',
      failureDetails: { tracePath: params.tracePath },
    });
    const report = buildAppleXctracePerfReport({
      ...params,
      tocXml,
      timeProfileXml,
    });
    if (report.summary.sampleCount === 0) {
      throw new AppError('COMMAND_FAILED', 'Apple xctrace CPU report contained no samples', {
        tracePath: params.tracePath,
        tableSchemas: report.summary.tableSchemas,
        hint: 'Keep the app active while recording, then retry. Open the raw trace in Instruments if it still contains no Time Profiler samples.',
      });
    }
    await ensureHostDirectory(path.dirname(params.outPath));
    await writeHostTextFile(params.outPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await removeHostPath(tempDir).catch(() => {});
  }
}

export async function recordAppleXctraceTimedTrace(params: {
  device: DeviceInfo;
  appBundleId: string;
  tracePath: string;
  template: string;
  timeLimit: string;
  target: AppleXctraceRecordTarget;
  requireTraceData?: boolean;
  failureMessage: string;
}): Promise<AppleXctraceTimedRecord> {
  const args = buildAppleXctraceRecordArgs({
    device: params.device,
    template: params.template,
    target: params.target,
    timeLimit: params.timeLimit,
    outPath: params.tracePath,
  });
  const { result, ...record } = await recordAppleXctraceWithRetry(
    args,
    params.tracePath,
    params,
    async (): Promise<
      AppleXctraceRecordAttempt<AppleXctraceTimedRecord & { result: ExecResult }>
    > => {
      const startedAt = new Date().toISOString();
      const result = await runXcrun(args, {
        allowFailure: true,
        timeoutMs: IOS_DEVICE_PERF_RECORD_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) return { failure: result };
      return {
        recorded: {
          result,
          startedAt,
          endedAt: new Date().toISOString(),
          capturedAtMs: Date.now(),
        },
      };
    },
  );
  if (params.requireTraceData) {
    await assertTracePathHasData(params.tracePath, {
      message: `${params.failureMessage}: xctrace produced no trace data`,
      hint: 'Keep the iOS device unlocked and connected by cable, keep the app active, then retry perf.',
      appBundleId: params.appBundleId,
      deviceId: params.device.id,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return record;
}

export async function exportAppleXctraceData(params: {
  tracePath: string;
  outPath: string;
  query: 'toc' | { schema: string };
  failureMessage: string;
  failureDetails: Record<string, unknown>;
}): Promise<string> {
  const exportArgs: ['xctrace', ...string[]] = [
    'xctrace',
    'export',
    '--input',
    params.tracePath,
    ...(params.query === 'toc'
      ? ['--toc']
      : ['--xpath', `/trace-toc/run/data/table[@schema="${params.query.schema}"]`]),
    '--output',
    params.outPath,
  ];
  requireExecSuccess(
    await runXcrun(exportArgs, {
      allowFailure: true,
      timeoutMs: IOS_DEVICE_PERF_EXPORT_TIMEOUT_MS,
    }),
    params.failureMessage,
    (exportResult) => ({
      cmd: 'xcrun',
      args: exportArgs,
      ...params.failureDetails,
      hint: resolveIosDevicePerfHint(exportResult.stdout, exportResult.stderr),
    }),
  );
  return await readHostTextFile(params.outPath);
}

async function resolveAppleXctracePerfTarget(
  device: DeviceInfo,
  appBundleId: string,
): Promise<{ pids: number[]; processNames: string[] }> {
  if (!isApplePlatform(device.platform)) {
    throw new AppError('UNSUPPORTED_OPERATION', 'Apple xctrace perf is not supported on Android.', {
      platform: device.platform,
      hint: 'Android native profiling belongs to the Android perf rollout and is not implemented under Apple xctrace.',
    });
  }
  const { readAppleProcessSamples, resolveAppleExecutable, resolveIosDevicePerfTarget } =
    await import('./perf-target.ts');
  if (isIosFamily(device) && device.kind === 'device') {
    const processes = await resolveIosDevicePerfTarget(device, appBundleId);
    return {
      pids: processes.map((processInfo) => processInfo.pid),
      processNames: uniqueStrings(
        processes.map((processInfo) => path.basename(fileURLToPath(processInfo.executable))),
      ),
    };
  }

  const executable = await resolveAppleExecutable(device, appBundleId);
  const processes = await readAppleProcessSamples(device, executable);
  if (processes.length === 0) {
    throw new AppError('COMMAND_FAILED', `No running process found for ${appBundleId}`, {
      appBundleId,
      deviceId: device.id,
      hint: 'Run open <app> for this session again to ensure the Apple app is active, then retry perf.',
    });
  }
  return {
    pids: processes.map((processInfo) => processInfo.pid),
    processNames: [executable.executableName],
  };
}

function buildAppleXctraceRecordArgs(params: {
  device: DeviceInfo;
  template: string;
  target: AppleXctraceRecordTarget;
  timeLimit?: string;
  outPath: string;
}): ['xctrace', ...string[]] {
  return [
    'xctrace',
    'record',
    '--template',
    params.template,
    ...(isIosFamily(params.device) ? ['--device', params.device.id] : []),
    ...(params.target === 'all-processes'
      ? ['--all-processes']
      : params.target.flatMap((pid) => ['--attach', String(pid)])),
    ...(params.timeLimit ? ['--time-limit', params.timeLimit] : []),
    '--output',
    params.outPath,
    '--quiet',
    '--no-prompt',
  ];
}

async function recordAppleXctraceWithRetry<T>(
  args: string[],
  tracePath: string,
  context: {
    device: DeviceInfo;
    appBundleId: string;
    failureMessage: string;
  },
  attemptRecord: () => Promise<AppleXctraceRecordAttempt<T>>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    await prepareAppleTraceRecordRetry(tracePath, attempt);
    const outcome = await attemptRecord();
    if ('recorded' in outcome) return outcome.recorded;
    if (
      attempt < IOS_DEVICE_TRACE_RECORD_MAX_ATTEMPTS &&
      isRetryableIosDeviceTraceRecordFailure(outcome.failure)
    ) {
      continue;
    }
    const { failure } = outcome;
    throw new AppError(
      'COMMAND_FAILED',
      context.failureMessage,
      execFailureDetails(failure, {
        cmd: 'xcrun',
        args,
        appBundleId: context.appBundleId,
        deviceId: context.device.id,
        hint: resolveIosDevicePerfHint(failure.stdout, failure.stderr),
      }),
    );
  }
}

export function isRetryableIosDeviceTraceRecordFailure(result: {
  stdout: string;
  stderr: string;
}): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    text.includes('_lockkperf') ||
    text.includes('could not lock kperf') ||
    text.includes('likely another session just started')
  );
}

async function prepareAppleTraceRecordRetry(tracePath: string, attempt: number): Promise<void> {
  if (attempt <= 1) return;
  await removeHostPath(tracePath).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, IOS_DEVICE_TRACE_RECORD_RETRY_DELAY_MS));
}

async function waitForImmediateAppleXctraceExit(
  wait: Promise<ExecResult>,
): Promise<ExecResult | undefined> {
  return await Promise.race([
    wait,
    new Promise<undefined>((resolve) => setTimeout(resolve, APPLE_XCTRACE_START_SETTLE_MS)),
  ]);
}

async function stopAppleXctraceProcess(
  capture: AppleXctracePerfCapture,
  options: { failOnForcedKill: boolean },
): Promise<ExecResult> {
  capture.child.kill('SIGINT');
  const graceful = await waitForAppleXctraceExit(capture.wait, APPLE_XCTRACE_STOP_GRACE_TIMEOUT_MS);
  if (graceful) return graceful;

  capture.child.kill('SIGKILL');
  const forced = await waitForAppleXctraceExit(capture.wait, APPLE_XCTRACE_STOP_FORCE_TIMEOUT_MS);
  if (forced && !options.failOnForcedKill) return forced;
  if (forced) {
    // exec-guard-allow: force-kill timeout — the timeout message beats
    // whatever partial stderr the killed xctrace left behind.
    throw new AppError('COMMAND_FAILED', 'Timed out waiting for Apple xctrace capture to stop', {
      exitCode: forced.exitCode,
      stdout: forced.stdout,
      stderr: forced.stderr,
      tracePath: capture.outPath,
      captureCleanedUp: true,
      forcedKill: true,
      hint: 'xctrace did not finish after SIGINT, so it was force-killed. Retry the perf command after confirming no other xctrace session is active.',
    });
  }

  throw new AppError(
    'COMMAND_FAILED',
    'Timed out waiting for Apple xctrace capture to stop after SIGKILL',
    {
      tracePath: capture.outPath,
      captureCleanedUp: false,
      forcedKill: true,
      hint: 'xctrace did not exit after SIGKILL. Inspect running xctrace processes before retrying.',
    },
  );
}

async function waitForAppleXctraceExit(
  wait: Promise<ExecResult>,
  timeoutMs: number,
): Promise<ExecResult | undefined> {
  const result = await Promise.race([
    wait,
    new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  return result;
}

async function assertTracePathHasData(
  tracePath: string,
  context: {
    message: string;
    hint: string;
    appBundleId?: string;
    deviceId?: string;
    stdout: string;
    stderr: string;
  },
): Promise<void> {
  const stat = await hostFileStat(tracePath).catch(() => null);
  const hasTrace =
    stat?.isDirectory() === true
      ? (await readHostDirectory(tracePath).catch(() => [])).length > 0
      : (stat?.size ?? 0) > 0;
  if (hasTrace) return;
  throw new AppError('COMMAND_FAILED', context.message, {
    tracePath,
    appBundleId: context.appBundleId,
    deviceId: context.deviceId,
    stdout: context.stdout,
    stderr: context.stderr,
    hint: context.hint,
  });
}

function buildAppleXctracePerfReport(params: {
  tracePath: string;
  outPath: string;
  template?: string;
  appBundleId?: string;
  tocXml: string;
  timeProfileXml: string;
}): AppleXctraceCpuProfileReport {
  const document = parseXmlDocumentSync(params.tocXml);
  const runs = findAllXmlNodes(document, (node) => node.name === 'run');
  const tableSchemas = uniqueStrings(
    findAllXmlNodes(document, (node) => node.name === 'table')
      .map((node) => node.attributes.schema)
      .filter((schema): schema is string => typeof schema === 'string' && schema.length > 0),
  ).sort();
  const timeProfile = parseAppleTimeProfileSummary(params.timeProfileXml);
  return {
    kind: 'xctrace',
    mode: 'cpu-profile',
    template: params.template,
    tracePath: params.tracePath,
    reportPath: params.outPath,
    appBundleId: params.appBundleId,
    generatedAt: new Date().toISOString(),
    summary: {
      runCount: runs.length,
      tableSchemas,
      ...timeProfile,
    },
  };
}

export function resolveIosDevicePerfHint(stdout: string, stderr: string): string {
  const devicectlHint = resolveIosDevicectlHint(stdout, stderr);
  if (devicectlHint) return devicectlHint;
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (text.includes('no device matched') || text.includes('failed to find device')) {
    return IOS_DEVICECTL_DEFAULT_HINT;
  }
  if (text.includes('timed out')) {
    return 'Keep the iOS device unlocked and connected by cable, keep the app active, then retry perf.';
  }
  return 'Ensure the iOS device is unlocked, trusted, visible to xctrace, and the target app stays active while perf samples it.';
}
