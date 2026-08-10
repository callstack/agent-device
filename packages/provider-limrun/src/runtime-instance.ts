import { scryptSync } from 'node:crypto';

const RUNTIME_INSTANCE_KEY_LENGTH = 32;
const RUNTIME_INSTANCE_SCRYPT_COST = 16_384;
const RUNTIME_INSTANCE_SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const RUNTIME_INSTANCE_SALT = 'agent-device:limrun-runtime-owner:v1';

export function resolveLimrunRuntimeInstance(options: {
  apiKey: string;
  region?: string;
  runtimeInstance?: string;
}): string {
  if (options.runtimeInstance !== undefined) {
    const explicit = options.runtimeInstance.trim();
    if (!explicit) throw new TypeError('Limrun runtimeInstance must be a non-empty string');
    return explicit;
  }
  const principal = JSON.stringify({
    provider: 'limrun',
    region: options.region?.trim().toLowerCase() || 'default',
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
