import net from 'node:net';
import { AppError } from '@agent-device/kernel/errors';
import {
  androidCaptureFailureReasonDetail,
  androidCaptureFailureReasonFromHelperResult,
} from './snapshot-capture-failure-reason.ts';
import {
  readInstrumentationResultBoolean,
  readInstrumentationResultNumber,
} from './instrumentation-helper.ts';
import {
  ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
  ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  type AndroidSnapshotHelperMetadata,
  type AndroidSnapshotHelperOutput,
} from './snapshot-helper-types.ts';
import type { AndroidAdbProcess } from './adb-executor.ts';

const SESSION_REQUEST_OVERHEAD_MS = 3_000;

export function allocateAndroidSnapshotHelperSessionPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local TCP port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export function sendAndroidSnapshotHelperSessionCommand(
  port: number,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session request timed out', {
          command,
          timeoutMs,
          port,
        }),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    socket.on('connect', () => socket.write(`${command}\n`));
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('error', (error) => {
      cleanup();
      reject(error);
    });
    socket.on('close', () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export async function requestAndroidSnapshotHelperSessionSnapshot(params: {
  port: number;
  timeoutMs: number;
  commandTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<AndroidSnapshotHelperOutput> {
  const requestId = `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await sendAndroidSnapshotHelperSessionCommand(
    params.port,
    `snapshot ${requestId}`,
    resolveAndroidSnapshotHelperSessionRequestTimeoutMs(params),
    params.signal,
  );
  return parseAndroidSnapshotHelperSessionSnapshotResponse(response, requestId);
}

export function resolveAndroidSnapshotHelperSessionRequestTimeoutMs(params: {
  timeoutMs: number;
  commandTimeoutMs: number;
}): number {
  return Math.min(
    params.commandTimeoutMs,
    Math.max(params.timeoutMs + SESSION_REQUEST_OVERHEAD_MS, 3_000),
  );
}

export function waitForAndroidSnapshotHelperSessionReady(
  childProcess: AndroidAdbProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session did not become ready', {
          output,
          timeoutMs,
        }),
      );
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (
        output.includes(`agentDeviceProtocol=${ANDROID_SNAPSHOT_HELPER_PROTOCOL}`) &&
        output.includes('sessionReady=true')
      ) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
    };
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    childProcess.stdout?.on('data', onData);
    childProcess.stderr?.on('data', onData);
    childProcess.once('exit', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session exited before ready', {
          output,
          exitCode: code,
          signal: exitSignal,
        }),
      );
    });
    childProcess.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

export function parseAndroidSnapshotHelperSessionHeaders(response: string): Record<string, string> {
  const separator = response.indexOf('\n\n');
  return parseHeaders(response.slice(0, separator < 0 ? response.length : separator));
}

export function assertAndroidSnapshotHelperTouchSessionHeaders(
  headers: Record<string, string>,
  requestId: string,
): void {
  if (headers.agentDeviceProtocol !== ANDROID_SNAPSHOT_HELPER_PROTOCOL) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android automation helper session returned wrong protocol',
      { headers },
    );
  }
  if (headers.requestId !== requestId) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android automation helper session returned stale output',
      { headers, requestId },
    );
  }
}

export function isAndroidSnapshotHelperSessionCommandAcknowledged(
  response: string,
  requestId: string,
): boolean {
  const headers = parseAndroidSnapshotHelperSessionHeaders(response);
  return (
    headers.agentDeviceProtocol === ANDROID_SNAPSHOT_HELPER_PROTOCOL &&
    headers.requestId === requestId &&
    headers.ok === 'true'
  );
}

export function parseAndroidSnapshotHelperSessionSnapshotResponse(
  response: string,
  requestId: string,
): AndroidSnapshotHelperOutput {
  const separator = response.indexOf('\n\n');
  if (separator < 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android snapshot helper session returned malformed output',
      { response },
    );
  }
  const headers = parseHeaders(response.slice(0, separator));
  const xml = response.slice(separator + 2);
  validateSnapshotHeaders(headers, requestId);
  validateSnapshotXml(headers, xml);
  return { xml, metadata: readSessionMetadata(headers) };
}

function validateSnapshotHeaders(headers: Record<string, string>, requestId: string): void {
  if (headers.agentDeviceProtocol !== ANDROID_SNAPSHOT_HELPER_PROTOCOL) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android snapshot helper session returned wrong protocol',
      { headers },
    );
  }
  if (headers.outputFormat !== ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android snapshot helper session returned wrong output format',
      { headers },
    );
  }
  if (headers.requestId !== requestId) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper session returned stale output', {
      headers,
      requestId,
    });
  }
  if (headers.ok !== 'true') {
    throw new AppError(
      'COMMAND_FAILED',
      headers.message || headers.errorType || 'Android snapshot helper session returned an error',
      {
        helper: headers,
        ...androidCaptureFailureReasonDetail(androidCaptureFailureReasonFromHelperResult(headers)),
      },
    );
  }
}

function validateSnapshotXml(headers: Record<string, string>, xml: string): void {
  const byteLength = readInstrumentationResultNumber(headers.byteLength);
  if (byteLength !== undefined && Buffer.byteLength(xml, 'utf8') !== byteLength) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper session returned truncated XML', {
      headers,
      actualByteLength: Buffer.byteLength(xml, 'utf8'),
    });
  }
  if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>')) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper session did not return XML', {
      headers,
      xml,
    });
  }
}

function parseHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    headers[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return headers;
}

function readSessionMetadata(headers: Record<string, string>): AndroidSnapshotHelperMetadata {
  return {
    helperApiVersion: headers.helperApiVersion,
    outputFormat: ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
    waitForIdleTimeoutMs: readInstrumentationResultNumber(headers.waitForIdleTimeoutMs),
    waitForIdleQuietMs: readInstrumentationResultNumber(headers.waitForIdleQuietMs),
    timeoutMs: readInstrumentationResultNumber(headers.timeoutMs),
    maxDepth: readInstrumentationResultNumber(headers.maxDepth),
    maxNodes: readInstrumentationResultNumber(headers.maxNodes),
    rootPresent: readInstrumentationResultBoolean(headers.rootPresent),
    captureMode:
      headers.captureMode === 'interactive-windows' || headers.captureMode === 'active-window'
        ? headers.captureMode
        : undefined,
    windowCount: readInstrumentationResultNumber(headers.windowCount),
    nodeCount: readInstrumentationResultNumber(headers.nodeCount),
    truncated: readInstrumentationResultBoolean(headers.truncated),
    elapsedMs: readInstrumentationResultNumber(headers.elapsedMs),
  };
}
