const AGENT_DEVICE_CLIENT_HEADER = 'agent-device-cli';

export function agentDeviceRequestHeaders(clientVersion: string): Record<string, string> {
  return {
    'x-agent-device-client': AGENT_DEVICE_CLIENT_HEADER,
    'x-agent-device-version': clientVersion,
  };
}
