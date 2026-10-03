import { readMacOsAppBackend, type MacOsAppBackend } from '@agent-device/contracts/session';
import { readHostEnvironmentVariable } from '@agent-device/host-kit/process';

/** The app-session backend the host selected through `AGENT_DEVICE_MACOS_APP_BACKEND`. */
export function hostMacOsAppBackend(): MacOsAppBackend {
  return readMacOsAppBackend(readHostEnvironmentVariable);
}
