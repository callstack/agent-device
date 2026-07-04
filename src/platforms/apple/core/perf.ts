import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isIosFamily,
  isMacOs,
  publicPlatformString,
  type DeviceInfo,
  type PublicPlatform,
} from '../../../kernel/device.ts';
import { AppError } from '../../../kernel/errors.ts';
import { execFailureDetails, requireExecSuccess, type ExecResult } from '../../../utils/exec.ts';
import { splitNonEmptyTrimmedLines } from '../../../utils/parsing.ts';
import { roundPercent } from '../../perf-utils.ts';
import { uniqueStrings } from '../../../daemon/action-utils.ts';
import {
  IOS_DEVICECTL_DEFAULT_HINT,
  listIosDeviceApps,
  listIosDeviceProcesses,
  resolveIosDevicectlHint,
  type IosDeviceProcessInfo,
} from './devicectl.ts';
import { readInfoPlistString } from './plist.ts';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { runAppleToolCommand, runXcrun } from './tool-provider.ts';
import { parseXmlDocumentSync, type XmlNode } from './xml.ts';
import {
  findAllXmlNodes,
  findFirstXmlNode,
  parseDirectXmlNumber,
  readSchemaColumns,
  resolveXmlNumber,
} from './perf-xml.ts';
import {
  APPLE_FRAME_SAMPLE_DESCRIPTION,
  APPLE_FRAME_SAMPLE_METHOD,
  parseAppleFramePerfSample,
  type AppleFramePerfSample,
} from './perf-frame.ts';

const APPLE_CPU_SAMPLE_METHOD = 'ps-process-snapshot';
const APPLE_MEMORY_SAMPLE_METHOD = 'ps-process-snapshot';
const IOS_DEVICE_CPU_SAMPLE_METHOD = 'xctrace-activity-monitor';
const IOS_DEVICE_MEMORY_SAMPLE_METHOD = 'xctrace-activity-monitor';
export const APPLE_MEMGRAPH_SNAPSHOT_METHOD = 'leaks-output-graph';
export const APPLE_MEMGRAPH_SNAPSHOT_DESCRIPTION =
  'Memory graph captured with leaks --outputGraph for host-visible Apple app processes.';

const APPLE_PERF_TIMEOUT_MS = 15_000;
const APPLE_MEMORY_SNAPSHOT_TIMEOUT_MS = 120_000;
// Physical device tracing can take materially longer to initialize than the 1s sample window.
const IOS_DEVICE_PERF_RECORD_TIMEOUT_MS = 60_000;
const IOS_DEVICE_PERF_EXPORT_TIMEOUT_MS = 15_000;
const IOS_DEVICE_PERF_TRACE_DURATION = '1s';
const IOS_DEVICE_FRAME_TRACE_DURATION = '2s';
const IOS_DEVICE_TRACE_RECORD_MAX_ATTEMPTS = 3;
const IOS_DEVICE_TRACE_RECORD_RETRY_DELAY_MS = 1_500;

export type AppleCpuPerfSample = {
  usagePercent: number;
  measuredAt: string;
  method: typeof APPLE_CPU_SAMPLE_METHOD | typeof IOS_DEVICE_CPU_SAMPLE_METHOD;
  matchedProcesses: string[];
};

export type AppleMemoryPerfSample = {
  residentMemoryKb: number;
  measuredAt: string;
  method: typeof APPLE_MEMORY_SAMPLE_METHOD | typeof IOS_DEVICE_MEMORY_SAMPLE_METHOD;
  matchedProcesses: string[];
};

export type AppleMemorySnapshotResult =
  | {
      available: true;
      kind: 'memgraph';
      path: string;
      sizeBytes: number;
      measuredAt: string;
      method: typeof APPLE_MEMGRAPH_SNAPSHOT_METHOD;
      appBundleId: string;
      pid: number;
      processName: string;
      support: ReturnType<typeof buildAppleMemorySnapshotSupport>;
    }
  | {
      available: false;
      kind: 'memgraph';
      reason: string;
      hint: string;
      support: ReturnType<typeof buildAppleMemorySnapshotSupport>;
    };

export type AppleProcessSample = {
  pid: number;
  cpuPercent: number;
  rssKb: number;
  command: string;
};

type IosDevicePerfProcessSample = {
  pid: number;
  processName: string;
  cpuTimeNs: number | null;
  residentMemoryBytes: number | null;
};

type IosDevicePerfCapture = {
  capturedAtMs: number;
  xml: string;
};

type IosDeviceFramePerfCapture = {
  windowStartedAt: string;
  windowEndedAt: string;
  hitchesXml: string;
  frameLifetimesXml: string;
  displayInfoXml?: string;
};

type IosDeviceTraceRecord = {
  startedAt: string;
  endedAt: string;
  capturedAtMs: number;
};

type IosDeviceTraceRecordAttempt = IosDeviceTraceRecord & {
  result: ExecResult;
};

