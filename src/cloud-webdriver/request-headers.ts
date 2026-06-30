import { readVersion } from '../utils/version.ts';

const AGENT_DEVICE_CLIENT_HEADER = 'agent-device-cli';

export function agentDeviceRequestHeaders(): Record<string, string> {
  return {
    'x-agent-device-client': AGENT_DEVICE_CLIENT_HEADER,
    'x-agent-device-version': readVersion(),
  };
}
