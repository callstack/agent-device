import { createHash } from 'node:crypto';
import { REVYL_DEFAULT_BACKEND_URL } from './revyl-client.ts';

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
  return `principal-${createHash('sha256').update(principal).digest('hex').slice(0, 32)}`;
}
