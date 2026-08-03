export const LIMRUN_CLIENT_HEADER = 'agent-device-cli';

export function buildLimrunClientOptions(options: { apiKey: string; clientVersion: string }): {
  apiKey: string;
  defaultHeaders: Record<string, string>;
} {
  return {
    apiKey: options.apiKey,
    defaultHeaders: {
      'x-agent-device-client': LIMRUN_CLIENT_HEADER,
      'x-agent-device-version': options.clientVersion,
    },
  };
}
