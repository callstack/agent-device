import crypto from 'node:crypto';
import path from 'node:path';
import type { LiveResourceHandle } from '@agent-device/contracts/durable-resource';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity, deviceIdentityKey, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { DurableCaptureAdmissionLedger } from './durable-capture-admission-ledger.ts';
import type { DurableCaptureResourceDefinition } from './durable-capture-resource.ts';
import { capitalizeDurableCaptureLabel } from './durable-capture-resource-labels.ts';

export function createNextDurableCaptureFence<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  params: {
    admissionLedger: DurableCaptureAdmissionLedger;
    resourcePath: string;
    device: DeviceInfo;
  },
): ResourceOwnershipFence {
  params.admissionLedger.assertStartAllowed(params.device);
  assertNoConflictingManifest(definition, params.resourcePath, params.device);
  const current = definition.store.read(params.resourcePath);
  return Object.freeze({
    token: crypto.randomUUID(),
    generation: current.status === 'decoded' ? current.envelope.fence.generation + 1 : 1,
  });
}

function assertNoConflictingManifest<K extends string, H extends LiveResourceHandle<C>, C>(
  definition: DurableCaptureResourceDefinition<K, H, C>,
  resourcePath: string,
  device: DeviceInfo,
): void {
  const selectedDeviceKey = deviceIdentityKey(deviceIdentity(device));
  for (const existingPath of definition.store.list(path.dirname(path.dirname(resourcePath)))) {
    const existing = definition.store.read(existingPath);
    if (existing.status === 'unreattachable') {
      throw new AppError(
        'COMMAND_FAILED',
        `${capitalizeDurableCaptureLabel(articleFor(definition.displayName))} ${definition.displayName} recovery record is unreattachable: ${existing.message}`,
        {
          reason: existing.reason,
          retriable: false,
          hint: `Retain the corrupt or future-version ${definition.displayName} manifest for manual recovery; no replacement capture is safe.`,
        },
      );
    }
    if (
      existing.status === 'decoded' &&
      existing.envelope.lifecycle !== 'completed' &&
      (existingPath === resourcePath ||
        deviceIdentityKey(existing.envelope.device) === selectedDeviceKey)
    ) {
      throw new AppError(
        'COMMAND_FAILED',
        `${capitalizeDurableCaptureLabel(articleFor(definition.displayName))} ${definition.displayName} resource for this device has not reached a confirmed terminal state`,
        {
          reason: 'cleanup-unconfirmed',
          hint: `Retry exact-owner cleanup using the existing ${definition.displayName} manifest before starting a replacement.`,
        },
      );
    }
  }
}

function articleFor(value: string): 'a' | 'an' {
  return /^[aeiou]/i.test(value) ? 'an' : 'a';
}
