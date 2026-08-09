import crypto from 'node:crypto';
import path from 'node:path';
import type {
  DurableResourceEnvelope,
  ResourceOwnershipFence,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { listAppLogResourcePaths, readAppLogResourceRecord } from './app-log-resource-store.ts';

const undurableCleanupBlocks = new Map<string, string>();
const retainedLegacyAppLogMarkers = new Set<string>();

export function replaceRetainedLegacyAppLogMarkers(markerPaths: readonly string[]): void {
  retainedLegacyAppLogMarkers.clear();
  for (const markerPath of markerPaths) retainedLegacyAppLogMarkers.add(markerPath);
}

export function blockUndurableAppLogCleanup(device: DeviceInfo, reason: string): void {
  undurableCleanupBlocks.set(durableDeviceKeyFromSelected(device), reason);
}

export function clearUndurableAppLogCleanup(device: DeviceInfo): void {
  undurableCleanupBlocks.delete(durableDeviceKeyFromSelected(device));
}

export function createNextAppLogFence(params: {
  resourcePath: string;
  device: DeviceInfo;
}): ResourceOwnershipFence {
  const { resourcePath, device } = params;
  assertNoRetainedLegacyMarker();
  const selectedDeviceKey = durableDeviceKeyFromSelected(device);
  assertNoUndurableCleanup(selectedDeviceKey);
  assertNoConflictingManifest(resourcePath, selectedDeviceKey);

  const record = readAppLogResourceRecord(resourcePath);
  return Object.freeze({
    token: crypto.randomUUID(),
    generation: record.status === 'decoded' ? record.envelope.fence.generation + 1 : 1,
  });
}

function assertNoRetainedLegacyMarker(): void {
  if (retainedLegacyAppLogMarkers.size === 0) return;
  throw new AppError(
    'COMMAND_FAILED',
    'A retained legacy app-log marker prevents replacement capture',
    {
      reason: 'cleanup-unconfirmed',
      hint: 'Inspect and remove the retained app-log.pid only after manually confirming its process is gone.',
    },
  );
}

function assertNoUndurableCleanup(selectedDeviceKey: string): void {
  const reason = undurableCleanupBlocks.get(selectedDeviceKey);
  if (!reason) return;
  throw new AppError(
    'COMMAND_FAILED',
    'The existing app-log resource has process-local unconfirmed ownership',
    {
      reason: 'cleanup-unconfirmed',
      hint: `Do not start a replacement in this daemon process: ${reason}`,
    },
  );
}

function assertNoConflictingManifest(resourcePath: string, selectedDeviceKey: string): void {
  const sessionsDir = path.dirname(path.dirname(resourcePath));
  for (const existingPath of listAppLogResourcePaths(sessionsDir)) {
    const existing = readAppLogResourceRecord(existingPath);
    if (existing.status === 'unreattachable') throw unreattachableManifest(existing);
    if (
      existing.status === 'decoded' &&
      existing.envelope.lifecycle !== 'completed' &&
      (existingPath === resourcePath ||
        durableDeviceKey(existing.envelope.device) === selectedDeviceKey)
    ) {
      throw new AppError(
        'COMMAND_FAILED',
        'An app-log resource for this device has not reached a confirmed terminal state',
        {
          reason: 'cleanup-unconfirmed',
          hint: 'Retry exact-owner cleanup using the existing app-log.resource.json before starting a replacement.',
        },
      );
    }
  }
}

function unreattachableManifest(
  record: Extract<ReturnType<typeof readAppLogResourceRecord>, { status: 'unreattachable' }>,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `An app-log recovery record is unreattachable: ${record.message}`,
    {
      reason: record.reason,
      retriable: false,
      hint: 'Retain the corrupt or future-version app-log.resource.json for manual recovery; no replacement capture is safe.',
    },
  );
}

function durableDeviceKeyFromSelected(device: DeviceInfo): string {
  return JSON.stringify([
    device.platform,
    device.appleOs ?? null,
    device.id,
    device.kind,
    device.target ?? null,
    device.iosPhysicalDeviceBackend ?? null,
  ]);
}

function durableDeviceKey(device: DurableResourceEnvelope<'app-log'>['device']): string {
  return JSON.stringify([
    device.family,
    device.appleOs ?? null,
    device.id,
    device.kind,
    device.target ?? null,
    device.iosPhysicalDeviceBackend ?? null,
  ]);
}
