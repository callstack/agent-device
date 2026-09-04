import { Buffer } from 'node:buffer';
import { snapshotSourceError } from './errors.ts';
import type { SnapshotSourceLimits } from './types.ts';

export const SNAPSHOT_SOURCE_PROTOCOL_VERSION = 1;
export const SNAPSHOT_SOURCE_VERSION = 'agent-device-simulator-ax-v1.5.3';
const FRAME_HEADER_BYTES = 4;

export const SNAPSHOT_SOURCE_WIRE_KEYS = Object.freeze([
  'verb',
  'requestId',
  'pid',
  'generation',
  'snapshotTree',
  'automationMode',
  'maxDepth',
  'maxNodes',
  'maxDurationMs',
  'maxResponseBytes',
] as const);

export const SNAPSHOT_SOURCE_RESPONSE_KEYS = Object.freeze([
  'protocolVersion',
  'sourceVersion',
  'requestId',
  'generation',
  'ok',
  'pid',
  'tree',
  'truncated',
  'automationEnabled',
  'error_kind',
  'error_code',
  'error',
] as const);

export const SNAPSHOT_SOURCE_ATTRIBUTE_KEYS = Object.freeze([
  'XC_kAXXCAttributeElementType',
  'XC_kAXXCAttributeElementBaseType',
  'XC_kAXXCAttributeLabel',
  'XC_kAXXCAttributeValue',
  'XC_kAXXCAttributeIdentifier',
  'XC_kAXXCAttributeFrame',
  'XC_kAXXCAttributeAutomationType',
  'XC_kAXXCAttributeChildren',
] as const);

export type SnapshotBridgeEnvelope = Readonly<Record<string, unknown>>;

export function encodeSnapshotBridgeFrame(
  value: unknown,
  limits: Pick<SnapshotSourceLimits, 'maxRequestBytes'>,
): Buffer {
  let body: Buffer;
  try {
    body = Buffer.from(JSON.stringify(value), 'utf8');
  } catch (error) {
    throw snapshotSourceError('malformed-tree', 'request-not-json', {}, error);
  }
  const frameBytes = body.length + FRAME_HEADER_BYTES;
  if (frameBytes > limits.maxRequestBytes) {
    throw snapshotSourceError('transport-failure', 'request-limit-exceeded', {
      frameBytes,
      maxRequestBytes: limits.maxRequestBytes,
    });
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class SnapshotBridgeFrameDecoder {
  private readonly header = Buffer.alloc(FRAME_HEADER_BYTES);
  private headerBytes = 0;
  private readonly chunks: Buffer[] = [];
  private payloadBytes = 0;
  private expectedBodyBytes: number | undefined;
  private frame: Buffer | undefined;
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw snapshotSourceError('malformed-tree', 'frame-limit-invalid', { maxFrameBytes });
    }
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer): Buffer | undefined {
    if (this.frame) return this.acceptTrailingChunk(chunk);
    const header = this.readHeader(chunk);
    if (!header) return undefined;
    this.appendPayload(chunk, header.offset, header.bodyBytes);
    if (this.payloadBytes !== header.bodyBytes) return undefined;
    this.frame = Buffer.concat(this.chunks, header.bodyBytes);
    return this.frame;
  }

  private acceptTrailingChunk(chunk: Buffer): Buffer {
    if (chunk.length > 0) {
      throw snapshotSourceError('malformed-tree', 'multiple-frames', {
        trailingBytes: chunk.length,
      });
    }
    return this.frame!;
  }

  private readHeader(chunk: Buffer): { offset: number; bodyBytes: number } | undefined {
    if (this.headerBytes === FRAME_HEADER_BYTES) {
      return { offset: 0, bodyBytes: this.expectedBodyBytes! };
    }
    const headerBytes = Math.min(FRAME_HEADER_BYTES - this.headerBytes, chunk.length);
    chunk.copy(this.header, this.headerBytes, 0, headerBytes);
    this.headerBytes += headerBytes;
    if (this.headerBytes < FRAME_HEADER_BYTES) return undefined;
    const bodyBytes = this.header.readUInt32BE(0);
    if (bodyBytes === 0 || bodyBytes > this.maxFrameBytes) {
      throw snapshotSourceError('malformed-tree', 'frame-limit-exceeded', {
        bodyBytes,
        maxFrameBytes: this.maxFrameBytes,
      });
    }
    this.expectedBodyBytes = bodyBytes;
    return { offset: headerBytes, bodyBytes };
  }

  private appendPayload(chunk: Buffer, offset: number, bodyBytes: number): void {
    const remainingBytes = bodyBytes - this.payloadBytes;
    const chunkBytes = chunk.length - offset;
    if (chunkBytes > remainingBytes) {
      throw snapshotSourceError('malformed-tree', 'multiple-frames', {
        trailingBytes: chunkBytes - remainingBytes,
      });
    }
    if (chunkBytes === 0) return;
    this.chunks.push(chunk.subarray(offset));
    this.payloadBytes += chunkBytes;
  }

  finish(): Buffer {
    if (this.frame) return this.frame;
    throw snapshotSourceError('transport-failure', 'bridge-frame-incomplete', {
      headerBytes: this.headerBytes,
      payloadBytes: this.payloadBytes,
      expectedBodyBytes: this.expectedBodyBytes,
    });
  }
}

