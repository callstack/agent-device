import path from 'node:path';
import type { JsonObject, JsonValue } from '@agent-device/contracts/client';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';

type NativeChunk = {
  index: number;
  remotePath: string;
  remotePid: string;
  remoteStartTime: string;
};

export type AndroidRecordingManifestFixture = {
  version: 1;
  resourceKind: 'screen-recording';
  fenceToken: string;
  fenceGeneration: number;
  sessionId: string;
  deviceId: string;
  startedAt: number;
  outputPath: string;
  scope: 'device';
  showTouches: boolean;
  recordOnlySession: boolean;
  exportQuality?: 'medium' | 'high';
  transportMode: 'transport-composed';
  chunks: NativeChunk[];
  pendingRemotePath?: string;
  completion?: JsonObject;
};

export function buildAndroidRecordingManifest(options: {
  outPath: string;
  remotePath: string;
  sessionName: string;
  startedAt?: number;
  chunks?: Array<{
    index: number;
    remotePath: string;
    remotePid?: string;
    remoteStartTime?: string;
  }>;
  pendingRemotePath?: string;
  completion?: JsonObject;
}): AndroidRecordingManifestFixture {
  const chunks = options.chunks ?? [{ index: 1, remotePath: options.remotePath }];
  return {
    version: 1,
    resourceKind: 'screen-recording',
    fenceToken: 'provider-fixture-fence',
    fenceGeneration: 1,
    sessionId: options.sessionName,
    deviceId: PROVIDER_SCENARIO_ANDROID.id,
    startedAt: options.startedAt ?? 123456789,
    outputPath: options.outPath,
    scope: 'device',
    showTouches: true,
    recordOnlySession: false,
    exportQuality: 'medium',
    transportMode: 'transport-composed',
    chunks: chunks.map(toNativeChunk),
    ...(options.pendingRemotePath === undefined
      ? {}
      : { pendingRemotePath: options.pendingRemotePath }),
    ...(options.completion === undefined ? {} : { completion: options.completion }),
  };
}

export function manifestPath(manifest: AndroidRecordingManifestFixture): string {
  const remotePath = manifest.chunks.at(-1)?.remotePath ?? manifest.pendingRemotePath;
  if (!remotePath) throw new Error('Android recording fixture needs a native remote path');
  return `${path.posix.dirname(remotePath)}/agent-device-recording-active.json`;
}

export function parseManifestWrite(
  command: string,
): { path: string; manifest: AndroidRecordingManifestFixture } | undefined {
  const match = /^printf %s '(.+)' > '(.+)\.tmp' && mv -f '.+\.tmp' '(.+)'$/.exec(command);
  const [, serializedManifest, temporaryPath, manifestPath] = match ?? [];
  if (!serializedManifest || !temporaryPath || !manifestPath || temporaryPath !== manifestPath)
    return undefined;
  try {
    const parsed: unknown = JSON.parse(serializedManifest.replaceAll(String.raw`'\''`, "'"));
    return isAndroidRecordingManifestFixture(parsed)
      ? { path: manifestPath, manifest: parsed }
      : undefined;
  } catch {
    return undefined;
  }
}

function toNativeChunk(chunk: {
  index: number;
  remotePath: string;
  remotePid?: string;
  remoteStartTime?: string;
}): NativeChunk {
  return {
    index: chunk.index,
    remotePath: chunk.remotePath,
    remotePid: chunk.remotePid ?? String(4320 + chunk.index),
    remoteStartTime: chunk.remoteStartTime ?? String(100 + chunk.index),
  };
}

function isAndroidRecordingManifestFixture(
  value: unknown,
): value is AndroidRecordingManifestFixture {
  return isJsonObject(value) && hasManifestIdentity(value) && hasCaptureSettings(value);
}

function hasManifestIdentity(value: JsonObject): boolean {
  return (
    value.version === 1 &&
    value.resourceKind === 'screen-recording' &&
    isStringProperty(value, 'fenceToken') &&
    isNumberProperty(value, 'fenceGeneration') &&
    isStringProperty(value, 'sessionId') &&
    isStringProperty(value, 'deviceId') &&
    isNumberProperty(value, 'startedAt') &&
    isStringProperty(value, 'outputPath')
  );
}

function hasCaptureSettings(value: JsonObject): boolean {
  return (
    value.scope === 'device' &&
    isBooleanProperty(value, 'showTouches') &&
    isBooleanProperty(value, 'recordOnlySession') &&
    isOptionalExportQuality(value.exportQuality) &&
    value.transportMode === 'transport-composed' &&
    hasChunkList(value.chunks) &&
    hasOptionalString(value, 'pendingRemotePath') &&
    hasOptionalJsonObject(value, 'completion')
  );
}

function hasChunkList(value: JsonValue | undefined): boolean {
  return Array.isArray(value) && value.every(isNativeChunk);
}

function isNativeChunk(value: unknown): value is NativeChunk {
  return (
    isJsonObject(value) &&
    isNumberProperty(value, 'index') &&
    isStringProperty(value, 'remotePath') &&
    isStringProperty(value, 'remotePid') &&
    isStringProperty(value, 'remoteStartTime')
  );
}

function hasOptionalString(value: JsonObject, key: string): boolean {
  const candidate = value[key];
  return candidate === undefined || typeof candidate === 'string';
}

function hasOptionalJsonObject(value: JsonObject, key: string): boolean {
  const candidate = value[key];
  return candidate === undefined || isJsonObject(candidate);
}

function isStringProperty(value: JsonObject, key: string): boolean {
  return typeof value[key] === 'string';
}

function isNumberProperty(value: JsonObject, key: string): boolean {
  return typeof value[key] === 'number';
}

function isBooleanProperty(value: JsonObject, key: string): boolean {
  return typeof value[key] === 'boolean';
}

function isExportQuality(value: JsonValue | undefined): boolean {
  return value === 'medium' || value === 'high';
}

function isOptionalExportQuality(value: JsonValue | undefined): boolean {
  return value === undefined || isExportQuality(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && isJsonRecord(value)
  );
}

function isJsonRecord(value: object): boolean {
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return true;
  return Array.isArray(value) ? value.every(isJsonValue) : isJsonObject(value);
}
