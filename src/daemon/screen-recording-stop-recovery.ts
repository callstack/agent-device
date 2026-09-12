import fs from 'node:fs';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { ScreenRecordingCompletion } from '@agent-device/contracts/screen-recording-runtime';
import { deviceIdentity, sameDeviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { DurableCaptureResourceRecord } from '@agent-device/capture-kit/durable-capture';
import { screenRecordingDurableResource } from './screen-recording-session-resource.ts';
import { decodeScreenRecordingCompletionMetadata } from './screen-recording-completion-metadata.ts';
import type { SessionStore } from './session-store.ts';

/**
 * What a `record stop` owes a session, decided from the durable recording manifest alone.
 *
 * A caller that stopped waiting while the daemon was still exporting leaves a `completed` manifest
 * behind: the export exists on the daemon host, but its response never reached the caller. Serving
 * that export from the manifest is what makes a retried `record stop` a supported recovery instead
 * of a dead end. A completed manifest with no decodable completion or no surviving file serves
 * nothing, so a caller is never handed a path it cannot download.
 */
export type ScreenRecordingStopRecovery =
  | Readonly<{ kind: 'completed'; completion: ScreenRecordingCompletion }>
  | Readonly<{ kind: 'open'; resourcePath: string }>
  | Readonly<{ kind: 'none' }>;

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
  const decoded = decodeScreenRecordingCompletionMetadata(record.envelope.metadata);
  if (decoded.status === 'invalid') {
    emitDiagnostic({
      level: 'warn',
      phase: 'screen_recording_completed_manifest_unreplayable',
      data: { resourcePath, reason: decoded.reason },
    });
    return { kind: 'none' };
  }
  const completion = decoded.completion;
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