export function parseSnapshotBridgeEnvelope(body: Buffer): SnapshotBridgeEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch (error) {
    throw snapshotSourceError('malformed-tree', 'response-not-json', {}, error);
  }
  if (!isRecord(parsed)) {
    throw snapshotSourceError('malformed-tree', 'response-not-object');
  }
  return parsed;
}

export function createSnapshotBridgeDescribeRequest(
  input: Readonly<{
    requestId: string;
    pid: number;
    generation: string;
    maxDepth: number;
    maxNodes: number;
    maxDurationMs: number;
    maxResponseBytes: number;
  }>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    verb: 'describe',
    requestId: input.requestId,
    pid: input.pid,
    generation: input.generation,
    snapshotTree: true,
    automationMode: true,
    maxDepth: input.maxDepth,
    maxNodes: input.maxNodes,
    maxDurationMs: input.maxDurationMs,
    maxResponseBytes: input.maxResponseBytes,
  });
}

export function assertSnapshotBridgeEnvelope(
  envelope: SnapshotBridgeEnvelope,
  requestId: string,
): void {
  if (envelope.protocolVersion !== SNAPSHOT_SOURCE_PROTOCOL_VERSION) {
    throw snapshotSourceError('transport-failure', 'protocol-version-mismatch', {
      expected: SNAPSHOT_SOURCE_PROTOCOL_VERSION,
      observed: envelope.protocolVersion,
    });
  }
  if (envelope.sourceVersion !== SNAPSHOT_SOURCE_VERSION) {
    throw snapshotSourceError('transport-failure', 'source-version-mismatch', {
      expected: SNAPSHOT_SOURCE_VERSION,
      observed: envelope.sourceVersion,
    });
  }
  if (envelope.requestId !== requestId) {
    throw snapshotSourceError('transport-failure', 'request-id-mismatch', {
      expected: requestId,
      observed: envelope.requestId,
    });
  }
}

export function assertSnapshotBridgeTargetIdentity(
  envelope: SnapshotBridgeEnvelope,
  expected: Readonly<{ pid: number; generation: string }>,
): void {
  if (typeof envelope.pid !== 'number' || envelope.pid !== expected.pid) {
    throw snapshotSourceError('stale-target', 'bridge-pid-mismatch', {
      expectedPid: expected.pid,
      observedPid: envelope.pid,
    });
  }
  if (envelope.generation !== expected.generation) {
    throw snapshotSourceError('stale-target', 'bridge-generation-mismatch', {
      expectedGeneration: expected.generation,
      observedGeneration: envelope.generation,
    });
  }
}

export function bridgeFailureFromEnvelope(envelope: SnapshotBridgeEnvelope): never {
  const kind = envelope.error_kind;
  const code = typeof envelope.error_code === 'string' ? envelope.error_code : 'guest-error';
  const message = typeof envelope.error === 'string' ? envelope.error : undefined;
  const details = message ? { guestMessage: message.slice(0, 1024) } : {};
  if (kind === 'unsupported') throw snapshotSourceError('unsupported', code, details);
  if (kind === 'malformed_tree') throw snapshotSourceError('malformed-tree', code, details);
  if (kind === 'application_not_responding') {
    throw snapshotSourceError('timeout', code, details);
  }
  if (kind === 'application_unavailable') {
    throw snapshotSourceError('transport-failure', code, details);
  }
  if (kind === 'bad_request') throw snapshotSourceError('malformed-tree', code, details);
  if (kind === 'response_limit_exceeded') {
    throw snapshotSourceError('transport-failure', code, details);
  }
  throw snapshotSourceError('transport-failure', code, details);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