export async function sampleApplePerfMetrics(
  device: DeviceInfo,
  appBundleId: string,
): Promise<{ cpu: AppleCpuPerfSample; memory: AppleMemoryPerfSample }> {
  if (isIosFamily(device) && device.kind === 'device') {
    return await sampleIosDevicePerfMetrics(device, appBundleId);
  }

  const executable = await resolveAppleExecutable(device, appBundleId);
  const processes = await readAppleProcessSamples(device, executable);
  if (processes.length === 0) {
    throw new AppError('COMMAND_FAILED', `No running process found for ${appBundleId}`, {
      appBundleId,
      hint: 'Run open <app> for this session again to ensure the Apple app is active, then retry perf.',
    });
  }

  const measuredAt = new Date().toISOString();
  return buildApplePerfSamples({
    usagePercent: processes.reduce((total, process) => total + process.cpuPercent, 0),
    residentMemoryKb: processes.reduce((total, process) => total + process.rssKb, 0),
    measuredAt,
    matchedProcesses: [executable.executableName],
    cpuMethod: APPLE_CPU_SAMPLE_METHOD,
    memoryMethod: APPLE_MEMORY_SAMPLE_METHOD,
  });
}

export async function captureAppleMemorySnapshot(
  device: DeviceInfo,
  appBundleId: string,
  outPath: string,
): Promise<AppleMemorySnapshotResult> {
  const support = buildAppleMemorySnapshotSupport(device);
  if (!support.memgraph) {
    return {
      available: false,
      kind: 'memgraph',
      reason: support.reason,
      hint: support.hint,
      support,
    };
  }

  const target = await resolveAppleMemorySnapshotTarget(device, appBundleId, support);
  if (target.available === false) return target;
  const { process } = target;
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const hadLocalArtifact = await fileExists(outPath);
  let result: ExecResult;
  try {
    result = await runAppleMemorySnapshotTool(device, outPath, process.pid);
  } catch (error) {
    await cleanupLocalArtifact(outPath, hadLocalArtifact);
    throw annotateAppleMemorySnapshotToolError(device, appBundleId, process, outPath, error);
  }
  if (result.exitCode !== 0) {
    await cleanupLocalArtifact(outPath, hadLocalArtifact);
    // fallow-ignore-next-line code-duplication
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to capture Apple memgraph for ${appBundleId}`,
      execFailureDetails(result, {
        kind: 'memgraph',
        appBundleId,
        pid: process.pid,
        processName: path.basename(readProcessCommandToken(process.command)),
        path: outPath,
        hint: resolveAppleMemorySnapshotHint(device, result.stdout, result.stderr),
      }),
    );
  }

  const stat = await fs.stat(outPath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0) {
    await cleanupLocalArtifact(outPath, hadLocalArtifact);
    throw new AppError('COMMAND_FAILED', 'Apple memgraph artifact is missing or empty', {
      kind: 'memgraph',
      appBundleId,
      pid: process.pid,
      path: outPath,
      hint: 'Retry with a writable --out path. If the file is still empty, run with --debug and inspect leaks output.',
    });
  }

  return {
    available: true,
    kind: 'memgraph',
    path: outPath,
    sizeBytes: stat.size,
    measuredAt: new Date().toISOString(),
    method: APPLE_MEMGRAPH_SNAPSHOT_METHOD,
    appBundleId,
    pid: process.pid,
    processName: path.basename(readProcessCommandToken(process.command)),
    support,
  };
}

async function runAppleMemorySnapshotTool(
  device: DeviceInfo,
  outPath: string,
  pid: number,
): Promise<ExecResult> {
  if (isMacOs(device)) {
    return await runAppleToolCommand('leaks', [`--outputGraph=${outPath}`, String(pid)], {
      allowFailure: true,
      timeoutMs: APPLE_MEMORY_SNAPSHOT_TIMEOUT_MS,
    });
  }
  return await runXcrun(
    buildSimctlArgsForDevice(device, [
      'spawn',
      device.id,
      'leaks',
      `--outputGraph=${outPath}`,
      String(pid),
    ]),
    { allowFailure: true, timeoutMs: APPLE_MEMORY_SNAPSHOT_TIMEOUT_MS },
  );
}

function annotateAppleMemorySnapshotToolError(
  device: DeviceInfo,
  appBundleId: string,
  process: AppleProcessSample,
  outPath: string,
  error: unknown,
): AppError {
  if (error instanceof AppError) {
    const details = error.details ?? {};
    return new AppError(
      error.code,
      `Failed to capture Apple memgraph for ${appBundleId}`,
      {
        ...details,
        kind: 'memgraph',
        appBundleId,
        pid: process.pid,
        processName: path.basename(readProcessCommandToken(process.command)),
        path: outPath,
        hint: resolveAppleMemorySnapshotHint(
          device,
          typeof details.stdout === 'string' ? details.stdout : '',
          typeof details.stderr === 'string' && details.stderr.length > 0
            ? details.stderr
            : error.message,
        ),
      },
      error,
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `Failed to capture Apple memgraph for ${appBundleId}`,
    {
      kind: 'memgraph',
      appBundleId,
      pid: process.pid,
      processName: path.basename(readProcessCommandToken(process.command)),
      path: outPath,
      hint: 'Retry perf memory snapshot. If it still fails, run with --debug and inspect leaks output.',
    },
    error,
  );
}

// fallow-ignore-next-line code-duplication
async function fileExists(filePath: string): Promise<boolean> {
  return await fs
    .stat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function cleanupLocalArtifact(filePath: string, existedBefore: boolean): Promise<void> {
  if (existedBefore) return;
  await fs.rm(filePath, { force: true }).catch(() => {});
}

export async function sampleAppleFramePerf(
  device: DeviceInfo,
  appBundleId: string,
): Promise<AppleFramePerfSample> {
  if (!isIosFamily(device) || device.kind !== 'device') {
    throw new AppError(
      'COMMAND_FAILED',
      'Apple frame-health sampling is currently available only on connected iOS devices.',
      {
        metric: 'fps',
        platform: publicPlatformString(device),
        deviceKind: device.kind,
      },
    );
  }

  const processes = await resolveIosDevicePerfTarget(device, appBundleId);
  const capture = await captureIosDeviceFramePerf(device, appBundleId, processes);
  return parseAppleFramePerfSample({
    hitchesXml: capture.hitchesXml,
    frameLifetimesXml: capture.frameLifetimesXml,
    displayInfoXml: capture.displayInfoXml,
    processIds: processes.map((process) => process.pid),
    processNames: uniqueStrings(
      processes.map((process) => path.basename(fileURLToPath(process.executable))),
    ),
    windowStartedAt: capture.windowStartedAt,
    windowEndedAt: capture.windowEndedAt,
    measuredAt: capture.windowEndedAt,
  });
}

export function buildAppleFrameSamplingMetadata(device: DeviceInfo): Record<string, unknown> {
  return isIosFamily(device) && device.kind === 'device'
    ? {
        method: APPLE_FRAME_SAMPLE_METHOD,
        description: APPLE_FRAME_SAMPLE_DESCRIPTION,
        unit: 'percent',
        primaryField: 'droppedFramePercent',
        window: `short ${IOS_DEVICE_FRAME_TRACE_DURATION} xctrace Animation Hitches record of the active app process`,
        resetsAfterRead: false,
      }
    : {
        method: APPLE_FRAME_SAMPLE_METHOD,
        description:
          'Unavailable on iOS simulators and macOS because local Apple tooling does not expose reliable app frame hitches for these targets.',
        unit: 'percent',
        primaryField: 'droppedFramePercent',
      };
}

export function buildAppleSamplingMetadata(device: DeviceInfo): Record<string, unknown> {
  const fps = buildAppleFrameSamplingMetadata(device);
  if (isIosFamily(device) && device.kind === 'device') {
    return {
      fps,
      memory: {
        method: IOS_DEVICE_MEMORY_SAMPLE_METHOD,
        description:
          'Resident memory snapshot from a short xctrace Activity Monitor sample on the connected iOS device.',
        unit: 'kB',
      },
      cpu: {
        method: IOS_DEVICE_CPU_SAMPLE_METHOD,
        description:
          'Recent CPU usage snapshot from a short xctrace Activity Monitor sample on the connected iOS device.',
        unit: 'percent',
      },
    };
  }

  const source = isMacOs(device)
    ? 'host ps for the running macOS app executable resolved from the bundle ID.'
    : 'xcrun simctl spawn ps, with host ps fallback, for the running iOS simulator app executable resolved from the bundle ID.';
  return {
    fps,
    memory: {
      method: APPLE_MEMORY_SAMPLE_METHOD,
      description: `Resident memory snapshot from ${source}`,
      unit: 'kB',
    },
    cpu: {
      method: APPLE_CPU_SAMPLE_METHOD,
      description: `Recent CPU usage snapshot from ${source}`,
      unit: 'percent',
    },
  };
}

export function buildAppleMemorySnapshotSupport(device: DeviceInfo): {
  // approach (b): emit the PUBLIC leaf platform (ios/macos), never the internal `apple`.
  platform: PublicPlatform;
  deviceKind: DeviceInfo['kind'];
  memgraph: boolean;
  method: typeof APPLE_MEMGRAPH_SNAPSHOT_METHOD;
  reason: string;
  hint: string;
} {
  if (isIosFamily(device) && device.kind === 'device') {
    return {
      platform: publicPlatformString(device),
      deviceKind: device.kind,
      memgraph: false,
      method: APPLE_MEMGRAPH_SNAPSHOT_METHOD,
      reason:
        'Physical iOS device memgraph capture is not exposed through reliable local agent-device tooling.',
      hint: 'Use perf memory sample for a compact resident-memory reading, or reproduce on an iOS simulator/macOS target for memgraph capture.',
    };
  }
  if (isIosFamily(device) && device.kind === 'simulator') {
    return {
      platform: publicPlatformString(device),
      deviceKind: device.kind,
      memgraph: true,
      method: APPLE_MEMGRAPH_SNAPSHOT_METHOD,
      reason: 'iOS simulator processes are host-visible through simctl spawn leaks.',
      hint: 'Keep the simulator app running in the foreground while the memgraph is captured.',
    };
  }
  if (isMacOs(device)) {
    return {
      platform: publicPlatformString(device),
      deviceKind: device.kind,
      memgraph: true,
      method: APPLE_MEMGRAPH_SNAPSHOT_METHOD,
      reason: 'macOS app processes are host-visible to leaks --outputGraph.',
      hint: 'Grant Terminal/agent process permissions if macOS denies process inspection.',
    };
  }
  return {
    platform: publicPlatformString(device),
    deviceKind: device.kind,
    memgraph: false,
    method: APPLE_MEMGRAPH_SNAPSHOT_METHOD,
    reason: 'Apple memgraph capture is available only for iOS simulator and macOS app sessions.',
    hint: 'Use perf memory sample on supported app sessions, or rerun against iOS simulator/macOS for memgraph capture.',
  };
}

async function captureIosDeviceFramePerf(
  device: DeviceInfo,
  appBundleId: string,
  processes: IosDeviceProcessInfo[],
): Promise<IosDeviceFramePerfCapture> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-frame-perf-'));
  const tracePath = path.join(tempDir, 'animation-hitches.trace');
  const hitchesPath = path.join(tempDir, 'hitches.xml');
  const frameLifetimesPath = path.join(tempDir, 'frame-lifetimes.xml');
  const displayInfoPath = path.join(tempDir, 'display-info.xml');
  try {
    const record = await recordIosDeviceTrace({
      device,
      appBundleId,
      tracePath,
      template: 'Animation Hitches',
      duration: IOS_DEVICE_FRAME_TRACE_DURATION,
      targetPids: processes.map((process) => process.pid),
      validateTraceOutput: true,
      failureMessage: `Failed to record iOS frame-health sample for ${appBundleId}`,
    });
    await exportIosDevicePerfTable(device, appBundleId, tracePath, 'hitches', hitchesPath);
    await exportIosDevicePerfTable(
      device,
      appBundleId,
      tracePath,
      'hitches-frame-lifetimes',
      frameLifetimesPath,
    );
    const hasDisplayInfo = await exportOptionalIosDevicePerfTable(
      device,
      appBundleId,
      tracePath,
      'device-display-info',
      displayInfoPath,
    );
    return {
      windowStartedAt: record.startedAt,
      windowEndedAt: record.endedAt,
      hitchesXml: await fs.readFile(hitchesPath, 'utf8'),
      frameLifetimesXml: await fs.readFile(frameLifetimesPath, 'utf8'),
      displayInfoXml: hasDisplayInfo ? await fs.readFile(displayInfoPath, 'utf8') : undefined,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function recordIosDeviceTrace(params: {
  device: DeviceInfo;
  appBundleId: string;
  tracePath: string;
  template: 'Activity Monitor' | 'Animation Hitches';
  duration: string;
  targetPids?: number[];
  allProcesses?: boolean;
  validateTraceOutput?: boolean;
  failureMessage: string;
}): Promise<IosDeviceTraceRecord> {
  const { device, appBundleId, tracePath, template, duration } = params;
  const targetArgs = params.allProcesses
    ? ['--all-processes']
    : (params.targetPids ?? []).flatMap((pid) => ['--attach', String(pid)]);
  const recordArgs = [
    'xctrace',
    'record',
    '--template',
    template,
    '--device',
    device.id,
    ...targetArgs,
    '--time-limit',
    duration,
    '--output',
    tracePath,
    '--quiet',
    '--no-prompt',
  ];
  const record = await runIosDeviceTraceRecord(recordArgs, params.tracePath);
  if (record.result.exitCode === 0) {
    if (params.validateTraceOutput) {
      await assertUsableTraceOutput(params, record.result.stdout, record.result.stderr);
    }
    return {
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      capturedAtMs: record.capturedAtMs,
    };
  }
  throw new AppError(
    'COMMAND_FAILED',
    params.failureMessage,
    execFailureDetails(record.result, {
      cmd: 'xcrun',
      args: recordArgs,
      appBundleId,
      deviceId: device.id,
      hint: resolveIosDevicePerfHint(record.result.stdout, record.result.stderr),
    }),
  );
}

async function runIosDeviceTraceRecord(
  recordArgs: string[],
  tracePath: string,
): Promise<IosDeviceTraceRecordAttempt> {
  let lastAttempt: IosDeviceTraceRecordAttempt | undefined;
  for (let attempt = 1; attempt <= IOS_DEVICE_TRACE_RECORD_MAX_ATTEMPTS; attempt += 1) {
    await prepareAppleTraceRecordRetry(tracePath, attempt, IOS_DEVICE_TRACE_RECORD_RETRY_DELAY_MS);
    const startedAt = new Date().toISOString();
    const result = await runXcrun(recordArgs, {
      allowFailure: true,
      timeoutMs: IOS_DEVICE_PERF_RECORD_TIMEOUT_MS,
    });
    lastAttempt = {
      result,
      startedAt,
      endedAt: new Date().toISOString(),
      capturedAtMs: Date.now(),
    };
    if (result.exitCode === 0 || !isRetryableIosDeviceTraceRecordFailure(result)) {
      return lastAttempt;
    }
  }
  return lastAttempt as IosDeviceTraceRecordAttempt;
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

export async function prepareAppleTraceRecordRetry(
  tracePath: string,
  attempt: number,
  retryDelayMs: number,
): Promise<void> {
  if (attempt <= 1) return;
  await fs.rm(tracePath, { recursive: true, force: true }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
}

async function assertUsableTraceOutput(
  params: {
    device: DeviceInfo;
    appBundleId: string;
    tracePath: string;
    failureMessage: string;
  },
  stdout: string,
  stderr: string,
): Promise<void> {
  const stat = await fs.stat(params.tracePath).catch(() => null);
  const hasTrace =
    stat?.isDirectory() === true
      ? (await fs.readdir(params.tracePath).catch(() => [])).length > 0
      : (stat?.size ?? 0) > 0;
  if (hasTrace) return;
  throw new AppError('COMMAND_FAILED', `${params.failureMessage}: xctrace produced no trace data`, {
    tracePath: params.tracePath,
    appBundleId: params.appBundleId,
    deviceId: params.device.id,
    stdout,
    stderr,
    hint: 'Keep the iOS device unlocked and connected by cable, keep the app active, then retry perf.',
  });
}

async function exportIosDevicePerfTable(
  device: DeviceInfo,
  appBundleId: string,
  tracePath: string,
  schema: string,
  outputPath: string,
): Promise<void> {
  const exportArgs = [
    'xctrace',
    'export',
    '--input',
    tracePath,
    '--xpath',
    `/trace-toc/run/data/table[@schema="${schema}"]`,
    '--output',
    outputPath,
  ];
  requireExecSuccess(
    await runXcrun(exportArgs, {
      allowFailure: true,
      timeoutMs: IOS_DEVICE_PERF_EXPORT_TIMEOUT_MS,
    }),
    `Failed to export iOS device ${schema} data`,
    (exportResult) => ({
      cmd: 'xcrun',
      args: exportArgs,
      appBundleId,
      deviceId: device.id,
      hint: resolveIosDevicePerfHint(exportResult.stdout, exportResult.stderr),
    }),
  );
}

async function exportOptionalIosDevicePerfTable(
  device: DeviceInfo,
  appBundleId: string,
  tracePath: string,
  schema: string,
  outputPath: string,
): Promise<boolean> {
  try {
    await exportIosDevicePerfTable(device, appBundleId, tracePath, schema, outputPath);
    return true;
  } catch {
    return false;
  }
}

export function parseApplePsOutput(stdout: string): AppleProcessSample[] {
  const rows: AppleProcessSample[] = [];
  for (const line of splitNonEmptyTrimmedLines(stdout)) {
    const match = line.match(/^(\d+)\s+([0-9]+(?:\.[0-9]+)?)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [pidText, cpuText, rssText, commandText] = match.slice(1);
    if (
      pidText === undefined ||
      cpuText === undefined ||
      rssText === undefined ||
      commandText === undefined
    ) {
      continue;
    }
    const pid = Number(pidText);
    const cpuPercent = Number(cpuText);
    const rssKb = Number(rssText);
    const command = commandText.trim();
    if (!Number.isFinite(pid) || !Number.isFinite(cpuPercent) || !Number.isFinite(rssKb)) {
      continue;
    }
    rows.push({ pid, cpuPercent, rssKb, command });
  }
  return rows;
}

async function parseIosDevicePerfTable(xml: string): Promise<IosDevicePerfProcessSample[]> {
  const document = parseXmlDocumentSync(xml);
  const mnemonics = readSchemaColumns(document, 'activity-monitor-process-live');
  if (mnemonics.length === 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Failed to parse xctrace activity-monitor-process-live schema',
    );
  }
  const pidIndex = mnemonics.indexOf('pid');
  const processIndex = mnemonics.indexOf('process');
  const cpuTimeIndex = mnemonics.indexOf('cpu-total');
  const residentMemoryIndex = mnemonics.indexOf('memory-real');
  if (pidIndex < 0 || processIndex < 0 || cpuTimeIndex < 0 || residentMemoryIndex < 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'xctrace activity-monitor-process-live export is missing expected columns',
    );
  }

  const rows = findAllXmlNodes(document, (node) => node.name === 'row');
  const samples: IosDevicePerfProcessSample[] = [];
  const references = new Map<
    string,
    {
      numberValue?: number | null;
      processName?: string | null;
    }
  >();
  for (const row of rows) {
    const elements = row.children;
    if (elements.length === 0) continue;
    for (const element of elements) {
      const nestedPid = findFirstXmlNode(
        element.children,
        (child) => child.name === 'pid' && typeof child.attributes.id === 'string',
      );
      if (nestedPid?.attributes.id) {
        const pidValue = Number(nestedPid.text);
        references.set(nestedPid.attributes.id, {
          numberValue: Number.isFinite(pidValue) ? pidValue : null,
        });
      }
      if (!element.attributes.id) continue;
      references.set(element.attributes.id, {
        numberValue: parseDirectXmlNumber(element),
        processName: readDirectProcessNameFromXml(element),
      });
    }

    const pid = resolveXmlNumber(elements[pidIndex], references);
    const processName = resolveProcessName(elements[processIndex], references);
    if (pid === null || !Number.isFinite(pid) || !processName) continue;
    samples.push({
      pid,
      processName,
      cpuTimeNs: resolveXmlNumber(elements[cpuTimeIndex], references),
      residentMemoryBytes: resolveXmlNumber(elements[residentMemoryIndex], references),
    });
  }
  return samples;
}

export async function resolveAppleExecutable(
  device: DeviceInfo,
  appBundleId: string,
): Promise<{ executableName: string; executablePath?: string }> {
  const appPath = isMacOs(device)
    ? await resolveMacOsBundlePath(appBundleId)
    : await resolveIosSimulatorAppContainer(device, appBundleId);
  const infoPlistPath = isMacOs(device)
    ? path.join(appPath, 'Contents', 'Info.plist')
    : path.join(appPath, 'Info.plist');
  const executableName = await readInfoPlistString(infoPlistPath, 'CFBundleExecutable');
  if (!executableName) {
    throw new AppError('COMMAND_FAILED', `Failed to resolve executable for ${appBundleId}`, {
      appBundleId,
      appPath,
    });
  }

  return {
    executableName,
    executablePath: isMacOs(device)
      ? path.join(appPath, 'Contents', 'MacOS', executableName)
      : path.join(appPath, executableName),
  };
}

async function sampleIosDevicePerfMetrics(
  device: DeviceInfo,
  appBundleId: string,
): Promise<{ cpu: AppleCpuPerfSample; memory: AppleMemoryPerfSample }> {
  const processes = await resolveIosDevicePerfTarget(device, appBundleId);
  const firstCapture = await captureIosDevicePerfTable(device, appBundleId);
  const secondCapture = await captureIosDevicePerfTable(device, appBundleId);
  const firstSnapshot = summarizeIosDevicePerfSnapshot(
    await parseIosDevicePerfTable(firstCapture.xml),
    processes,
    appBundleId,
    device,
  );
  const secondSnapshot = summarizeIosDevicePerfSnapshot(
    await parseIosDevicePerfTable(secondCapture.xml),
    processes,
    appBundleId,
    device,
  );

  const elapsedMs = secondCapture.capturedAtMs - firstCapture.capturedAtMs;
  if (elapsedMs <= 0) {
    throw new AppError(
      'COMMAND_FAILED',
      `Invalid Activity Monitor sample window for ${appBundleId}`,
      {
        appBundleId,
        deviceId: device.id,
      },
    );
  }
  if (
    firstSnapshot.cpuTimeNs === null ||
    secondSnapshot.cpuTimeNs === null ||
    secondSnapshot.residentMemoryBytes === null
  ) {
    throw new AppError('COMMAND_FAILED', `Incomplete Activity Monitor sample for ${appBundleId}`, {
      appBundleId,
      deviceId: device.id,
      hint: 'Keep the app running in the foreground while perf samples the device, then retry.',
    });
  }

  const cpuDeltaNs = Math.max(0, secondSnapshot.cpuTimeNs - firstSnapshot.cpuTimeNs);
  const usagePercent = (cpuDeltaNs / (elapsedMs * 1_000_000)) * 100;

  return buildApplePerfSamples({
    usagePercent,
    residentMemoryKb: secondSnapshot.residentMemoryBytes / 1024,
    measuredAt: new Date(secondCapture.capturedAtMs).toISOString(),
    matchedProcesses: secondSnapshot.matchedProcesses,
    cpuMethod: IOS_DEVICE_CPU_SAMPLE_METHOD,
    memoryMethod: IOS_DEVICE_MEMORY_SAMPLE_METHOD,
  });
}

export async function resolveIosDevicePerfTarget(
  device: DeviceInfo,
  appBundleId: string,
): Promise<IosDeviceProcessInfo[]> {
  const apps = await listIosDeviceApps(device, 'all');
  const app = apps.find((candidate) => candidate.bundleId === appBundleId);
  if (!app) {
    throw new AppError('APP_NOT_INSTALLED', `No iOS device app found for ${appBundleId}`, {
      appBundleId,
      deviceId: device.id,
    });
  }
  if (!app.url) {
    throw new AppError('COMMAND_FAILED', `Missing app bundle URL for ${appBundleId}`, {
      appBundleId,
      deviceId: device.id,
    });
  }

  const appBundleUrl = app.url.replace(/\/$/, '');
  const appBundlePath = fileURLToPath(appBundleUrl);
  const processes = (await listIosDeviceProcesses(device)).filter((process) =>
    process.executable.startsWith(`${appBundleUrl}/`),
  );
  if (processes.length === 0) {
    throw new AppError('COMMAND_FAILED', `No running process found for ${appBundleId}`, {
      appBundleId,
      deviceId: device.id,
      appBundlePath,
      hint: 'Run open <app> for this session again to ensure the iOS app is active, then retry perf.',
    });
  }

  return processes;
}

async function captureIosDevicePerfTable(
  device: DeviceInfo,
  appBundleId: string,
): Promise<IosDevicePerfCapture> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-ios-perf-'));
  const tracePath = path.join(tempDir, 'sample.trace');
  const exportPath = path.join(tempDir, 'activity-monitor-process-live.xml');
  try {
    const record = await recordIosDeviceTrace({
      device,
      appBundleId,
      tracePath,
      template: 'Activity Monitor',
      duration: IOS_DEVICE_PERF_TRACE_DURATION,
      allProcesses: true,
      failureMessage: `Failed to record iOS device Activity Monitor sample for ${appBundleId}`,
    });
    await exportIosDevicePerfTable(
      device,
      appBundleId,
      tracePath,
      'activity-monitor-process-live',
      exportPath,
    );
    return {
      capturedAtMs: record.capturedAtMs,
      xml: await fs.readFile(exportPath, 'utf8'),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function summarizeIosDevicePerfSnapshot(
  samples: IosDevicePerfProcessSample[],
  processes: IosDeviceProcessInfo[],
  appBundleId: string,
  device: DeviceInfo,
): {
  cpuTimeNs: number | null;
  residentMemoryBytes: number | null;
  matchedProcesses: string[];
} {
  const processIds = new Set(processes.map((process) => process.pid));
  const processNames = new Set(
    processes.map((process) => path.basename(fileURLToPath(process.executable))),
  );
  const matchedSamples = samples.filter(
    (sample) => processIds.has(sample.pid) || processNames.has(sample.processName),
  );
  if (matchedSamples.length === 0) {
    throw new AppError('COMMAND_FAILED', `No Activity Monitor sample found for ${appBundleId}`, {
      appBundleId,
      deviceId: device.id,
      hint: 'Keep the app running in the foreground while perf samples the device, then retry.',
    });
  }

  const latestSamplesByPid = new Map<number, IosDevicePerfProcessSample>();
  for (const sample of matchedSamples) {
    const previous = latestSamplesByPid.get(sample.pid);
    if (!previous) {
      latestSamplesByPid.set(sample.pid, sample);
      continue;
    }
    latestSamplesByPid.set(sample.pid, {
      pid: sample.pid,
      processName: sample.processName || previous.processName,
      cpuTimeNs: maxNullableNumber(previous.cpuTimeNs, sample.cpuTimeNs),
      residentMemoryBytes: maxNullableNumber(
        previous.residentMemoryBytes,
        sample.residentMemoryBytes,
      ),
    });
  }

  const latestSamples = [...latestSamplesByPid.values()];
  const cpuTimeValues = latestSamples
    .map((sample) => sample.cpuTimeNs)
    .filter((value): value is number => value !== null);
  const residentMemoryValues = latestSamples
    .map((sample) => sample.residentMemoryBytes)
    .filter((value): value is number => value !== null);
  return {
    cpuTimeNs:
      cpuTimeValues.length > 0 ? cpuTimeValues.reduce((total, value) => total + value, 0) : null,
    residentMemoryBytes:
      residentMemoryValues.length > 0
        ? residentMemoryValues.reduce((total, value) => total + value, 0)
        : null,
    matchedProcesses: uniqueStrings(latestSamples.map((sample) => sample.processName)),
  };
}

async function resolveMacOsBundlePath(appBundleId: string): Promise<string> {
  const query = `kMDItemCFBundleIdentifier == "${appBundleId.replaceAll('"', '\\"')}"`;
  const result = requireExecSuccess(
    await runAppleToolCommand('mdfind', [query], {
      allowFailure: true,
      timeoutMs: APPLE_PERF_TIMEOUT_MS,
    }),
    `Failed to resolve macOS app bundle for ${appBundleId}`,
    { appBundleId },
  );

  const bundlePath = result.stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith('.app'));
  if (!bundlePath) {
    throw new AppError('APP_NOT_INSTALLED', `No macOS app found for ${appBundleId}`, {
      appBundleId,
    });
  }
  return bundlePath;
}

async function resolveIosSimulatorAppContainer(
  device: DeviceInfo,
  appBundleId: string,
): Promise<string> {
  const args = buildSimctlArgsForDevice(device, [
    'get_app_container',
    device.id,
    appBundleId,
    'app',
  ]);
  const result = requireExecSuccess(
    await runXcrun(args, {
      allowFailure: true,
      timeoutMs: APPLE_PERF_TIMEOUT_MS,
    }),
    `Failed to resolve iOS simulator app container for ${appBundleId}`,
    {
      appBundleId,
      hint: 'Ensure the iOS simulator app is installed and booted, then retry perf.',
    },
  );
  const appPath = result.stdout.trim();
  if (appPath.length === 0) {
    throw new AppError(
      'APP_NOT_INSTALLED',
      `No iOS simulator app container found for ${appBundleId}`,
      {
        appBundleId,
      },
    );
  }
  return appPath;
}

export async function readAppleProcessSamples(
  device: DeviceInfo,
  executable: { executableName: string; executablePath?: string },
): Promise<AppleProcessSample[]> {
  const args = isMacOs(device)
    ? ['-axo', 'pid=,%cpu=,rss=,command=']
    : buildSimctlArgsForDevice(device, [
        'spawn',
        device.id,
        'ps',
        '-axo',
        'pid=,%cpu=,rss=,command=',
      ]);
  const result = isMacOs(device)
    ? await runAppleToolCommand('ps', args, { timeoutMs: APPLE_PERF_TIMEOUT_MS })
    : await runAppleSimulatorProcessCommand(args);
  return parseApplePsOutput(result.stdout).filter((process) =>
    matchesAppleExecutableProcess(process.command, executable),
  );
}

async function resolveAppleMemorySnapshotProcess(
  device: DeviceInfo,
  appBundleId: string,
  executable: { executableName: string; executablePath?: string },
): Promise<AppleProcessSample> {
  const processes = await readAppleProcessSamples(device, executable);
  const process = processes.sort((left, right) => right.rssKb - left.rssKb)[0];
  if (process) return process;
  throw new AppError('COMMAND_FAILED', `No running process found for ${appBundleId}`, {
    kind: 'memgraph',
    appBundleId,
    hint: 'Run open <app> for this session again to ensure the Apple app is active, then retry perf memory snapshot.',
  });
}

async function resolveAppleMemorySnapshotTarget(
  device: DeviceInfo,
  appBundleId: string,
  support: ReturnType<typeof buildAppleMemorySnapshotSupport>,
): Promise<
  | { available: true; process: AppleProcessSample }
  | Extract<AppleMemorySnapshotResult, { available: false }>
> {
  try {
    const executable = await resolveAppleExecutable(device, appBundleId);
    return {
      available: true,
      process: await resolveAppleMemorySnapshotProcess(device, appBundleId, executable),
    };
  } catch (error) {
    if (isMissingIosSimulatorProcessToolError(device, error)) {
      return {
        available: false,
        kind: 'memgraph',
        reason:
          'iOS simulator memgraph capture needs process tools inside simctl spawn, but this simulator runtime did not provide ps.',
        hint: 'Use perf memory sample when available, or retry memgraph on a simulator runtime that includes process tools such as ps and leaks.',
        support: { ...support, memgraph: false },
      };
    }
    throw error;
  }
}

function isMissingIosSimulatorProcessToolError(device: DeviceInfo, error: unknown): boolean {
  if (!isIosFamily(device) || device.kind !== 'simulator') return false;
  if (!(error instanceof AppError)) return false;
  const details = error.details ?? {};
  const args = Array.isArray(details.args) ? details.args.join(' ') : '';
  const stderr = typeof details.stderr === 'string' ? details.stderr : '';
  const message = `${error.message}\n${stderr}`.toLowerCase();
  return args.includes('simctl spawn') && args.includes(' ps ') && message.includes('no such file');
}

function resolveAppleMemorySnapshotHint(
  device: DeviceInfo,
  stdout: string,
  stderr: string,
): string {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (text.includes('timed out') || text.includes('timeout')) {
    return 'Apple memgraph capture can take longer than metric sampling. Keep the app running and retry; if it times out again, collect a smaller reproduction before capturing leaks --outputGraph.';
  }
  if (text.includes('not found') || text.includes('no such file')) {
    return 'Install Xcode command line tools and ensure leaks is available, then retry.';
  }
  if (text.includes('permission') || text.includes('denied') || text.includes('not authorized')) {
    return isMacOs(device)
      ? 'Grant the agent terminal process permission to inspect this macOS app, then retry.'
      : 'Keep the simulator booted and app running; if inspection is denied, retry with a debug simulator build.';
  }
  return 'Keep the app process running and retry perf memory snapshot with --debug if the failure persists.';
}

async function runAppleSimulatorProcessCommand(args: string[]): Promise<ExecResult> {
  const result = await runXcrun(args, {
    allowFailure: true,
    timeoutMs: APPLE_PERF_TIMEOUT_MS,
  });
  if (result.exitCode === 0) return result;
  return await runAppleToolCommand('ps', ['-axo', 'pid=,%cpu=,rss=,command='], {
    timeoutMs: APPLE_PERF_TIMEOUT_MS,
  });
}

function matchesAppleExecutableProcess(
  command: string,
  executable: { executableName: string; executablePath?: string },
): boolean {
  const token = readProcessCommandToken(command);
  if (executable.executablePath) {
    for (const executablePath of buildAppleExecutablePathAliases(executable.executablePath)) {
      if (
        command === executablePath ||
        token === executablePath ||
        command.startsWith(`${executablePath} `)
      ) {
        return true;
      }
    }
  }
  return path.basename(token) === executable.executableName;
}

function buildAppleExecutablePathAliases(executablePath: string): string[] {
  const aliases = [executablePath];
  if (executablePath.startsWith('/private/var/')) {
    aliases.push(executablePath.replace('/private/var/', '/var/'));
  } else if (executablePath.startsWith('/var/')) {
    aliases.push(executablePath.replace('/var/', '/private/var/'));
  }
  return aliases;
}

function readProcessCommandToken(command: string): string {
  const [token = ''] = command.trim().split(/\s+/, 1);
  return token;
}

function buildApplePerfSamples(args: {
  usagePercent: number;
  residentMemoryKb: number;
  measuredAt: string;
  matchedProcesses: string[];
  cpuMethod: AppleCpuPerfSample['method'];
  memoryMethod: AppleMemoryPerfSample['method'];
}): { cpu: AppleCpuPerfSample; memory: AppleMemoryPerfSample } {
  return {
    cpu: {
      usagePercent: roundPercent(args.usagePercent),
      measuredAt: args.measuredAt,
      method: args.cpuMethod,
      matchedProcesses: args.matchedProcesses,
    },
    memory: {
      residentMemoryKb: Math.round(args.residentMemoryKb),
      measuredAt: args.measuredAt,
      method: args.memoryMethod,
      matchedProcesses: args.matchedProcesses,
    },
  };
}

function readDirectProcessNameFromXml(element: XmlNode | undefined): string | null {
  const fmt = element?.attributes.fmt?.trim() ?? '';
  if (!fmt) return null;
  return fmt.replace(/\s+\(\d+\)$/, '').trim();
}

function resolveProcessName(
  element: XmlNode | undefined,
  references: Map<string, { processName?: string | null }>,
): string | null {
  if (!element) return null;
  if (element.attributes.ref) {
    return references.get(element.attributes.ref)?.processName ?? null;
  }
  return readDirectProcessNameFromXml(element);
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

function maxNullableNumber(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}
