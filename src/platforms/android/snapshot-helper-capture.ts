import { AppError } from '../../utils/errors.ts';
import type { SnapshotOptions } from '../../utils/snapshot.ts';
import {
  parseInstrumentationRecords,
  readInstrumentationResultBoolean,
  readInstrumentationResultNumber,
} from './instrumentation-helper.ts';
import { parseUiHierarchy } from './ui-hierarchy.ts';
import {
  ANDROID_SNAPSHOT_HELPER_COMMAND_OVERHEAD_MS,
  ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
  ANDROID_SNAPSHOT_HELPER_PACKAGE,
  ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_QUIET_MS,
  ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_TIMEOUT_MS,
} from './snapshot-helper-types.ts';
import type {
  AndroidSnapshotHelperCaptureOptions,
  AndroidSnapshotHelperMetadata,
  AndroidSnapshotHelperOutput,
  AndroidSnapshotHelperParsedSnapshot,
} from './snapshot-helper-types.ts';

type AndroidSnapshotHelperChunk = {
  index: number | undefined;
  count: number | undefined;
  payloadBase64: string;
};

export type AndroidSnapshotHelperResolvedCaptureOptions = {
  waitForIdleTimeoutMs: number;
  waitForIdleQuietMs: number;
  timeoutMs: number;
  commandTimeoutMs: number;
  maxDepth: number;
  maxNodes: number;
  packageName: string;
  runner: string;
  outputPath?: string;
  emitChunks?: boolean;
};

type AndroidSnapshotHelperReadResult = {
  output: AndroidSnapshotHelperOutput;
  cleanupDone: boolean;
};

export async function captureAndroidSnapshotWithHelper(
  options: AndroidSnapshotHelperCaptureOptions,
): Promise<AndroidSnapshotHelperOutput> {
  const resolved = resolveAndroidSnapshotHelperCaptureOptions(options);
  const result = await options.adb(buildAndroidSnapshotHelperArgs(resolved), {
    allowFailure: true,
    timeoutMs: resolved.commandTimeoutMs,
  });
  const { output, cleanupDone } = await readAndroidSnapshotHelperOutput(options, resolved, result);
  if (resolved.outputPath && !cleanupDone) {
    await removeHelperOutputFile(options.adb, resolved.outputPath);
  }
  if (result.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper failed', {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      helper: output.metadata,
    });
  }
  return output;
}

export function resolveAndroidSnapshotHelperCaptureOptions(
  options: AndroidSnapshotHelperCaptureOptions,
): AndroidSnapshotHelperResolvedCaptureOptions {
  const timeoutMs = withDefault(options.timeoutMs, 8_000);
  const packageName = withDefault(options.packageName, ANDROID_SNAPSHOT_HELPER_PACKAGE);
  return {
    waitForIdleTimeoutMs: withDefault(
      options.waitForIdleTimeoutMs,
      ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_TIMEOUT_MS,
    ),
    waitForIdleQuietMs: withDefault(
      options.waitForIdleQuietMs,
      ANDROID_SNAPSHOT_HELPER_WAIT_FOR_IDLE_QUIET_MS,
    ),
    timeoutMs,
    commandTimeoutMs: withDefault(
      options.commandTimeoutMs,
      timeoutMs + ANDROID_SNAPSHOT_HELPER_COMMAND_OVERHEAD_MS,
    ),
    maxDepth: withDefault(options.maxDepth, 128),
    maxNodes: withDefault(options.maxNodes, 5_000),
    packageName,
    runner: withDefault(options.instrumentationRunner, `${packageName}/.SnapshotInstrumentation`),
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.emitChunks !== undefined ? { emitChunks: options.emitChunks } : {}),
  };
}

function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export function buildAndroidSnapshotHelperArgs(
  options: AndroidSnapshotHelperResolvedCaptureOptions,
): string[] {
  return [
    'shell',
    'am',
    'instrument',
    '-w',
    '-e',
    'waitForIdleTimeoutMs',
    String(options.waitForIdleTimeoutMs),
    '-e',
    'waitForIdleQuietMs',
    String(options.waitForIdleQuietMs),
    '-e',
    'timeoutMs',
    String(options.timeoutMs),
    '-e',
    'maxDepth',
    String(options.maxDepth),
    '-e',
    'maxNodes',
    String(options.maxNodes),
    // Default production snapshots use instrumentation status chunks. File output remains a
    // fallback/testing transport for devices where status output cannot carry the payload.
    ...(options.outputPath ? ['-e', 'outputPath', options.outputPath] : []),
    ...(options.emitChunks !== undefined ? ['-e', 'emitChunks', String(options.emitChunks)] : []),
    options.runner,
  ];
}

async function readAndroidSnapshotHelperOutput(
  options: AndroidSnapshotHelperCaptureOptions,
  resolved: AndroidSnapshotHelperResolvedCaptureOptions,
  result: Awaited<ReturnType<AndroidSnapshotHelperCaptureOptions['adb']>>,
): Promise<AndroidSnapshotHelperReadResult> {
  try {
    // The helper can report structured ok=false details even when am exits non-zero.
    return {
      output: parseAndroidSnapshotHelperOutput(`${result.stdout}\n${result.stderr}`),
      cleanupDone: false,
    };
  } catch (error) {
    return await readFallbackHelperOutputOrThrow(options, resolved, result, error);
  }
}

