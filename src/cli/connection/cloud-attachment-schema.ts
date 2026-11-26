import { parseCloudEndpoint } from '../cloud-origin.ts';
import { asCloudRecord, isCloudText } from '../cloud-response.ts';

export type CloudAttachment = {
  kind: 'agent-device-daemon';
  daemonBaseUrl: string;
  daemonAuthToken: string;
};

export function parseCloudAttachment(value: unknown): CloudAttachment | undefined {
  const entry = asCloudRecord(value);
  return entry?.kind === 'agent-device-daemon' ? parseDaemonAttachment(entry) : undefined;
}

export function parseDaemonAttachment(entry: Record<string, unknown> | undefined) {
  const { daemonBaseUrl, daemonAuthToken } = entry ?? {};
  if (isCredentialEndpoint(daemonBaseUrl) && isCloudText(daemonAuthToken)) {
    return { kind: 'agent-device-daemon' as const, daemonBaseUrl, daemonAuthToken };
  }
  return undefined;
}

export function isCredentialEndpoint(value: unknown): value is string {
  return typeof value === 'string' && !!parseCloudEndpoint(value, 'https:', 'http:');
}
