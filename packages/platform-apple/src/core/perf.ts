import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isIosFamily,
  isMacOs,
  publicPlatformString,
  type DeviceInfo,
  type PublicPlatform,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { parseXmlDocumentSync } from '@agent-device/xml';
import { execFailureDetails, type ExecResult } from '@agent-device/host-kit/command';
import { uniqueStrings } from '@agent-device/kernel/collections';
import {
  ensureHostDirectory,
  hostFileStat,
  makeHostTemporaryDirectory,
  removeHostPath,
} from '@agent-device/host-kit/host-file';
import type { IosDeviceProcessInfo } from './app-info.ts';
import { buildSimctlArgsForDevice } from './simctl.ts';
import { runAppleToolCommand, runXcrun } from './tool-provider.ts';
import {
  findAllXmlNodes,
  readSchemaColumns,
  rememberXmlReferences,
  resolveXmlNumber,
  resolveXmlProcess,
  type XmlReference,
} from './perf-xml.ts';
import {
  readAppleProcessSamples,
  resolveAppleExecutable,
  resolveIosDevicePerfTarget,
  type AppleProcessSample,
} from './perf-target.ts';
import { exportAppleXctraceData, recordAppleXctraceTimedTrace } from './perf-xctrace.ts';
import {
  APPLE_FRAME_SAMPLE_DESCRIPTION,
  APPLE_FRAME_SAMPLE_METHOD,
  parseAppleFramePerfSample,
  type AppleFramePerfSample,
} from './perf-frame.ts';

const APPLE_MEMORY_SAMPLE_METHOD = 'ps-process-snapshot';
const IOS_DEVICE_MEMORY_SAMPLE_METHOD = 'xctrace-activity-monitor';
const APPLE_MEMGRAPH_SNAPSHOT_METHOD = 'leaks-output-graph';

const APPLE_MEMORY_SNAPSHOT_TIMEOUT_MS = 120_000;
const IOS_DEVICE_PERF_TRACE_DURATION = '1s';
const IOS_DEVICE_FRAME_TRACE_DURATION = '2s';

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

