import fs from 'node:fs';
import type { JsonObject } from '@agent-device/contracts/client';
import type { RecordingAppIdentity, RecordingScope } from '@agent-device/contracts/recording';
import { RECORDING_SCOPE_VALUES } from '@agent-device/contracts/recording';
import type {
  ScreenRecordingChunk,
  ScreenRecordingCompletion,
} from '@agent-device/contracts/screen-recording-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import { deviceIdentity, sameDeviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DurableCaptureResourceRecord } from '@agent-device/capture-kit/durable-capture';
import {
  SCREEN_RECORDING_COMPLETION_METADATA_KEY,
  screenRecordingDurableResource,
} from './screen-recording-session-resource.ts';
import type { SessionStore } from './session-store.ts';

/**
 * What a `record stop` owes a session, decided from the durable recording manifest alone.
 *
 * A caller that stopped waiting while the daemon was still exporting leaves a `completed` manifest
 * behind: the export exists on the daemon host, but its response never reached the caller. Serving
 * that response from the manifest is what makes a retried `record stop` a supported recovery instead
 * of a dead end. Only a response that is whole and whose file survived is served — a caller is never
 * handed a path it cannot download.
 */
export type ScreenRecordingStopRecovery =
  | Readonly<{ kind: 'completed'; completion: ScreenRecordingCompletion }>
  | Readonly<{ kind: 'open'; resourcePath: string }>
  | Readonly<{ kind: 'none' }>;

const OPTIONAL_RESPONSE_FIELDS = [
  'clientOutPath',
  'telemetryPath',
  'warning',
  'overlayWarning',
] as const;

type ScreenRecordingManifestParams = Readonly<{
  sessionName: string;
  sessionStore: SessionStore;
}>;

export function resolveScreenRecordingStopRecovery(
  params: ScreenRecordingManifestParams & Readonly<{ device: DeviceInfo }>,
): ScreenRecordingStopRecovery {
  const { resourcePath, record } = readSessionManifest(params);
  if (record.status !== 'decoded') return { kind: 'none' };
  assertManifestBelongsToRequest(params, record.envelope);
  if (record.envelope.lifecycle !== 'completed') return { kind: 'open', resourcePath };
  const completion = readStoredCompletion(record.envelope.metadata);
  if (completion === undefined) {
    emitDiagnostic({
      level: 'warn',
      phase: 'screen_recording_completed_manifest_unreplayable',
      data: { resourcePath },
    });
    return { kind: 'none' };
  }
  if (!fs.existsSync(completion.outPath)) return { kind: 'none' };
  return { kind: 'completed', completion };
}

/** Whether the session's manifest recorded a terminal recording, even one with no serveable file. */
export function screenRecordingManifestIsTerminal(params: ScreenRecordingManifestParams): boolean {
  const { record } = readSessionManifest(params);
  return record.status === 'decoded' && record.envelope.lifecycle === 'completed';
}

function readSessionManifest(params: ScreenRecordingManifestParams): Readonly<{
  resourcePath: string;
  record: DurableCaptureResourceRecord<'screen-recording'>;
}> {
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    params.sessionStore.resolveSessionDir(params.sessionName),
  );
  return { resourcePath, record: screenRecordingDurableResource.store.read(resourcePath) };
}

function assertManifestBelongsToRequest(
  params: Readonly<{ sessionName: string; device: DeviceInfo }>,
  envelope: DurableResourceEnvelope<'screen-recording'>,
): void {
  if (envelope.sessionId !== params.sessionName) {
    throw new AppError(
      'COMMAND_FAILED',
      'Screen recording recovery record does not belong to the requested session',
      { reason: 'runtime-contract-invalid' },
    );
  }
  if (!sameDeviceIdentity(envelope.device, deviceIdentity(params.device))) {
    throw new AppError(
      'COMMAND_FAILED',
      'Screen recording recovery device does not match the selected device',
      { reason: 'runtime-contract-invalid' },
    );
  }
}

/**
 * The stop response the manifest stored, or nothing when it is not a whole one. The envelope store
 * has already bounded this metadata to frozen plain JSON, so what recovery still has to establish is
 * that the stored response answers correctly: the path it serves, the caller-side paths a remote
 * download is named after, and the duration the response subtracts.
 */
function readStoredCompletion(
  metadata: JsonObject | undefined,
): ScreenRecordingCompletion | undefined {
  const stored = metadata?.[SCREEN_RECORDING_COMPLETION_METADATA_KEY];
  if (!isRecord(stored) || !isServedCompletion(stored) || !isWholeOptionalResponse(stored)) {
    return undefined;
  }
  return stored as unknown as ScreenRecordingCompletion;
}

/** The values a stop response computes on rather than repeats. */
function isServedCompletion(stored: Record<string, unknown>): boolean {
  return (
    isNonEmptyText(stored.outPath) &&
    isNonEmptyText(stored.backend) &&
    isFiniteNumber(stored.startedAt) &&
    isFiniteNumber(stored.completedAt) &&
    isRecordingScope(stored.scope) &&
    typeof stored.showTouches === 'boolean' &&
    typeof stored.recordOnlySession === 'boolean'
  );
}

/** Optional response fields the builder hands to `path.basename` must be whole when present. */
function isWholeOptionalResponse(stored: Record<string, unknown>): boolean {
  return (
    OPTIONAL_RESPONSE_FIELDS.every((field) => isOptionalText(stored[field])) &&
    isOptionalAppIdentity(stored.activeSessionApp) &&
    isOptionalChunks(stored.chunks)
  );
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyText(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecordingScope(value: unknown): value is RecordingScope {
  return RECORDING_SCOPE_VALUES.some((scope) => scope === value);
}

function isAppIdentity(value: unknown): value is RecordingAppIdentity {
  if (!isRecord(value) || !isNonEmptyText(value.bundleId)) return false;
  return isOptionalText(value.name);
}

function isOptionalAppIdentity(value: unknown): value is RecordingAppIdentity | undefined {
  return value === undefined || isAppIdentity(value);
}

function isChunks(value: unknown): value is readonly ScreenRecordingChunk[] {
  return (
    Array.isArray(value) &&
    value.every(
      (chunk) =>
        isRecord(chunk) &&
        Number.isFinite(chunk.index) &&
        isNonEmptyText(chunk.path) &&
        isOptionalText(chunk.clientOutPath),
    )
  );
}

function isOptionalChunks(value: unknown): value is readonly ScreenRecordingChunk[] | undefined {
  return value === undefined || isChunks(value);
}
