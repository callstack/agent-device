import type { EnvMap } from '@agent-device/kernel/source-value';
import { readMacOsAppBackend, type MacOsAppBackend } from '@agent-device/contracts/session';

/** The app-session backend the host selected through `AGENT_DEVICE_MACOS_APP_BACKEND`. */
export function hostMacOsAppBackend(env: Readonly<EnvMap>): MacOsAppBackend {
  return readMacOsAppBackend((name) => env[name]);
}
