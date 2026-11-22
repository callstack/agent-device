import type { ProviderAgentDevicePlugin } from 'agent-device/plugins';
import { limrunPlugin } from './plugin.ts';

/**
 * Limrun as a plugin: Android instances and iOS simulators rented from the Limrun API. Credentials
 * come from `LIMRUN_API_KEY`, or from the `LIM_*_INSTANCE_*` variables of an existing instance.
 */
function limrun(): ProviderAgentDevicePlugin {
  return limrunPlugin();
}

export { limrun as default };
