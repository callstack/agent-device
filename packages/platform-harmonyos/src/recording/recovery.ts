import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import type { DurableDescriptorCodec } from '@agent-device/contracts/durable-resource-envelope';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import {
  type ScreenRecordingStartInput,
  SCREEN_RECORDING_RESOURCE_KIND,
} from '@agent-device/contracts/screen-recording-runtime';
import { createDurableResourceEnvelope, encodeDurableDescriptor } from '@agent-device/capture-kit';

export type HarmonyRecordingDescriptor = Readonly<{
  backend: 'harmony-screen-recorder';
  fileName: string;
  remotePath: string;
}>;

type HarmonyDescriptorCodec = DurableDescriptorCodec<
  HarmonyRecordingDescriptor,
  typeof SCREEN_RECORDING_RESOURCE_KIND
>;

const descriptorCodec: HarmonyDescriptorCodec = Object.freeze({
  resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
  version: 1,
  encode: (descriptor) => ({ ...descriptor }),
  decode: (body) =>
    body.backend === 'harmony-screen-recorder' &&
    typeof body.fileName === 'string' &&
    isCanonicalHarmonyRecordingFileName(body.fileName) &&
    body.remotePath === `/data/local/tmp/${body.fileName}`
      ? ({
          status: 'decoded',
          descriptor: Object.freeze({
            backend: 'harmony-screen-recorder',
            fileName: body.fileName,
            remotePath: body.remotePath,
          }),
        } as const)
      : ({ status: 'invalid', message: 'Invalid HarmonyOS screen-recording descriptor' } as const),
});

export function createHarmonyRecordingEnvelope(params: {
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  descriptor: HarmonyRecordingDescriptor;
}) {
  const { device, owner, input, descriptor } = params;
  return createDurableResourceEnvelope({
    resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
    sessionId: input.sessionId,
    device: deviceIdentity(device),
    owner,
    fence: input.fence,
    lifecycle: 'open',
    descriptor: encodeDurableDescriptor(descriptorCodec, descriptor),
  });
}

export function cleanupRecoveredHarmonyRecording(
  body: Parameters<HarmonyDescriptorCodec['decode']>[0],
): CleanupOutcome {
  const decoded = descriptorCodec.decode(body);
  return decoded.status === 'decoded'
    ? {
        status: 'cleanup-pending',
        reason: 'manual-recovery-required',
        message:
          'HarmonyOS recorder ownership cannot be proven after daemon restart; no recorder was stopped.',
      }
    : { status: 'cleanup-pending', reason: 'manual-recovery-required' };
}

function isCanonicalHarmonyRecordingFileName(value: string): boolean {
  return /^agent-device-recording-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.mp4$/i.test(
    value,
  );
}
