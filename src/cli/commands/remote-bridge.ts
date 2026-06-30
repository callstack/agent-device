import type { CliFlags } from '../parser/cli-flags.ts';

export function isRemoteBridgeBackend(leaseBackend: CliFlags['leaseBackend']): boolean {
  return leaseBackend === 'android-instance' || leaseBackend === 'ios-instance';
}