async function readFallbackHelperOutputOrThrow(
  options: AndroidSnapshotHelperCaptureOptions,
  resolved: AndroidSnapshotHelperResolvedCaptureOptions,
  result: Awaited<ReturnType<AndroidSnapshotHelperCaptureOptions['adb']>>,
  error: unknown,
): Promise<AndroidSnapshotHelperReadResult> {
  if (error instanceof AppError && result.exitCode !== 0 && error.details?.helper) throw error;
  const fileOutput = await readFallbackHelperOutputFile(options, resolved, result);
  if (fileOutput) return { output: fileOutput, cleanupDone: true };
  throw new AppError(
    'COMMAND_FAILED',
    result.exitCode === 0
      ? 'Android snapshot helper output could not be parsed'
      : 'Android snapshot helper failed before returning parseable output',
    {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    },
    error,
  );
}

async function readFallbackHelperOutputFile(
  options: AndroidSnapshotHelperCaptureOptions,
  resolved: AndroidSnapshotHelperResolvedCaptureOptions,
  result: Awaited<ReturnType<AndroidSnapshotHelperCaptureOptions['adb']>>,
): Promise<AndroidSnapshotHelperOutput | undefined> {
  if (result.exitCode !== 0 || !resolved.outputPath) return undefined;
  return await readHelperOutputFile(
    options.adb,
    resolved.outputPath,
    readHelperMetadataFromInstrumentationOutput(`${result.stdout}\n${result.stderr}`) ??
      fallbackAndroidSnapshotHelperMetadata(resolved),
  );
}

function fallbackAndroidSnapshotHelperMetadata(
  resolved: AndroidSnapshotHelperResolvedCaptureOptions,
): AndroidSnapshotHelperMetadata {
  return {
    outputFormat: ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
    waitForIdleTimeoutMs: resolved.waitForIdleTimeoutMs,
    waitForIdleQuietMs: resolved.waitForIdleQuietMs,
    timeoutMs: resolved.timeoutMs,
    maxDepth: resolved.maxDepth,
    maxNodes: resolved.maxNodes,
    transport: 'instrumentation',
  };
}

async function readHelperOutputFile(
  adb: AndroidSnapshotHelperCaptureOptions['adb'],
  outputPath: string,
  metadata: AndroidSnapshotHelperMetadata,
): Promise<AndroidSnapshotHelperOutput | undefined> {
  let result: Awaited<ReturnType<AndroidSnapshotHelperCaptureOptions['adb']>>;
  try {
    result = await adb(buildReadAndRemoveHelperOutputArgs(outputPath), {
      allowFailure: true,
      timeoutMs: 5_000,
    });
  } catch {
    return undefined;
  }
  if (result.exitCode !== 0) return undefined;
  const xml = result.stdout.trim();
  if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>')) return undefined;
  return {
    xml,
    metadata,
  };
}

function buildReadAndRemoveHelperOutputArgs(outputPath: string): string[] {
  return [
    'shell',
    'sh',
    '-c',
    'cat "$1"; status=$?; rm -f "$1"; exit "$status"',
    'agent-device-snapshot-helper-output',
    outputPath,
  ];
}

function readHelperMetadataFromInstrumentationOutput(
  output: string,
): AndroidSnapshotHelperMetadata | null {
  try {
    const records = parseInstrumentationRecords(output);
    return readHelperMetadata(readFinalHelperResult(records.results));
  } catch {
    return null;
  }
}

async function removeHelperOutputFile(
  adb: AndroidSnapshotHelperCaptureOptions['adb'],
  outputPath: string,
): Promise<void> {
  try {
    await adb(['shell', 'rm', '-f', outputPath], {
      allowFailure: true,
      timeoutMs: 5_000,
    });
  } catch {
    // Cleanup is best-effort; snapshot capture should not fail because a stale temp file survived.
  }
}

export function parseAndroidSnapshotHelperOutput(output: string): AndroidSnapshotHelperOutput {
  const records = parseInstrumentationRecords(output);
  const finalResult = readFinalHelperResult(records.results);
  const xml = decodeHelperXml(collectHelperChunks(records.status), finalResult);

  return {
    xml,
    metadata: { ...readHelperMetadata(finalResult), transport: 'instrumentation' },
  };
}

export function parseAndroidSnapshotHelperXml(
  xml: string,
  metadata: AndroidSnapshotHelperMetadata = {
    outputFormat: ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
  },
  options: SnapshotOptions = {},
  maxNodes?: number,
): AndroidSnapshotHelperParsedSnapshot {
  return {
    ...parseUiHierarchy(xml, maxNodes, options),
    metadata,
  };
}

