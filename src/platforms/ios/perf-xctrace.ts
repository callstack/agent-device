import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isApplePlatform, type DeviceInfo } from '../../utils/device.ts';
import { AppError } from '../../utils/errors.ts';
import { runCmdBackground, type ExecBackgroundResult, type ExecResult } from '../../utils/exec.ts';
import { uniqueStrings } from '../../daemon/action-utils.ts';
import { findAllXmlNodes } from './perf-xml.ts';
import {
  isRetryableIosDeviceTraceRecordFailure,
  prepareAppleTraceRecordRetry,
  readAppleProcessSamples,
  resolveAppleExecutable,
  resolveIosDevicePerfHint,
  resolveIosDevicePerfTarget,
} from './perf.ts';
import { runXcrun } from './tool-provider.ts';
import { parseXmlDocumentSync } from './xml.ts';

const IOS_DEVICE_PERF_EXPORT_TIMEOUT_MS = 15_000;
const IOS_DEVICE_TRACE_RECORD_MAX_ATTEMPTS = 3;
const IOS_DEVICE_TRACE_RECORD_RETRY_DELAY_MS = 1_500;
const APPLE_XCTRACE_START_SETTLE_MS = 500;
const APPLE_XCTRACE_STOP_GRACE_TIMEOUT_MS = 45_000;
const APPLE_XCTRACE_STOP_FORCE_TIMEOUT_MS = 5_000;

export type AppleXctracePerfMode = 'cpu-profile' | 'trace';

export type AppleXctracePerfCapture = {
  kind: 'xctrace';
  mode: AppleXctracePerfMode;
  template: string;
  outPath: string;
  appBundleId: string;
  deviceId: string;
  platform: DeviceInfo['platform'];
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
  platform: DeviceInfo['platform'];
  targetPids: number[];
  targetProcesses: string[];
  startedAt: string;
  endedAt: string;
};

