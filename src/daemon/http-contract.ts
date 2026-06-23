export const DAEMON_HTTP_BASE_PATH = '/agent-device';

export function buildDaemonHttpBaseUrl(baseUrl: string): string {
  return buildDaemonHttpUrl(baseUrl, DAEMON_HTTP_BASE_PATH);
}

export function buildDaemonHttpUrl(baseUrl: string, route: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(route.replace(/^\/+/, ''), normalizedBase).toString();
}

export function buildDaemonHttpAuthHeaders(token: string | undefined): Record<string, string> {
  const normalizedToken = token?.trim();
  if (!normalizedToken) return {};
  return {
    authorization: `Bearer ${normalizedToken}`,
    'x-agent-device-token': normalizedToken,
  };
}
