import type { CliFlags } from '@agent-device/contracts/command';

export function isRemoteBridgeBackend(leaseBackend: CliFlags['leaseBackend']): boolean {
  return leaseBackend === 'android-instance' || leaseBackend === 'ios-instance';
}
