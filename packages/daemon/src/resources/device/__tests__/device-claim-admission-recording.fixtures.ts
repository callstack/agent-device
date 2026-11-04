import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { deviceIdentity } from '@agent-device/kernel/device';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { canonicalLocalDeviceKey } from '@agent-device/daemon-contracts/device-claims';

export function seed(
  stateDir: string,
  claimsDir: string,
  session: string,
  device: DeviceInfo,
  native: string,
  envelope?: DurableResourceEnvelope<'screen-recording'>,
) {
  const key = canonicalLocalDeviceKey(deviceIdentity(device));
  const claim = {
    schemaVersion: 3,
    deviceKey: key,
    device: { ...deviceIdentity(device), name: device.name },
    session,
    workspace: process.cwd(),
    stateDir,
    ownerPid: 999999999,
    ownerStartTime: 'dead',
    ownerToken: 'original-token',
    createdAtMs: 1,
    updatedAtMs: 1,
    claimOwnerKind: 'transient-command',
    transientCommand: 'record',
    recordingFence: envelope?.fence ?? { token: 'recording-fence', generation: 7 },
    recordingRuntimeOwner: localRuntimeOwner(device.platform),
  };
  fs.mkdirSync(claimsDir, { recursive: true });
  const claimPath = path.join(
    claimsDir,
    `${crypto.createHash('sha256').update(key).digest('hex')}.json`,
  );
  fs.writeFileSync(claimPath, JSON.stringify(claim));
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    path.join(stateDir, 'sessions', session),
  );
  screenRecordingDurableResource.store.write(
    resourcePath,
    envelope
      ? {
          ...envelope,
          metadata: {
            ...envelope.metadata,
            deviceClaimToken: 'original-token',
            deviceClaimBindingVersion: 1,
          },
        }
      : createDurableResourceEnvelope({
          resourceKind: 'screen-recording',
          sessionId: session,
          device: deviceIdentity(device),
          owner: localRuntimeOwner(device.platform),
          fence: { token: 'recording-fence', generation: 7 },
          lifecycle: 'open',
          descriptor: { version: 1, body: { outputPath: native } },
          metadata: { deviceClaimToken: 'original-token', deviceClaimBindingVersion: 1 },
        }),
  );
  return { claimPath, resourcePath, claim };
}
