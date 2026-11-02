import { providerRuntimeInstance } from '@agent-device/contracts/platform-runtime';
import type { LimrunInstanceAccess } from './instance-access.ts';

/**
 * The runtime-owner instance for one Limrun account: the explicit identity when the composition
 * names one, otherwise the fingerprint of the facts that decide which devices this runtime rents.
 */
export function resolveLimrunRuntimeInstance(options: {
  apiKey?: string;
  region?: string;
  runtimeInstance?: string;
  instances?: LimrunInstanceAccess;
}): string {
  if (options.runtimeInstance !== undefined) {
    const explicit = options.runtimeInstance.trim();
    if (!explicit) throw new TypeError('Limrun runtimeInstance must be a non-empty string');
    return explicit;
  }
  return providerRuntimeInstance({
    provider: 'limrun',
    region: options.region?.trim().toLowerCase() || 'default',
    apiKey: options.apiKey,
    attachedIos: options.instances?.ios?.apiUrl,
    attachedAndroid: options.instances?.android?.apiUrl,
  });
}
