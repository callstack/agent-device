import crypto from 'node:crypto';

export function buildConnectClientId(...parts: Array<string | undefined>): string {
  return crypto
    .createHash('sha256')
    .update(parts.map((part) => part ?? '').join('\0'))
    .digest('hex')
    .slice(0, 16);
}
