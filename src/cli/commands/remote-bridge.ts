import type { CliFlags } from '../../commands/cli-grammar/flag-types.ts';

export function isRemoteBridgeBackend(leaseBackend: CliFlags['leaseBackend']): boolean {
  return leaseBackend === 'android-instance' || leaseBackend === 'ios-instance';
}
