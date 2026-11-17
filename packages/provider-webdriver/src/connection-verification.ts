/**
 * The read-only provider checks `connect` runs before it saves a profile. Published as one subpath
 * so a host can substitute every bundled verifier together, the way a plugin's own
 * `connection-verification` subpath is substituted.
 */
export { verifyAwsDeviceFarmConnection } from './aws-device-farm-connection-verification.ts';
