import path from 'node:path';
import type { HostCommandRequest } from '@agent-device/contracts/platform-runtime-host';
import { assertDeviceShellArgv } from '@agent-device/kernel/device-shell';

const DEVICE_SHELL_EXECUTABLES = new Set(['adb', 'hdc']);

/** The generic host command port is an adb/hdc boundary too; hold it to the device-shell guard. */
export function assertHostDeviceShellRequest(request: HostCommandRequest): void {
  const executable = path.basename(request.executable).replace(/\.(?:com|exe|bat|cmd)$/i, '');
  if (!DEVICE_SHELL_EXECUTABLES.has(executable)) return;
  assertDeviceShellArgv(request.args, executable);
}
