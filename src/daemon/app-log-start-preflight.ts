import crypto from 'node:crypto';
import path from 'node:path';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform';
import { deviceIdentity, deviceIdentityKey, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { AppLogAdmissionLedger } from './app-log-admission-ledger.ts';
import { listAppLogResourcePaths, readAppLogResourceRecord } from './app-log-resource-store.ts';

export function createNextAppLogFence(params: {
  ledger: AppLogAdmissionLedger;
  resourcePath: string;
  device: DeviceInfo;
}): ResourceOwnershipFence {
  const { ledger, resourcePath, device } = params;
  ledger.assertStartAllowed(device);
  const selectedDeviceKey = deviceIdentityKey(deviceIdentity(device));
  assertNoConflictingManifest(resourcePath, selectedDeviceKey);

  const record = readAppLogResourceRecord(resourcePath);
  return Object.freeze({
    token: crypto.randomUUID(),
    generation: record.status === 'decoded' ? record.envelope.fence.generation + 1 : 1,
  });
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
        deviceIdentityKey(existing.envelope.device) === selectedDeviceKey)
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