export type AppleXctracePerfReport = {
  kind: 'xctrace';
  mode: AppleXctracePerfMode;
  template?: string;
  tracePath: string;
  reportPath: string;
  appBundleId?: string;
  generatedAt: string;
  summary: {
    runCount: number;
    tableSchemas: string[];
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
  await fs.mkdir(path.dirname(params.outPath), { recursive: true });
  const args = buildAppleXctraceRecordArgs({
    device: params.device,
    template: params.template,
    targetPids: target.pids,
    outPath: params.outPath,
  });
  const startedAt = new Date().toISOString();
  const background = await startAppleXctraceRecordWithRetry(args, params.outPath, {
    device: params.device,
    appBundleId: params.appBundleId,
    failureMessage: `Failed to start Apple xctrace ${params.mode} capture for ${params.appBundleId}`,
  });
  return {
    kind: 'xctrace',
    mode: params.mode,
    template: params.template,
    outPath: params.outPath,
    appBundleId: params.appBundleId,
    deviceId: params.device.id,
    platform: params.device.platform,
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
    await fs.mkdir(path.dirname(outPath), { recursive: true });
  }
  const result = await stopAppleXctraceProcess(capture, { failOnForcedKill: true });
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', `Failed to stop Apple xctrace ${capture.mode} capture`, {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      tracePath: capture.outPath,
      captureCleanedUp: true,
      hint: resolveIosDevicePerfHint(result.stdout, result.stderr),
    });
  }
  if (outPath !== capture.outPath) {
    await fs.rename(capture.outPath, outPath).catch(async () => {
      await fs.cp(capture.outPath, outPath, { recursive: true });
      await fs.rm(capture.outPath, { recursive: true, force: true });
    });
  }
  await assertTracePathHasData(outPath, {
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
  mode: AppleXctracePerfMode;
  template?: string;
  appBundleId?: string;
}): Promise<AppleXctracePerfReport> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-xctrace-report-'));
  const tocPath = path.join(tempDir, 'trace-toc.xml');
  try {
    const exportArgs = [
      'xctrace',
      'export',
      '--input',
      params.tracePath,
      '--xpath',
      '/trace-toc',
      '--output',
      tocPath,
    ];
    const exportResult = await runXcrun(exportArgs, {
      allowFailure: true,
      timeoutMs: IOS_DEVICE_PERF_EXPORT_TIMEOUT_MS,
    });
    if (exportResult.exitCode !== 0) {
      throw new AppError('COMMAND_FAILED', 'Failed to export Apple xctrace report metadata', {
        cmd: 'xcrun',
        args: exportArgs,
        exitCode: exportResult.exitCode,
        stdout: exportResult.stdout,
        stderr: exportResult.stderr,
        tracePath: params.tracePath,
        hint: resolveIosDevicePerfHint(exportResult.stdout, exportResult.stderr),
      });
    }
    const report = buildAppleXctracePerfReport({
      ...params,
      tocXml: await fs.readFile(tocPath, 'utf8'),
    });
    await fs.mkdir(path.dirname(params.outPath), { recursive: true });
    await fs.writeFile(params.outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
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
  if (device.platform === 'ios' && device.kind === 'device') {
    const processes = await resolveIosDevicePerfTarget(device, appBundleId);
    return {
      pids: processes.map((process) => process.pid),
      processNames: uniqueStrings(
        processes.map((process) => path.basename(fileURLToPath(process.executable))),
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
    pids: processes.map((process) => process.pid),
    processNames: [executable.executableName],
  };
}

function buildAppleXctraceRecordArgs(params: {
  device: DeviceInfo;
  template: string;
  targetPids: number[];
  outPath: string;
}): string[] {
  return [
    'xctrace',
    'record',
    '--template',
    params.template,
    ...(params.device.platform === 'ios' ? ['--device', params.device.id] : []),
    ...params.targetPids.flatMap((pid) => ['--attach', String(pid)]),
    '--output',
    params.outPath,
    '--quiet',
    '--no-prompt',
  ];
}

async function startAppleXctraceRecordWithRetry(
  args: string[],
  tracePath: string,
  context: {
    device: DeviceInfo;
    appBundleId: string;
    failureMessage: string;
  },
): Promise<ExecBackgroundResult> {
  let lastImmediateFailure: ExecResult | undefined;
  for (let attempt = 1; attempt <= IOS_DEVICE_TRACE_RECORD_MAX_ATTEMPTS; attempt += 1) {
    await prepareAppleTraceRecordRetry(tracePath, attempt, IOS_DEVICE_TRACE_RECORD_RETRY_DELAY_MS);
    const background = runCmdBackground('xcrun', args, { allowFailure: true });
    const immediate = await waitForImmediateAppleXctraceExit(background.wait);
    if (!immediate) return background;
    lastImmediateFailure = immediate;
    if (!isRetryableIosDeviceTraceRecordFailure(immediate)) break;
  }

  const failure = lastImmediateFailure ?? { stdout: '', stderr: '', exitCode: 1 };
  throw new AppError('COMMAND_FAILED', context.failureMessage, {
    cmd: 'xcrun',
    args,
    exitCode: failure.exitCode,
    stdout: failure.stdout,
    stderr: failure.stderr,
    appBundleId: context.appBundleId,
    deviceId: context.device.id,
    hint: resolveIosDevicePerfHint(failure.stdout, failure.stderr),
  });
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
    appBundleId?: string;
    deviceId?: string;
    stdout: string;
    stderr: string;
  },
): Promise<void> {
  const stat = await fs.stat(tracePath).catch(() => null);
  const hasTrace =
    stat?.isDirectory() === true
      ? (await fs.readdir(tracePath).catch(() => [])).length > 0
      : (stat?.size ?? 0) > 0;
  if (hasTrace) return;
  throw new AppError('COMMAND_FAILED', 'xctrace produced no trace data', {
    tracePath,
    appBundleId: context.appBundleId,
    deviceId: context.deviceId,
    stdout: context.stdout,
    stderr: context.stderr,
    hint: 'Keep the Apple device unlocked and connected, keep the app active, then retry perf.',
  });
}

function buildAppleXctracePerfReport(params: {
  tracePath: string;
  outPath: string;
  mode: AppleXctracePerfMode;
  template?: string;
  appBundleId?: string;
  tocXml: string;
}): AppleXctracePerfReport {
  const document = parseXmlDocumentSync(params.tocXml);
  const runs = findAllXmlNodes(document, (node) => node.name === 'run');
  const tableSchemas = uniqueStrings(
    findAllXmlNodes(document, (node) => node.name === 'table')
      .map((node) => node.attributes.schema)
      .filter((schema): schema is string => typeof schema === 'string' && schema.length > 0),
  ).sort();
  return {
    kind: 'xctrace',
    mode: params.mode,
    template: params.template,
    tracePath: params.tracePath,
    reportPath: params.outPath,
    appBundleId: params.appBundleId,
    generatedAt: new Date().toISOString(),
    summary: {
      runCount: runs.length,
      tableSchemas,
    },
  };
}
