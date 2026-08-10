import type { ResourceOwnershipFence } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppLogAdmissionLedger } from './app-log-admission-ledger.ts';
import { appLogDurableResource } from './app-log-session-resource.ts';

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
