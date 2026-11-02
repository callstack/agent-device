import { providerRuntimeInstance } from '@agent-device/contracts/platform-runtime';
import { REVYL_PROVIDER } from './device.ts';
import { REVYL_DEFAULT_BACKEND_URL, resolveRevylBackendUrl } from './revyl-client.ts';

/**
 * The stable identity of one Revyl runtime, and so of one owner. Two runtimes that rent devices for
 * the same account against the same origin share it; two accounts never do.
 */
export function resolveRevylRuntimeInstance(
  options: Readonly<{
    apiKey: string;
    backendUrl?: string;
  }>,
): string {
  return providerRuntimeInstance(REVYL_PROVIDER, [
    // The origin the client actually calls: `https://backend.revyl.ai/` and
    // `https://backend.revyl.ai` are one account, and must not become two owner identities.
    ['backendUrl', resolveRevylBackendUrl(options.backendUrl ?? REVYL_DEFAULT_BACKEND_URL)],
    ['apiKey', options.apiKey],
  ]);
}
