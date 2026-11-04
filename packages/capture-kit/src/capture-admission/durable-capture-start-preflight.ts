import crypto from 'node:crypto';
import path from 'node:path';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity, deviceIdentityKey, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  capitalizeDurableCaptureLabel,
  type DurableCaptureRecordDefinition,
} from '../durable-capture/index.ts';
import type { DurableCaptureAdmissionLedger } from './durable-capture-admission-ledger.ts';

export function createNextDurableCaptureFence<K extends string, C>(
  definition: DurableCaptureRecordDefinition<K, C>,
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

/** The open records that refuse a start, and the sessions directory they were listed from. */
export type DurableCaptureStartConflicts<K extends string> = Readonly<{
  sessionsDir: string;
  records: readonly Readonly<{ resourcePath: string; envelope: DurableResourceEnvelope<K> }>[];
}>;

/**
 * The records a start at `resourcePath` on `device` must wait for: every non-completed record
 * at that path or on that device. The start refusal and the start-time settle both read this
 * list, so what a start settles is exactly what it would refuse on. An unreattachable record
 * throws, because no replacement capture is safe beside it.
 */
export function listDurableCaptureStartConflicts<K extends string, C>(
  definition: DurableCaptureRecordDefinition<K, C>,
  resourcePath: string,
  device: DeviceInfo,
): DurableCaptureStartConflicts<K> {
  const selectedDeviceKey = deviceIdentityKey(deviceIdentity(device));
  const sessionsDir = path.dirname(path.dirname(resourcePath));
  const records: { resourcePath: string; envelope: DurableResourceEnvelope<K> }[] = [];
  for (const existingPath of definition.store.list(sessionsDir)) {
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
      records.push({ resourcePath: existingPath, envelope: existing.envelope });
    }
  }
  return { sessionsDir, records };
}

function assertNoConflictingManifest<K extends string, C>(
  definition: DurableCaptureRecordDefinition<K, C>,
  resourcePath: string,
  device: DeviceInfo,
): void {
  const [conflict] = listDurableCaptureStartConflicts(definition, resourcePath, device).records;
  if (!conflict) return;
  const session = conflict.envelope.sessionId;
  throw new AppError(
    'COMMAND_FAILED',
    `${capitalizeDurableCaptureLabel(articleFor(definition.displayName))} ${definition.displayName} resource for this device has not reached a confirmed terminal state`,
    {
      reason: 'cleanup-unconfirmed',
      session,
      hint: `The open ${definition.displayName} record belongs to session "${session}". Stop or close that session, or retry once its device is reachable; exact-owner cleanup must confirm it before a replacement starts.`,
    },
  );
}

function articleFor(value: string): 'a' | 'an' {
  return /^[aeiou]/i.test(value) ? 'an' : 'a';
}