function collectHelperChunks(records: Array<Record<string, string>>): AndroidSnapshotHelperChunk[] {
  const chunks: AndroidSnapshotHelperChunk[] = [];
  for (const record of records) {
    if (
      record.agentDeviceProtocol !== ANDROID_SNAPSHOT_HELPER_PROTOCOL ||
      record.outputFormat !== ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT
    ) {
      continue;
    }
    const { payloadBase64 } = record;
    if (payloadBase64 === undefined) continue;
    chunks.push({
      index: readOptionalNumber(record.chunkIndex),
      count: readOptionalNumber(record.chunkCount),
      payloadBase64,
    });
  }
  return chunks;
}

function readFinalHelperResult(records: Array<Record<string, string>>): Record<string, string> {
  const finalResult = records.find(
    (record) => record.agentDeviceProtocol === ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  );
  if (!finalResult) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper did not return a final result');
  }
  if (finalResult.ok !== 'true') {
    throw new AppError('COMMAND_FAILED', readHelperErrorMessage(finalResult), {
      errorType: finalResult.errorType,
      helper: finalResult,
    });
  }
  return finalResult;
}

function readHelperErrorMessage(finalResult: Record<string, string>): string {
  return finalResult.message && finalResult.message !== 'null'
    ? finalResult.message
    : finalResult.errorType || 'Android snapshot helper returned an error';
}

function decodeHelperXml(
  chunks: AndroidSnapshotHelperChunk[],
  finalResult: Record<string, string>,
): string {
  if (chunks.length === 0) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper did not return XML chunks', {
      helper: finalResult,
    });
  }
  const chunkCount = validateChunkCount(chunks);
  const xml = Buffer.concat(
    readChunkPayloads(indexChunks(chunks, chunkCount), chunkCount),
  ).toString('utf8');
  if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>')) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper output did not contain XML', {
      xml,
    });
  }
  return xml;
}

function validateChunkCount(chunks: AndroidSnapshotHelperChunk[]): number {
  const chunkCount = chunks[0]?.count ?? chunks.length;
  if (
    chunkCount < 1 ||
    chunks.length !== chunkCount ||
    chunks.some((chunk) => chunk.count !== chunkCount)
  ) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper returned incomplete XML chunks', {
      expectedChunks: chunkCount,
      actualChunks: chunks.length,
    });
  }
  return chunkCount;
}

function indexChunks(
  chunks: AndroidSnapshotHelperChunk[],
  chunkCount: number,
): Map<number, string> {
  const chunksByIndex = new Map<number, string>();
  for (const chunk of chunks) {
    if (chunk.index === undefined || chunk.index < 0 || chunk.index >= chunkCount) {
      throw new AppError('COMMAND_FAILED', 'Android snapshot helper returned invalid chunk index', {
        chunkIndex: chunk.index,
        expectedChunks: chunkCount,
      });
    }
    if (chunksByIndex.has(chunk.index)) {
      throw new AppError(
        'COMMAND_FAILED',
        'Android snapshot helper returned duplicate XML chunks',
        { chunkIndex: chunk.index },
      );
    }
    chunksByIndex.set(chunk.index, chunk.payloadBase64);
  }
  return chunksByIndex;
}

function readChunkPayloads(chunksByIndex: Map<number, string>, chunkCount: number): Buffer[] {
  const payloads: Buffer[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const payloadBase64 = chunksByIndex.get(index);
    if (payloadBase64 === undefined) {
      throw new AppError(
        'COMMAND_FAILED',
        'Android snapshot helper returned incomplete XML chunks',
        {
          missingChunkIndex: index,
          expectedChunks: chunkCount,
        },
      );
    }
    payloads.push(Buffer.from(payloadBase64, 'base64'));
  }
  return payloads;
}

function readHelperMetadata(finalResult: Record<string, string>): AndroidSnapshotHelperMetadata {
  return {
    helperApiVersion: finalResult.helperApiVersion,
    outputFormat: ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
    waitForIdleTimeoutMs: readOptionalNumber(finalResult.waitForIdleTimeoutMs),
    waitForIdleQuietMs: readOptionalNumber(finalResult.waitForIdleQuietMs),
    timeoutMs: readOptionalNumber(finalResult.timeoutMs),
    maxDepth: readOptionalNumber(finalResult.maxDepth),
    maxNodes: readOptionalNumber(finalResult.maxNodes),
    rootPresent: readOptionalBoolean(finalResult.rootPresent),
    captureMode: readOptionalCaptureMode(finalResult.captureMode),
    windowCount: readOptionalNumber(finalResult.windowCount),
    nodeCount: readOptionalNumber(finalResult.nodeCount),
    truncated: readOptionalBoolean(finalResult.truncated),
    elapsedMs: readOptionalNumber(finalResult.elapsedMs),
  };
}

function readOptionalCaptureMode(
  value: string | undefined,
): AndroidSnapshotHelperMetadata['captureMode'] {
  return value === 'interactive-windows' || value === 'active-window' ? value : undefined;
}

export {
  readInstrumentationResultNumber as readAndroidSnapshotHelperMetadataNumber,
  readInstrumentationResultBoolean as readAndroidSnapshotHelperMetadataBoolean,
};

const readOptionalNumber = readInstrumentationResultNumber;
const readOptionalBoolean = readInstrumentationResultBoolean;
