import type { CliFlags } from '@agent-device/contracts/command';
import { requireLeaseDeviceSpec } from '@agent-device/contracts/lease-scope';
import { optionField } from '../command-input.ts';

/**
 * The device spec a proxy lease is allocated by, on the commands that allocate one. The fields
 * reach the daemon request; a daemon refuses them, and the CLI drops them once a proxy backend has
 * leased a device by them.
 */
export const leaseDeviceSpecFields = {
  osVersion: optionField('osVersion'),
  imageTag: optionField('imageTag'),
  physical: optionField('physical'),
};

/** The spec keys the flags name, as `readLeaseDeviceSpec` decides them. */
export function leaseDeviceSpecInputFromFlags(
  flags: CliFlags,
): Pick<CliFlags, 'osVersion' | 'imageTag' | 'physical'> {
  return requireLeaseDeviceSpec(flags).spec;
}
