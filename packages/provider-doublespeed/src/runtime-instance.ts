import { scryptSync } from 'node:crypto';
import { DOUBLESPEED_DEFAULT_API_URL } from './api-client.ts';

const RUNTIME_INSTANCE_KEY_LENGTH = 32;
const RUNTIME_INSTANCE_SCRYPT_COST = 16_384;
const RUNTIME_INSTANCE_SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const RUNTIME_INSTANCE_SALT = 'agent-device:doublespeed-runtime-owner:v1';

export function resolveDoublespeedRuntimeInstance(options: {
  apiKey: string;
  apiUrl?: string;
  runtimeInstance?: string;
}): string {
  if (options.runtimeInstance !== undefined) {
    const explicit = options.runtimeInstance.trim();
    if (!explicit) throw new TypeError('Doublespeed runtimeInstance must be a non-empty string');
    return explicit;
  }
  const principal = JSON.stringify({
    provider: 'doublespeed',
    apiUrl: normalizeApiUrl(options.apiUrl),
    apiKey: options.apiKey,
  });
  const fingerprint = scryptSync(principal, RUNTIME_INSTANCE_SALT, RUNTIME_INSTANCE_KEY_LENGTH, {
    N: RUNTIME_INSTANCE_SCRYPT_COST,
    r: 8,
    p: 1,
    maxmem: RUNTIME_INSTANCE_SCRYPT_MAX_MEMORY,
  });
  return `principal-${fingerprint.toString('hex')}`;
}

function normalizeApiUrl(apiUrl: string | undefined): string {
  return (apiUrl?.trim() || DOUBLESPEED_DEFAULT_API_URL).replace(/\/+$/, '').toLowerCase();
}
