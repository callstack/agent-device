import { appLogDurableResource } from '@agent-device/capture-kit/app-log-durable-resource';
import type { ResourceOwnershipFence } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppLogAdmissionLedger } from './app-log-admission-ledger.ts';

export function createNextAppLogFence(params: {
  ledger: AppLogAdmissionLedger;
  resourcePath: string;
  device: DeviceInfo;
}): ResourceOwnershipFence {
  return appLogDurableResource.createNextFence({
    admissionLedger: params.ledger,
    resourcePath: params.resourcePath,
    device: params.device,
  });
}
