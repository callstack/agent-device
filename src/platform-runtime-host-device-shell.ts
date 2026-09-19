import type { HostCommandRequest } from '@agent-device/contracts/platform-runtime-host';
import { assertDeviceShellArgv, deviceShellExecutableOf } from '@agent-device/kernel/device-shell';

/**
 * The argv for one host command, refused when the executable is a device-shell tool and the command is
 * not one the funnel built. The array is the request's own: a host command's argv is read by every
 * transport it passes through, and the copy the port used to make was itself a refusal downstream,
 * because a dispatch guard can only recognize the array the funnel built.
 */
export function guardedHostCommandArgv(request: HostCommandRequest): readonly string[] {
  const executable = deviceShellExecutableOf(request.executable);
  if (executable) assertDeviceShellArgv(request.args, executable);
  return request.args;
}