type IosDevicePerfProcessSample = {
  pid: number;
  processName: string;
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

export async function sampleAppleMemoryPerf(
  device: DeviceInfo,
  appBundleId: string,
): Promise<AppleMemoryPerfSample> {
  if (isIosFamily(device) && device.kind === 'device') {
    return await sampleIosDeviceMemoryPerf(device, appBundleId);
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
  return buildAppleMemoryPerfSample({
    residentMemoryKb: processes.reduce((total, processInfo) => total + processInfo.rssKb, 0),
    measuredAt,
    matchedProcesses: [executable.executableName],
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
  const { process: processInfo } = target;
  await ensureHostDirectory(path.dirname(outPath));
  const hadLocalArtifact = await fileExists(outPath);
  let result: ExecResult;
  try {
    result = await runAppleMemorySnapshotTool(device, outPath, processInfo.pid);
  } catch (error) {
    await cleanupLocalArtifact(outPath, hadLocalArtifact);
    throw annotateAppleMemorySnapshotToolError(device, appBundleId, processInfo, outPath, error);
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
        pid: processInfo.pid,
        processName: path.basename(readProcessCommandToken(processInfo.command)),
        path: outPath,
        hint: resolveAppleMemorySnapshotHint(device, result.stdout, result.stderr),
      }),
    );
  }

  const stat = await hostFileStat(outPath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0) {
    await cleanupLocalArtifact(outPath, hadLocalArtifact);
    throw new AppError('COMMAND_FAILED', 'Apple memgraph artifact is missing or empty', {
      kind: 'memgraph',
      appBundleId,
      pid: processInfo.pid,
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
    pid: processInfo.pid,
    processName: path.basename(readProcessCommandToken(processInfo.command)),
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
  processInfo: AppleProcessSample,
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
        pid: processInfo.pid,
        processName: path.basename(readProcessCommandToken(processInfo.command)),
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
      pid: processInfo.pid,
      processName: path.basename(readProcessCommandToken(processInfo.command)),
      path: outPath,
      hint: 'Retry perf memory snapshot. If it still fails, run with --debug and inspect leaks output.',
    },
    error,
  );
}

// fallow-ignore-next-line code-duplication
async function fileExists(filePath: string): Promise<boolean> {
  return await hostFileStat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false);
}

async function cleanupLocalArtifact(filePath: string, existedBefore: boolean): Promise<void> {
  if (existedBefore) return;
  await removeHostPath(filePath).catch(() => {});
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
    processIds: processes.map((processInfo) => processInfo.pid),
    processNames: uniqueStrings(
      processes.map((processInfo) => path.basename(fileURLToPath(processInfo.executable))),
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

export function buildAppleMemorySamplingMetadata(device: DeviceInfo): Record<string, unknown> {
  if (isIosFamily(device) && device.kind === 'device') {
    return {
      method: IOS_DEVICE_MEMORY_SAMPLE_METHOD,
      description:
        'Resident memory snapshot from a short xctrace Activity Monitor sample on the connected iOS device.',
      unit: 'kB',
    };
  }

  const source = isMacOs(device)
    ? 'host ps for the running macOS app executable resolved from the bundle ID.'
    : 'xcrun simctl spawn ps, with host ps fallback, for the running iOS simulator app executable resolved from the bundle ID.';
  return {
    method: APPLE_MEMORY_SAMPLE_METHOD,
    description: `Resident memory snapshot from ${source}`,
    unit: 'kB',
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
  const tempDir = await makeHostTemporaryDirectory('agent-device-ios-frame-perf-');
  const tracePath = path.join(tempDir, 'animation-hitches.trace');
  try {
    const record = await recordAppleXctraceTimedTrace({
      device,
      appBundleId,
      tracePath,
      template: 'Animation Hitches',
      timeLimit: IOS_DEVICE_FRAME_TRACE_DURATION,
      target: processes.map((processInfo) => processInfo.pid),
      requireTraceData: true,
      failureMessage: `Failed to record iOS frame-health sample for ${appBundleId}`,
    });
    const context = { device, appBundleId, tracePath, tempDir };
    return {
      windowStartedAt: record.startedAt,
      windowEndedAt: record.endedAt,
      hitchesXml: await exportIosDevicePerfTable(context, 'hitches'),
      frameLifetimesXml: await exportIosDevicePerfTable(context, 'hitches-frame-lifetimes'),
      displayInfoXml: await exportIosDevicePerfTable(context, 'device-display-info').catch(
        () => undefined,
      ),
    };
  } finally {
    await removeHostPath(tempDir).catch(() => {});
  }
}

async function exportIosDevicePerfTable(
  context: { device: DeviceInfo; appBundleId: string; tracePath: string; tempDir: string },
  schema: string,
): Promise<string> {
  return await exportAppleXctraceData({
    tracePath: context.tracePath,
    outPath: path.join(context.tempDir, `${schema}.xml`),
    query: { schema },
    failureMessage: `Failed to export iOS device ${schema} data`,
    failureDetails: { appBundleId: context.appBundleId, deviceId: context.device.id },
  });
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
  const residentMemoryIndex = mnemonics.indexOf('memory-real');
  if (pidIndex < 0 || processIndex < 0 || residentMemoryIndex < 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'xctrace activity-monitor-process-live export is missing expected columns',
    );
  }

  const rows = findAllXmlNodes(document, (node) => node.name === 'row');
  const samples: IosDevicePerfProcessSample[] = [];
  const references = new Map<string, XmlReference>();
  for (const row of rows) {
    const elements = row.children;
    if (elements.length === 0) continue;
    rememberXmlReferences(elements, references);

    const pid = resolveXmlNumber(elements[pidIndex], references);
    const processName = resolveXmlProcess(elements[processIndex], references)?.name;
    if (pid === null || !Number.isFinite(pid) || !processName) continue;
    samples.push({
      pid,
      processName,
      residentMemoryBytes: resolveXmlNumber(elements[residentMemoryIndex], references),
    });
  }
  return samples;
}

async function sampleIosDeviceMemoryPerf(
  device: DeviceInfo,
  appBundleId: string,
): Promise<AppleMemoryPerfSample> {
  const processes = await resolveIosDevicePerfTarget(device, appBundleId);
  const capture = await captureIosDevicePerfTable(device, appBundleId);
  const snapshot = summarizeIosDeviceMemorySnapshot(
    await parseIosDevicePerfTable(capture.xml),
    processes,
    appBundleId,
    device,
  );
  if (snapshot.residentMemoryBytes === null) {
    throw new AppError('COMMAND_FAILED', `Incomplete Activity Monitor sample for ${appBundleId}`, {
      appBundleId,
      deviceId: device.id,
      hint: 'Keep the app running in the foreground while perf samples the device, then retry.',
    });
  }

  return buildAppleMemoryPerfSample({
    residentMemoryKb: snapshot.residentMemoryBytes / 1024,
    measuredAt: new Date(capture.capturedAtMs).toISOString(),
    matchedProcesses: snapshot.matchedProcesses,
    memoryMethod: IOS_DEVICE_MEMORY_SAMPLE_METHOD,
  });
}

async function captureIosDevicePerfTable(
  device: DeviceInfo,
  appBundleId: string,
): Promise<IosDevicePerfCapture> {
  const tempDir = await makeHostTemporaryDirectory('agent-device-ios-perf-');
  const tracePath = path.join(tempDir, 'sample.trace');
  try {
    const record = await recordAppleXctraceTimedTrace({
      device,
      appBundleId,
      tracePath,
      template: 'Activity Monitor',
      timeLimit: IOS_DEVICE_PERF_TRACE_DURATION,
      target: 'all-processes',
      failureMessage: `Failed to record iOS device Activity Monitor sample for ${appBundleId}`,
    });
    return {
      capturedAtMs: record.capturedAtMs,
      xml: await exportIosDevicePerfTable(
        { device, appBundleId, tracePath, tempDir },
        'activity-monitor-process-live',
      ),
    };
  } finally {
    await removeHostPath(tempDir).catch(() => {});
  }
}

function summarizeIosDeviceMemorySnapshot(
  samples: IosDevicePerfProcessSample[],
  processes: IosDeviceProcessInfo[],
  appBundleId: string,
  device: DeviceInfo,
): {
  residentMemoryBytes: number | null;
  matchedProcesses: string[];
} {
  const processIds = new Set(processes.map((processInfo) => processInfo.pid));
  const processNames = new Set(
    processes.map((processInfo) => path.basename(fileURLToPath(processInfo.executable))),
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
      residentMemoryBytes: maxNullableNumber(
        previous.residentMemoryBytes,
        sample.residentMemoryBytes,
      ),
    });
  }

  const latestSamples = [...latestSamplesByPid.values()];
  const residentMemoryValues = latestSamples
    .map((sample) => sample.residentMemoryBytes)
    .filter((value): value is number => value !== null);
  return {
    residentMemoryBytes:
      residentMemoryValues.length > 0
        ? residentMemoryValues.reduce((total, value) => total + value, 0)
        : null,
    matchedProcesses: uniqueStrings(latestSamples.map((sample) => sample.processName)),
  };
}

function readProcessCommandToken(command: string): string {
  const [token = ''] = command.trim().split(/\s+/, 1);
  return token;
}

async function resolveAppleMemorySnapshotProcess(
  device: DeviceInfo,
  appBundleId: string,
  executable: { executableName: string; executablePath?: string },
): Promise<AppleProcessSample> {
  const processes = await readAppleProcessSamples(device, executable);
  const processInfo = processes.sort((left, right) => right.rssKb - left.rssKb)[0];
  if (processInfo) return processInfo;
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

function buildAppleMemoryPerfSample(args: {
  residentMemoryKb: number;
  measuredAt: string;
  matchedProcesses: string[];
  memoryMethod: AppleMemoryPerfSample['method'];
}): AppleMemoryPerfSample {
  return {
    residentMemoryKb: Math.round(args.residentMemoryKb),
    measuredAt: args.measuredAt,
    method: args.memoryMethod,
    matchedProcesses: args.matchedProcesses,
  };
}

function maxNullableNumber(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}
