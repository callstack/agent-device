import { commandHostEnvironment } from '@agent-device/host-kit/command';
import { readMacOsAppBackend, type MacOsAppBackend } from '@agent-device/contracts/session';

/** The app-session backend the host selected through `AGENT_DEVICE_MACOS_APP_BACKEND`. */
export function hostMacOsAppBackend(): MacOsAppBackend {
  return readMacOsAppBackend((name) => commandHostEnvironment().env[name]);
}
