import type { HostCommandRequest } from '@agent-device/contracts/platform-runtime-host';
import { assertDeviceShellArgv, deviceShellExecutableOf } from '@agent-device/kernel/device-shell';

/** The generic host command port is an adb/hdc boundary too; hold it to the device-shell guard. */
export function assertHostDeviceShellRequest(request: HostCommandRequest): void {
  const executable = deviceShellExecutableOf(request.executable);
  if (executable) assertDeviceShellArgv(request.args, executable);
}
