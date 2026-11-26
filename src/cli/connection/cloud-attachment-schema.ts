import { parseCloudEndpoint } from '../cloud-origin.ts';
import { asCloudRecord, isCloudText } from '../cloud-response.ts';

export type CloudAttachment =
  | { kind: 'agent-device-daemon'; daemonBaseUrl: string; daemonAuthToken: string }
  | { kind: 'limrun'; platform: 'ios'; apiUrl: string; token: string }
  | { kind: 'limrun'; platform: 'android'; apiUrl: string; token: string; adbWebSocketUrl: string };

export function parseCloudAttachment(
  value: unknown,
  transport?: unknown,
): CloudAttachment | undefined {
  const entry = asCloudRecord(value);
  const kind = transport ?? entry?.kind;
  if (kind === 'agent-device-daemon') return parseDaemonAttachment(entry);
  if (kind !== 'limrun' || !entry) return;
  const { apiUrl, platform, adbWebSocketUrl } = entry;
  const token = readScopedToken(entry, true);
  if (!isCredentialEndpoint(apiUrl) || !token) return;
  if (platform === 'ios') return { kind, apiUrl, token, platform };
  if (
    platform === 'android' &&
    typeof adbWebSocketUrl === 'string' &&
    matchesAdbAudience(apiUrl, adbWebSocketUrl)
  )
    return { kind, apiUrl, token, platform, adbWebSocketUrl };
}

function matchesAdbAudience(apiUrl: string, adbWebSocketUrl: string): boolean {
  const adb = parseCloudEndpoint(adbWebSocketUrl, 'wss:', 'ws:');
  if (!adb) return false;
  adb.protocol = adb.protocol === 'wss:' ? 'https:' : 'http:';
  return adb.origin === new URL(apiUrl).origin;
}

function parseDaemonAttachment(entry: Record<string, unknown> | undefined) {
  const { daemonBaseUrl } = entry ?? {};
  const daemonAuthToken = readScopedToken(entry, false);
  if (isCredentialEndpoint(daemonBaseUrl) && daemonAuthToken) {
    return { kind: 'agent-device-daemon' as const, daemonBaseUrl, daemonAuthToken };
  }
  return undefined;
}

export function readScopedToken(value: unknown, limrun: boolean): string | undefined {
  const attachment = asCloudRecord(value);
  const token = limrun ? attachment?.token : attachment?.daemonAuthToken;
  return isCloudText(token) ? token.trim() : undefined;
}

export function isCredentialEndpoint(value: unknown): value is string {
  return typeof value === 'string' && !!parseCloudEndpoint(value, 'https:', 'http:');
}
