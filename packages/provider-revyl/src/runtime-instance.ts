import { scryptSync } from 'node:crypto';
import { REVYL_DEFAULT_BACKEND_URL } from './revyl-client.ts';

const RUNTIME_INSTANCE_KEY_LENGTH = 16;
const RUNTIME_INSTANCE_SCRYPT_COST = 16_384;
const RUNTIME_INSTANCE_SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const RUNTIME_INSTANCE_SALT = 'agent-device:revyl-runtime-owner:v1';

/**
 * The stable identity of one Revyl runtime, and so of one owner. Two runtimes that rent devices for
 * the same account against the same origin share it; two accounts never do. The key is hashed rather
 * than carried, because the owner's instance travels into diagnostics.
 */
export function resolveRevylRuntimeInstance(
  options: Readonly<{
    apiKey: string;
    backendUrl?: string;
  }>,
): string {
  const principal = JSON.stringify({
    provider: 'revyl',
    backendUrl: options.backendUrl ?? REVYL_DEFAULT_BACKEND_URL,
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
